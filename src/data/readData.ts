import type { Geometry } from 'geojson'
import type { Compressors } from 'hyparquet'
import { levelOfRowGroup } from '../cogp/lod'
import { intersects } from '../geo/pageBbox'
import type { Inspection } from '../inspect'
import { coalesce, mapLimit, READ_CONCURRENCY } from '../io/coalesce'
import type { RandomAccessSource } from '../io/source'
import type { ByteRange, LeafColumn } from '../parquet/model'
import type { AccessPlan } from '../plan/accessPlan'
import { decodeChunk } from './decodeChunk'
import { geometryBbox, parseWkb, toLonLatGeometry } from './geometry'

/**
 * 1 回の地図移動で実際に読むデータの上限（選んだ列の推定バイト数）。design.md D33。
 * 東京周辺の例（約 2.7MB）の 7 倍ほどの余裕。lod の無いファイルの全体表示や、大きい列を足したときの歯止め。
 */
export const MAX_DATA_BYTES = 20 * 1024 * 1024

export type DataBlocker = 'no-geometry-column' | 'geometry-not-selected' | 'unsupported-encoding' | 'unmappable' | 'over-limit' | 'nothing-to-read'

export interface DecodedFeature {
  rg: number
  /** Row Group 内の行番号 */
  row: number
  /** 行が属する Level（その Row Group が加わった Level）。lod が無ければ undefined */
  level?: number
  /** 地図（経緯度）に載せる形 */
  geometry: Geometry
  /** ジオメトリの bbox が表示範囲と重なるか（design.md D36） */
  inView: boolean
}

export interface DataReadResult {
  requests: number
  /** 読み終わった Range Request の数。読み込み中の進み具合（design.md D38）で、終わると requests と等しい */
  doneRequests: number
  bytes: number
  /** decode した行（読んだページが覆う行） */
  readRows: number
  inViewRows: number
  /** geometry が null・壊れていて描けない行 */
  emptyRows: number
  ms: number
}

/** 主ジオメトリ列（葉の列）。GeoParquet 1.x の WKB は入れ子にならないので、パスの長さ 1 の列だけを探す */
export function geometryColumn(ins: Inspection): LeafColumn | undefined {
  const name = ins.geo?.primary?.name
  return name === undefined ? undefined : ins.file.leafColumns.find((c) => c.path.length === 1 && c.path[0] === name)
}

/** 実データを読めない理由。読む前に Expected（推定）だけで判断できるものに限る */
export function dataBlocker(ins: Inspection, plan: AccessPlan): DataBlocker | undefined {
  const primary = ins.geo?.primary
  const geom = geometryColumn(ins)
  if (!primary || !geom) return 'no-geometry-column'
  // GeoArrow（point・polygon などの入れ子の列）は decode の仕方が違うので、いまは WKB だけに対応する
  if ((primary.encoding ?? 'WKB').toUpperCase() !== 'WKB') return 'unsupported-encoding'
  if (!primary.crs.mapProjection) return 'unmappable'
  if (!plan.input.columns.includes(geom.index)) return 'geometry-not-selected'
  if (!plan.requests.length) return 'nothing-to-read'
  if (plan.stages.requests.bytes > MAX_DATA_BYTES) return 'over-limit'
  return undefined
}

interface Piece {
  rg: number
  col: number
  /** Column Chunk 内での順番（辞書ページ → データページの順） */
  seq: number
  range: ByteRange
}

interface ChunkState {
  rg: number
  col: number
  pieces: (Uint8Array | undefined)[]
  remaining: number
}

/**
 * Access Plan で決めた範囲を、そのとおりに読んで decode する（design.md D31）。
 * 読むのは選んだ列すべて（Actual のバイト数を Expected と比べるため）だが、decode して描くのは geometry 列だけ。
 * Range は計画と同じ合体方針（重なり・隣接だけ、D22）でまとめ、ファイル順に同時 READ_CONCURRENCY 本で読む。
 * Column Chunk の全ページが揃うたびに onChunk を、Range を 1 つ読み終えるたびに onProgress（その時点の集計）を呼ぶ。
 * COGP はファイル順が粗い Level → 細かい Level の順なので、呼び出し側が描き足していけば粗い全体像から先に出る（D38）。
 */
