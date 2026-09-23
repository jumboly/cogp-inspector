import type { ColumnChunkModel, RowGroupModel } from '../parquet/model'
import type { ColumnIndexModel, OffsetIndexModel } from '../parquet/pageIndex'
import type { IndexKind, PageCache } from '../parquet/pages'
import type { Bbox } from './bbox'
import type { GeoModel } from './geoMetadata'

/** Row Group 内の行の半開区間 [start, end) */
export interface RowSpan {
  start: number
  end: number
}

export interface SpanBbox {
  rows: RowSpan
  /** 求められなければ undefined（＝この行範囲はページ単位では読み飛ばせない） */
  bbox?: Bbox
  /** xmin, ymin, xmax, ymax 各列で、この行範囲を含むページ（OffsetIndex の添字） */
  pages: [number, number, number, number]
}

export type PageBboxes =
  | { available: true; aligned: boolean; spans: SpanBbox[] }
  | { available: false; reason: string }

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i])

/** bbox covering の 4 列の Column Chunk（xmin, ymin, xmax, ymax の順）。covering が無ければ undefined */
export function coveringChunks(rg: RowGroupModel, geo: GeoModel | undefined): ColumnChunkModel[] | undefined {
  const cov = geo?.primary?.covering
  if (!cov) return undefined
  const chunks = [cov.xmin, cov.ymin, cov.xmax, cov.ymax].map((p) => rg.columns.find((c) => samePath(c.column.path, p)))
  return chunks.every(Boolean) ? (chunks as ColumnChunkModel[]) : undefined
}

/** first_row_index の昇順配列から、row を含むページの添字を二分探索で求める */
function pageAt(oi: OffsetIndexModel, row: number): number {
  let lo = 0
  let hi = oi.pages.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (oi.pages[mid].firstRow <= row) lo = mid
    else hi = mid - 1
  }
  return lo
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : NaN)

/**
 * ページ単位の bbox を、covering 4 列の ColumnIndex から組み立てる（design.md D17）。
 *
 * Parquet では列ごとにページの切れ目が独立しているので、「1 ページ = 1 bbox」とは限らない。
 * そこで 4 列すべてのページ境界で行を区切り、区切った行範囲ごとに「その範囲を含む各列のページ」の
 * min/max を使う。範囲より広いページの値を使うので bbox は実際より大きくなりうるが、小さくはならない
 * （＝読み飛ばしてよいページを誤って捨てない、保守的な見積もり）。
 */
export function pageBboxes(numRows: number, ois: (OffsetIndexModel | undefined)[], cis: (ColumnIndexModel | undefined)[]): PageBboxes {
  if (ois.some((o) => !o)) return { available: false, reason: 'bbox covering 列に OffsetIndex がありません' }
  if (cis.some((c) => !c)) return { available: false, reason: 'bbox covering 列に ColumnIndex がありません（ページごとの最小・最大が無い）' }
  const o = ois as OffsetIndexModel[]
  const c = cis as ColumnIndexModel[]
  const bounds = [...new Set([...o.flatMap((x) => x.pages.map((p) => p.firstRow)), numRows])].sort((a, b) => a - b)
  const first = o[0].pages.map((p) => p.firstRow).join(',')
  const aligned = o.every((x) => x.pages.map((p) => p.firstRow).join(',') === first)

  const spans: SpanBbox[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const rows = { start: bounds[i], end: bounds[i + 1] }
    if (rows.start >= numRows) break
    const pages = o.map((x) => pageAt(x, rows.start)) as SpanBbox['pages']
    // xmin・ymin は最小値、xmax・ymax は最大値を使う（Row Group の bbox と同じ取り方）
    const vals = [num(c[0].min[pages[0]]), num(c[1].min[pages[1]]), num(c[2].max[pages[2]]), num(c[3].max[pages[3]])]
    const allNull = pages.some((p, k) => c[k].nullPages[p])
    spans.push({ rows, pages, bbox: !allNull && vals.every(Number.isFinite) ? (vals as Bbox) : undefined })
  }
  return { available: true, aligned, spans }
}

export function intersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

/** Page bbox を求めるのに読む必要がある Index（covering 4 列の OffsetIndex と ColumnIndex） */
export function pageBboxIndexWants(rg: RowGroupModel, geo: GeoModel | undefined): { chunk: ColumnChunkModel; kind: IndexKind }[] {
  return (coveringChunks(rg, geo) ?? []).flatMap((chunk) => [
    { chunk, kind: 'offset' as const },
    { chunk, kind: 'column' as const },
  ])
}

/** 読み込み済みの Index から Page bbox を求める（先に pageBboxIndexWants の分を PageCache に読んでおく） */
export function pageBboxesFromCache(cache: PageCache, rg: RowGroupModel, geo: GeoModel | undefined): PageBboxes {
  const chunks = coveringChunks(rg, geo)
  if (!chunks) return { available: false, reason: 'bbox covering 列がありません' }
  return pageBboxes(
    rg.numRows,
    chunks.map((c) => cache.offsetIndex(c)),
    chunks.map((c) => cache.columnIndex(c)),
  )
}
