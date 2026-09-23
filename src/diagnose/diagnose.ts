import type { Bbox } from '../geo/bbox'
import type { PageBboxes } from '../geo/pageBbox'
import type { Inspection } from '../inspect'
import type { Selection } from '../state/store'
import { formatBytes, formatNumber as fmt } from '../util/format'

/**
 * 「Cloud Optimized と言える構造か」の診断（design.md D41・D42、issue 07）。
 * ファイルを開いた時点で読んだ Footer だけから判定する（D15）。Page Index が要る項目は、読むまで「未確認」にする。
 * 仕様の MUST と SHOULD を混ぜないよう、項目を 3 群に分ける。
 */

export type DiagGroup = 'must' | 'should' | 'hint'

/**
 * ok / ng は判定できたもの、warn は SHOULD・目安を満たしていないもの、
 * info は合否を付けない値（根拠のある閾値が無いもの）、unknown は Footer だけでは分からないもの、na は対象外
 */
export type Verdict = 'ok' | 'ng' | 'warn' | 'info' | 'unknown' | 'na'

export interface DiagDetail {
  label: string
  value: string
  verdict?: Verdict
  target?: Selection
}

export interface DiagItem {
  id: string
  group: DiagGroup
  title: string
  verdict: Verdict
  /** 判定の根拠の値 */
  value: string
  note?: string
  /** クリックで選ぶもの（該当する Row Group など） */
  target?: Selection
  details?: DiagDetail[]
}

export const GROUP_LABEL: Record<DiagGroup, string> = {
  must: 'MUST（仕様の必須要件）',
  should: 'SHOULD（仕様の推奨）',
  hint: '仕様外の目安（読みやすさ）',
}

const area = (b: Bbox) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])

function enclose(bs: Bbox[]): Bbox | undefined {
  if (!bs.length) return undefined
  return bs.reduce<Bbox>((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])], [...bs[0]] as Bbox)
}

export interface LevelOverlap {
  level: number
  rowGroups: number
  /** bbox が求められた Row Group の数（統計が無い Row Group は計算に入れない） */
  withBbox: number
  /**
   * その Level で加わった Row Group の bbox 面積の合計 ÷ それらを合わせた範囲の面積（design.md D42）。
   * 1 を超えた分は Row Group どうしの重なり、1 未満は Row Group の間の隙間（データの無い範囲）を表す。
   * 範囲の面積が 0（点 1 つなど）なら undefined
   */
  coefficient?: number
}

/** RG from..to（含む）の重なり係数。bbox が無い Row Group は計算に入れない */
function overlapOf(ins: Inspection, from: number, to: number): { withBbox: number; coefficient?: number } {
  const bs: Bbox[] = []
  for (let rg = Math.max(from, 0); rg <= Math.min(to, ins.file.rowGroups.length - 1); rg++) {
    const b = ins.rowGroupBboxes[rg]?.bbox
    if (b) bs.push(b)
  }
  const all = enclose(bs)
  const total = all ? area(all) : 0
  return { withBbox: bs.length, coefficient: total > 0 ? bs.reduce((a, b) => a + area(b), 0) / total : undefined }
}

/** Level ごとの重なり係数。Footer の Row Group 統計だけで計算できる */
export function levelOverlaps(ins: Inspection): LevelOverlap[] {
  return (ins.lod?.levels ?? []).map((l) => ({
    level: l.level,
    rowGroups: Math.max(0, l.rowGroupEnd - l.newFrom + 1),
    ...overlapOf(ins, l.newFrom, l.rowGroupEnd),
  }))
}

/**
 * ファイル全体（全 Row Group）の重なり係数。lod の無い通常の GeoParquet で、並び順の違い（元の順・Hilbert 順）を
 * Level ごとの値と同じ物差しで比べるため（design.md D42）。COGP では Level どうしが同じ範囲を覆うので大きくなる
 */