export async function readPlanData(
  ins: Inspection,
  source: RandomAccessSource,
  plan: AccessPlan,
  opts: {
    compressors: Compressors
    signal?: AbortSignal
    onChunk?: (features: DecodedFeature[]) => void
    onProgress?: (progress: DataReadResult) => void
  },
): Promise<DataReadResult> {
  const started = performance.now()
  const geom = geometryColumn(ins)
  const cols = new Set(plan.input.columns)
  const proj = ins.geo?.primary?.crs.mapProjection ?? null
  const hits = (g: Geometry) => {
    const b = geometryBbox(g)
    return !!b && plan.input.viewport.some((v) => intersects(b, v))
  }

  const pieces: Piece[] = []
  const chunks = new Map<string, ChunkState>()
  const rowsOf = new Map<string, AccessPlan['rowGroups'][number]['chunkRanges'][number]>()
  for (const r of plan.rowGroups) {
    for (const c of r.chunkRanges) {
      if (!cols.has(c.col) || !c.ranges.length) continue
      const k = `${r.rg}:${c.col}`
      chunks.set(k, { rg: r.rg, col: c.col, pieces: new Array(c.ranges.length), remaining: c.ranges.length })
      rowsOf.set(k, c)
      c.ranges.forEach((range, seq) => pieces.push({ rg: r.rg, col: c.col, seq, range }))
    }
  }
  const runs = coalesce(pieces, (p) => p.range)
  const result: DataReadResult = { requests: runs.length, doneRequests: 0, bytes: 0, readRows: 0, inViewRows: 0, emptyRows: 0, ms: 0 }

  const decode = (st: ChunkState) => {
    const chunk = ins.file.rowGroups[st.rg].columns[st.col]
    const total = st.pieces.reduce((a, p) => a + p!.byteLength, 0)
    const joined = new Uint8Array(total)
    let at = 0
    for (const p of st.pieces) {
      joined.set(p!, at)
      at += p!.byteLength
    }
    const { rows, values } = decodeChunk(ins.file.schema, chunk, joined, rowsOf.get(`${st.rg}:${st.col}`)!.rows, opts.compressors)
    const level = levelOfRowGroup(ins.lod, st.rg)
    const features: DecodedFeature[] = []
    for (let i = 0; i < values.length; i++) {
      const g = parseWkb(values[i])
      const lonLat = g && toLonLatGeometry(g, proj)
      if (!g || !lonLat) {
        result.emptyRows++
        continue
      }
      const inView = hits(g)
      if (inView) result.inViewRows++
      features.push({ rg: st.rg, row: rows[i], level, geometry: lonLat, inView })
    }
    result.readRows += values.length
    opts.onChunk?.(features)
  }

  await mapLimit(runs, READ_CONCURRENCY, async (run) => {
    // 地図が動いて計画が古くなったら、まだ始めていない read は投げない
    opts.signal?.throwIfAborted()
    const buf = await source.read(run.range.start, run.range.end - run.range.start, purposeOf(ins, run.members), opts.signal)
    // ローカルファイルの read は途中で止められないので、読み終えた後にも確かめて古い計画の decode を省く
    opts.signal?.throwIfAborted()
    result.bytes += buf.byteLength
    for (const m of run.members) {
      const st = chunks.get(`${m.rg}:${m.col}`)!
      st.pieces[m.seq] = new Uint8Array(buf, m.range.start - run.range.start, m.range.end - m.range.start)
      if (--st.remaining === 0 && m.col === geom?.index) decode(st)
    }
    result.doneRequests++
    // 中断された後の進み具合は、新しい計画の表示を上書きしてしまうので伝えない
    if (!opts.signal?.aborted) opts.onProgress?.({ ...result, ms: performance.now() - started })
  })
  result.ms = performance.now() - started
  return result
}

/** Range 記録に出すラベル。先頭の "data " で分類する（readCategory.ts） */
function purposeOf(ins: Inspection, members: Piece[]): string {
  const first = members[0]
  const name = ins.file.leafColumns[first.col].name
  const others = new Set(members.map((m) => `${m.rg}:${m.col}`)).size - 1
  return others ? `data RG${first.rg} ${name} ほか ${others} Column Chunk（合体）` : `data RG${first.rg} ${name}（${members.length} ページ）`
}
