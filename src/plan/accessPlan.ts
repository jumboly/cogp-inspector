import type { LevelModel, LodModel } from '../cogp/lod'
import type { Bbox } from '../geo/bbox'
import { coveringPaths, isTopLevel } from '../geo/geoMetadata'
import { intersects, pageBboxesFromCache, pageBboxIndexWants, type PageBboxes, type RowSpan } from '../geo/pageBbox'
import type { Inspection } from '../inspect'
import { coalesce } from '../io/coalesce'
import type { ByteRange, ColumnChunkModel, RowGroupModel } from '../parquet/model'
import type { IndexKind, PageCache } from '../parquet/pages'

/**
 * Access Simulator（Expected = 推定）。地図の表示範囲と縮尺から、リーダーが読むバイト範囲を段階を追って求める。
 * 段階は design.md §1 の `choose level → select row groups → prune row groups → inspect page index →
 * select pages → read byte ranges` に対応し、各段階の中間結果をすべて返す（cogp-js はこれを外に出さない）。
 * decode（データページの展開）は Phase 3 で扱う。
 */

export interface PlanInput {
  /** データの CRS での表示範囲。日付変更線をまたぐときは 2 つに分ける */
  viewport: Bbox[]
  /** 1 CSS ピクセルあたりの CRS 座標単位（design.md D18） */
  targetResolution: number
  /** 読む列（葉の列番号） */
  columns: number[]
}

/**
 * Page Index を読む Row Group 数の上限。COGP なら Level 選択で候補が縮尺に応じて抑えられるが、
 * lod の無いファイルを全体表示すると全 Row Group の Index を読むことになり、URL だと数百回の Range Request になるため。
 */
export const MAX_PAGE_INDEX_ROW_GROUPS = 100

/** funnel の 1 段。bytes は「選んだ列」、bytesAll は「全列を読んだ場合」 */
export interface StageTotals {
  rowGroups: number
  rows: number
  bytes: number
  bytesAll: number
}

export interface LevelChoice {
  /** lod が無い・仕様違反なら false（prefix 選択に使わない：SPEC.md） */
  used: boolean
  level?: LevelModel
  note: string
}

export interface RowGroupPlan {
  rg: number
  /** Row Group の bbox で判定した結果。bbox が無ければ読み飛ばせないので keep（unknown） */
  rgDecision: 'keep' | 'prune' | 'unknown'
  pageBboxes?: PageBboxes
  /** 行範囲ごとに、表示範囲と重なった（＝読む）か */
  spanKept?: boolean[]
  /** 読む行（Row Group 内）。ページ単位で絞れなければ Row Group 全体 */
  keptRows: RowSpan[]
  /**
   * 列ごとの読む範囲。rows は読むデータページが覆う行（Row Group 内、ページ順）で、
   * decode した値を行番号に対応づけるのに使う（ページ単位で読むので keptRows より広い）
   */
  chunkRanges: { col: number; ranges: ByteRange[]; rows: RowSpan[]; pages: number; pagesTotal: number; how: 'pages' | 'whole-chunk' }[]
}

export interface AccessPlan {
  input: PlanInput
  level: LevelChoice
  stages: {
    file: StageTotals
    prefix: StageTotals
    rowGroupPruned: StageTotals & { pruned: number; unknown: number }
    /** requests は新たに読むと決めた Index を合体した範囲（キャッシュ済みの分は含まない）。Expected vs Actual の Page Index 側 */
    pageIndex: { fetched: number; cached: number; bytes: number; rowGroupsWithPageBbox: number; skipped: boolean; requests: ByteRange[] }
    pages: StageTotals & { spans: number; spansKept: number }
    requests: { logical: number; coalesced: number; bytes: number; logicalAll: number; coalescedAll: number }
  }
  rowGroups: RowGroupPlan[]
  /** 合体後の読む範囲（選んだ列） */
  requests: ByteRange[]
}