export function fileOverlap(ins: Inspection): { rowGroups: number; withBbox: number; coefficient?: number } {
  return { rowGroups: ins.file.rowGroups.length, ...overlapOf(ins, 0, ins.file.rowGroups.length - 1) }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : NaN
}
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(a === b ? 0 : 1)} %` : '-')

/**
 * 診断の一覧を作る。pageBboxOf は Page Index を読んだ Row Group についてだけ Page bbox を返す
 * （読んでいない Row Group は undefined。「未確認」の判定に使う）
 */
export function diagnose(ins: Inspection, pageBboxOf: (rg: number) => PageBboxes | undefined): DiagItem[] {
  const { file, geo, lod } = ins
  const n = file.rowGroups.length
  const items: DiagItem[] = []

  // ---- MUST ----
  items.push(
    !geo
      ? { id: 'geoparquet', group: 'must', title: 'GeoParquet に準拠する', verdict: 'ng', value: 'geo メタデータがありません', note: 'COGP は GeoParquet の拡張なので、geo メタデータが要る', target: { kind: 'file' } }
      : {
          id: 'geoparquet',
          group: 'must',
          title: 'GeoParquet に準拠する',
          verdict: geo.problems.length ? 'ng' : 'ok',
          value: geo.problems.length ? geo.problems.join(' / ') : `geo ${geo.version ?? '(version なし)'}、主ジオメトリ列 ${geo.primaryColumn ?? '-'}`,
          note: 'Footer の geo メタデータの形だけを確かめる（ジオメトリ本体の妥当性までは見ない）',
          target: { kind: 'geo' },
        },
  )
  if (!lod) {
    items.push({ id: 'lod', group: 'must', title: 'geo.lod の境界条件', verdict: 'na', value: 'geo.lod がありません（通常の GeoParquet）', note: 'lod が無ければ COGP の MUST は対象外。リーダーは通常の GeoParquet として読む' })
  } else {
    // parseLod の違反を、仕様の条件ごとの項目に振り分ける（どの条件が崩れたかを 1 行ずつ見せるため）
    const rules: { id: string; title: string; match: (rule: string) => boolean; ok: string }[] = [
      { id: 'levels', title: 'levels は空でない配列', match: (r) => r.startsWith('levels'), ok: `${fmt(lod.levels.length)} Level` },
      { id: 'rge-range', title: '0 ≤ row_group_end < Row Group 数（整数）', match: (r) => r.startsWith('0 <=') || r.startsWith('row_group_end は整数'), ok: `すべて 0〜${fmt(n - 1)} の整数` },
      { id: 'rge-order', title: 'row_group_end は非減少', match: (r) => r.startsWith('row_group_end は非減少'), ok: lod.levels.map((l) => l.rowGroupEnd).join(' ≤ ') },
      { id: 'rge-last', title: '最後の row_group_end = Row Group 数 − 1（全行を含む）', match: (r) => r.startsWith('最後の Level'), ok: `${lod.levels.at(-1)?.rowGroupEnd} = ${n} − 1` },
      { id: 'res-positive', title: 'resolution は正の有限値', match: (r) => r.startsWith('resolution は正'), ok: 'すべて正の有限値' },
      { id: 'res-order', title: 'resolution は狭義単調減少（粗い → 細かい）', match: (r) => r.startsWith('resolution は狭義'), ok: lod.levels.map((l) => l.resolution.toPrecision(3)).join(' > ') },
    ]
    for (const rule of rules) {
      const vs = lod.violations.filter((v) => rule.match(v.rule))
      items.push({ id: rule.id, group: 'must', title: rule.title, verdict: vs.length ? 'ng' : 'ok', value: vs.length ? vs.map((v) => v.detail).join(' / ') : rule.ok, target: { kind: 'lod' } })
    }
    items.push({
      id: 'rg-boundary',
      group: 'must',
      title: 'Row Group が Level 境界をまたがない・粗い順に並ぶ',
      verdict: lod.valid ? 'ok' : 'unknown',
      value: lod.valid ? 'row_group_end が Row Group 番号で与えられ、上の条件を満たすので、構造上満たす' : '上の条件が崩れているため Level の範囲が定まらない',
      target: { kind: 'lod' },
    })
    if (!lod.valid) {
      items.push({ id: 'lod-use', group: 'must', title: '不正な lod を prefix 選択に使わない（リーダー側）', verdict: 'info', value: `違反 ${fmt(lod.violations.length)} 件。このツールも Level で絞らず、すべての Row Group を候補にする`, target: { kind: 'lod' } })
    }
  }
  items.push({
    id: 'rows-once',
    group: 'must',
    title: '各行をちょうど 1 回だけ格納し、ジオメトリ・属性を変えない',
    verdict: 'unknown',
    value: 'ファイルだけでは確かめられない（元データとの突き合わせが要る）',
    note: '同じ行が 2 つの Level に入っていると、prefix を読んだときに重複して描かれる',
  })

  // ---- SHOULD ----
  const bboxes = ins.rowGroupBboxes
  const withStats = bboxes.filter((b) => b.bbox).length
  const firstMissing = bboxes.findIndex((b) => !b.bbox)
  items.push({
    id: 'stats',
    group: 'should',
    title: 'Row Group に空間統計がある（特に先頭の Row Group）',
    verdict: withStats === n ? 'ok' : 'warn',
    value: `${fmt(withStats)} / ${fmt(n)} Row Group に bbox がある${bboxes[0] && !bboxes[0].bbox ? '（RG 0 に無い）' : ''}`,
    note: '統計が無い Row Group は読み飛ばせないので、リーダーは必ず読む',
    target: firstMissing >= 0 ? { kind: 'rowGroup', rg: firstMissing } : undefined,
  })
  if (n > 0) {
    const rows = file.rowGroups.map((r) => r.numRows)
    const med = median(rows)
    const first = file.rowGroups[0]
    items.push({
      id: 'first-small',
      group: 'should',
      title: '先頭の Row Group を小さくする',
      verdict: n === 1 ? 'info' : first.numRows < med ? 'ok' : 'warn',
      value: `RG 0 は ${fmt(first.numRows)} 行（全 Row Group の中央値 ${fmt(med)} 行）`,
      note: '最も粗い Level はどの縮尺でも読むので、小さいほど最初の表示が速い。「中央値より小さいか」はこのツールの目安',
      target: { kind: 'rowGroup', rg: 0 },
    })
  }
  if (lod) {
    const overlaps = levelOverlaps(ins)
    items.push({
      id: 'clustering',
      group: 'should',
      title: '各 Level で新しく入る行を空間的にまとめる',
      verdict: 'info',
      value: 'Level ごとの重なり係数（下の表）',
      note: 'その Level で加わった Row Group の bbox 面積の合計 ÷ それらを合わせた範囲の面積。1 を超えた分は Row Group どうしの重なりで、大きいほど 1 か所を表示するのに読む Row Group が増える。1 未満は Row Group の間に隙間（データの無い海など）があることを示す。根拠のある閾値が無いので合否は付けない',
      details: overlaps.map((o) => ({
        label: `Level ${o.level}（RG ${fmt(o.rowGroups)} 個）`,
        value: o.coefficient === undefined ? (o.rowGroups === 0 ? '新しい Row Group なし' : '計算できない（bbox が無い・範囲の面積が 0）') : `${o.coefficient.toFixed(2)}${o.withBbox < o.rowGroups ? `（bbox のある ${fmt(o.withBbox)} 個で計算）` : ''}`,
        target: { kind: 'level', level: o.level },
      })),
    })
    const l0 = lod.levels[0]
    const l0Bbox = l0 && enclose(bboxes.slice(0, l0.rowGroupEnd + 1).flatMap((b) => (b.bbox ? [b.bbox] : [])))
    const allBbox = enclose(bboxes.flatMap((b) => (b.bbox ? [b.bbox] : [])))
    if (l0Bbox && allBbox && area(allBbox) > 0) {
      items.push({
        id: 'coarse-spread',
        group: 'should',
        title: '粗い Level の地物をデータ範囲全体に散らす',
        verdict: 'info',
        value: `Level 0 の範囲はデータ全体の範囲の ${pct(area(l0Bbox), area(allBbox))}`,
        note: 'Row Group の bbox を合わせた範囲どうしの面積比。100 % に近いほど、最も粗い Level でも全体が見える',
        target: { kind: 'level', level: 0 },
      })
    }
  }

  // ---- 仕様外の目安 ----
  if (!lod && n > 1) {
    const o = fileOverlap(ins)
    items.push({
      id: 'file-overlap',
      group: 'hint',
      title: 'Row Group が空間的にまとまっている',
      verdict: 'info',
      value: o.coefficient === undefined ? '計算できない（bbox が無い・範囲の面積が 0）' : `全 Row Group の重なり係数 ${o.coefficient.toFixed(2)}${o.withBbox < o.rowGroups ? `（bbox のある ${fmt(o.withBbox)} 個で計算）` : ''}`,
      note: 'COGP の Level ごとの重なり係数と同じ物差しを、ファイル全体に当てたもの。行が場所と無関係に並ぶと、どの Row Group もデータ全体を覆うので Row Group 数に近づき、表示範囲が狭くても Row Group を読み飛ばせない。空間的に並べると 1 に近づく',
      target: { kind: 'rowGroups' },
    })
  }
  items.push({
    id: 'covering',
    group: 'hint',
    title: 'bbox covering 列がある',
    verdict: geo?.primary?.covering ? 'ok' : 'warn',
    value: geo?.primary?.covering ? `${geo.primary.covering.xmin.join('.')} など 4 列` : 'なし',
    note: 'Row Group・ページの bbox を統計値から求めるのに使う。仕様では必須ではない',
    target: geo ? { kind: 'geo' } : undefined,
  })
  const chunks = file.rowGroups.flatMap((r) => r.columns)
  const withOi = chunks.filter((c) => c.offsetIndex).length
  const covNames = geo?.primary?.covering ? new Set([geo.primary.covering.xmin, geo.primary.covering.ymin, geo.primary.covering.xmax, geo.primary.covering.ymax].map((p) => p.join('.'))) : undefined
  const covChunks = covNames ? chunks.filter((c) => covNames.has(c.column.path.join('.'))) : []
  const covWithCi = covChunks.filter((c) => c.columnIndex).length
  items.push({
    id: 'page-index',
    group: 'hint',
    title: 'Page Index がある（全列の OffsetIndex と bbox covering 列の ColumnIndex）',
    verdict: !file.pageIndex ? 'warn' : withOi === chunks.length && (!covNames || covWithCi === covChunks.length) ? 'ok' : 'warn',
    value: file.pageIndex ? `OffsetIndex ${fmt(withOi)} / ${fmt(chunks.length)} Column Chunk${covNames ? `、covering 列の ColumnIndex ${fmt(covWithCi)} / ${fmt(covChunks.length)}` : ''}` : 'なし',
    note: 'あれば Row Group より細かいページ単位で読み飛ばせる',
    target: file.pageIndex ? { kind: 'pageIndex' } : undefined,
  })
  if (covNames) {
    // ページ境界は Page Index を読まないと分からない。Row Group を選ぶか Access Simulator で読んだ分だけ判定する
    const checked: { rg: number; aligned: boolean }[] = []
    for (let rg = 0; rg < n; rg++) {
      const pb = pageBboxOf(rg)
      if (pb?.available) checked.push({ rg, aligned: pb.aligned })
    }
    const bad = checked.filter((c) => !c.aligned)
    items.push({
      id: 'page-aligned',
      group: 'hint',
      title: 'bbox covering 4 列のページ境界がそろっている',
      verdict: !checked.length ? 'unknown' : bad.length ? 'warn' : 'ok',
      value: !checked.length ? '未確認（Page Index を読んでいない）。Row Group を選ぶか Access Simulator を動かすと、読んだ Row Group の分を判定する' : bad.length ? `${fmt(bad.length)} / ${fmt(checked.length)} Row Group でずれている（確認済み ${fmt(checked.length)} / ${fmt(n)}）` : `確認済み ${fmt(checked.length)} / ${fmt(n)} Row Group でそろっている`,
      note: 'ずれていると 1 ページ = 1 bbox にならず、ページより細かい行範囲に分けて判定することになる（読み飛ばしの効き方が落ちうる）',
      target: bad.length ? { kind: 'rowGroup', rg: bad[0].rg } : !checked.length ? { kind: 'rowGroup', rg: 0 } : undefined,
    })
  }
  if (n > 0) {
    const rows = file.rowGroups.map((r) => r.numRows)
    const bytes = file.rowGroups.map((r) => r.compressedSize)
    const maxRg = bytes.indexOf(Math.max(...bytes))
    items.push({
      id: 'rg-size',
      group: 'hint',
      title: 'Row Group の大きさ',
      verdict: 'info',
      value: `${fmt(Math.min(...rows))}〜${fmt(Math.max(...rows))} 行、圧縮後 ${formatBytes(Math.min(...bytes))}〜${formatBytes(Math.max(...bytes))}`,
      note: 'Row Group は読むか読まないかを決める単位。大きすぎると範囲外の行もまとめて読み、小さすぎると Footer と Range Request が増える',
      target: { kind: 'rowGroup', rg: maxRg },
    })
  }
  return items
}

/** ヘッダに出す要約。MUST の違反と、SHOULD・目安の注意の数 */
export function summarize(items: DiagItem[]): { mustNg: number; warn: number; unknown: number } {
  return {
    mustNg: items.filter((i) => i.group === 'must' && i.verdict === 'ng').length,
    warn: items.filter((i) => i.group !== 'must' && i.verdict === 'warn').length,
    unknown: items.filter((i) => i.verdict === 'unknown').length,
  }
}