/** 仕様の例示どおり「resolution >= target を満たす最も細かい Level」。無ければ最も粗い Level（cogp-js src/level.ts と同じ） */
export function chooseLevel(lod: LodModel | undefined, target: number): LevelChoice {
  if (!lod) return { used: false, note: 'geo.lod が無いため、Level で絞らずすべての Row Group が候補' }
  if (!lod.valid) return { used: false, note: 'lod が仕様違反のため、Level による prefix 選択には使わない（SPEC.md）' }
  let chosen = -1
  for (let i = 0; i < lod.levels.length; i++) {
    if (lod.levels[i].resolution >= target) chosen = i
    else break
  }
  const level = lod.levels[chosen === -1 ? 0 : chosen]
  return {
    used: true,
    level,
    note: chosen === -1 ? '表示が最も粗い Level よりさらに粗いので、最も粗い Level を使う' : `resolution ${level.resolution.toPrecision(3)} >= 目標 ${target.toPrecision(3)} を満たす最も細かい Level`,
  }
}

const sumChunks = (rgs: RowGroupModel[], cols?: Set<number>) => rgs.reduce((a, r) => a + r.columns.reduce((b, c) => b + (!cols || cols.has(c.column.index) ? c.compressedSize : 0), 0), 0)

function totals(rgs: RowGroupModel[], cols: Set<number>): StageTotals {
  return { rowGroups: rgs.length, rows: rgs.reduce((a, r) => a + r.numRows, 0), bytes: sumChunks(rgs, cols), bytesAll: sumChunks(rgs) }
}

/** 隣り合う・重なる行範囲をまとめる */
function mergeRows(spans: RowSpan[]): RowSpan[] {
  const out: RowSpan[] = []
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1)
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

const overlapsAny = (start: number, end: number, rows: RowSpan[]) => rows.some((r) => start < r.end && r.start < end)

/**
 * 1 つの Column Chunk で、読む行に掛かるページの範囲を求める。
 * 辞書ページはデータページの値を復元するのに必要なので、データページを 1 つでも読むなら含める。
 * OffsetIndex が無ければページの位置が分からないので Column Chunk 全体を読む。
 */
function chunkRanges(cache: PageCache, chunk: ColumnChunkModel, rows: RowSpan[], numRows: number) {
  const oi = cache.offsetIndex(chunk)
  if (!oi) {
    const all = rows.length ? [{ start: 0, end: numRows }] : []
    return { ranges: rows.length ? [chunk.range] : [], rows: all, pages: rows.length ? 1 : 0, pagesTotal: 1, how: 'whole-chunk' as const }
  }
  const picked = oi.pages.filter((p) => overlapsAny(p.firstRow, p.firstRow + p.rowCount, rows))
  const ranges = picked.map((p) => ({ start: p.offset, end: p.offset + p.compressedSize }))
  const firstData = oi.pages[0]?.offset ?? chunk.range.end
  if (ranges.length && chunk.range.start < firstData) ranges.unshift({ start: chunk.range.start, end: firstData })
  const pageRows = picked.map((p) => ({ start: p.firstRow, end: p.firstRow + p.rowCount }))
  return { ranges, rows: pageRows, pages: picked.length, pagesTotal: oi.pages.length, how: 'pages' as const }
}

const rangeBytes = (rs: ByteRange[]) => rs.reduce((a, r) => a + r.end - r.start, 0)

export async function planAccess(ins: Inspection, cache: PageCache, input: PlanInput): Promise<AccessPlan> {
  const { file, geo, lod, rowGroupBboxes } = ins
  const cols = new Set(input.columns)
  const hits = (b: Bbox) => input.viewport.some((v) => intersects(b, v))

  // 1. choose level → 2. select row groups（prefix）
  const level = chooseLevel(lod, input.targetResolution)
  const prefixEnd = level.used && level.level ? Math.min(level.level.rowGroupEnd, file.rowGroups.length - 1) : file.rowGroups.length - 1
  const prefix = file.rowGroups.slice(0, prefixEnd + 1)

  // 3. prune row groups: Footer の統計値から求めた Row Group の bbox で判定。統計が無ければ捨てない
  const decisions = prefix.map((r) => {
    const b = rowGroupBboxes[r.index].bbox
    return !b ? ('unknown' as const) : hits(b) ? ('keep' as const) : ('prune' as const)
  })
  const kept = prefix.filter((_, i) => decisions[i] !== 'prune')

  // 4. inspect page index: 残った Row Group についてだけ Index を読む（design.md D15）。
  //    Page bbox 用の covering 列の Index に加え、読む範囲を求めるため全列の OffsetIndex を読む
  //    （全列を読んだ場合との比較 D21 のため。parquet-rs では 1 Row Group 分が隣接し 1 回の read になる）
  const skipped = kept.length > MAX_PAGE_INDEX_ROW_GROUPS
  const wants: { chunk: ColumnChunkModel; kind: IndexKind }[] = skipped ? [] : kept.flatMap((r) => [...pageBboxIndexWants(r, geo), ...r.columns.map((chunk) => ({ chunk, kind: 'offset' as const }))])
  const { fetchedRanges, ...loaded } = await cache.loadIndexes(wants)
  const indexBytes = [...new Map(wants.map((w) => [`${w.kind}:${w.chunk.rowGroup}:${w.chunk.column.index}`, w.kind === 'offset' ? w.chunk.offsetIndex : w.chunk.columnIndex])).values()].reduce((a, r) => a + (r ? r.end - r.start : 0), 0)

  // 5. select pages: Page bbox が表示範囲と重なる行範囲だけを読む
  let spans = 0
  let spansKept = 0
  let withPageBbox = 0
  const plans: RowGroupPlan[] = kept.map((r) => {
    // Index を読まなかった Row Group でも、前に読んでキャッシュにあれば使う
    const pb = pageBboxesFromCache(cache, r, geo)
    let keptRows: RowSpan[] = [{ start: 0, end: r.numRows }]
    let spanKept: boolean[] | undefined
    if (pb.available) {
      withPageBbox++
      // bbox が求められない行範囲は読み飛ばせないので読む
      spanKept = pb.spans.map((s) => !s.bbox || hits(s.bbox))
      spans += pb.spans.length
      spansKept += spanKept.filter(Boolean).length
      keptRows = mergeRows(pb.spans.filter((_, i) => spanKept![i]).map((s) => s.rows))
    }
    return {
      rg: r.index,
      rgDecision: decisions[r.index],
      pageBboxes: pb,
      spanKept,
      keptRows,
      chunkRanges: r.columns.map((c) => ({ col: c.column.index, ...chunkRanges(cache, c, keptRows, r.numRows) })),
    }
  })

  // 6. read byte ranges: 選んだ列のページ範囲を合体する（隙間は埋めない：design.md D22）
  const selected = plans.flatMap((p) => p.chunkRanges.filter((c) => cols.has(c.col)).flatMap((c) => c.ranges))
  const all = plans.flatMap((p) => p.chunkRanges.flatMap((c) => c.ranges))
  const requests = coalesce(selected, (r) => r).map((run) => run.range)
  const pageRows = plans.reduce((a, p) => a + p.keptRows.reduce((b, s) => b + s.end - s.start, 0), 0)

  return {
    input,
    level,
    stages: {
      file: totals(file.rowGroups, cols),
      prefix: totals(prefix, cols),
      rowGroupPruned: { ...totals(kept, cols), pruned: decisions.filter((d) => d === 'prune').length, unknown: decisions.filter((d) => d === 'unknown').length },
      pageIndex: { ...loaded, bytes: indexBytes, rowGroupsWithPageBbox: withPageBbox, skipped, requests: coalesce(fetchedRanges, (r) => r).map((run) => run.range) },
      pages: { rowGroups: plans.filter((p) => p.keptRows.length).length, rows: pageRows, bytes: rangeBytes(selected), bytesAll: rangeBytes(all), spans, spansKept },
      requests: { logical: selected.length, coalesced: requests.length, bytes: rangeBytes(requests), logicalAll: all.length, coalescedAll: coalesce(all, (r) => r).length },
    },
    rowGroups: plans,
    requests,
  }
}

/** 既定で読む列: 主ジオメトリ列と bbox covering 列（design.md D21） */
export function defaultColumns(ins: Inspection): number[] {
  const primary = ins.geo?.primary
  const cov = primary?.covering
  const names = new Set([primary?.name, ...(cov ? coveringPaths(cov).map((p) => p.join('.')) : [])])
  const picked = ins.file.leafColumns.filter((c) => names.has(c.name) || (primary !== undefined && isTopLevel(c.path, primary.name))).map((c) => c.index)
  return picked.length ? picked : ins.file.leafColumns.map((c) => c.index)
}
