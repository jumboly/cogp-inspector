import { readColumnIndex, readOffsetIndex, type SchemaElement } from 'hyparquet'
import type { ColumnChunkModel } from './model'

/** OffsetIndex の 1 ページ分。OffsetIndex に辞書ページは載らない（parquet-format PageIndex.md） */
export interface PageLocationModel {
  /** ページ（ヘッダ込み）の開始位置 */
  offset: number
  /** ヘッダを含むサイズ。PageHeader の compressed_page_size（ヘッダを含まない）とは違う */
  compressedSize: number
  /** Row Group 内での先頭行番号 */
  firstRow: number
  /** 次のページの先頭行（最後のページは Row Group の行数）との差 */
  rowCount: number
}

export interface OffsetIndexModel {
  pages: PageLocationModel[]
}

export interface ColumnIndexModel {
  /** true のページは値がすべて null で、min/max は意味を持たない */
  nullPages: boolean[]
  min: unknown[]
  max: unknown[]
  boundaryOrder: string
  nullCounts?: number[]
}

const view = (buf: ArrayBuffer) => ({ view: new DataView(buf), offset: 0 })

export function parseOffsetIndex(buf: ArrayBuffer, rowGroupRows: number): OffsetIndexModel {
  const oi = readOffsetIndex(view(buf))
  const pages = oi.page_locations.map((p) => ({
    offset: Number(p.offset),
    compressedSize: p.compressed_page_size,
    firstRow: Number(p.first_row_index),
    rowCount: 0,
  }))
  pages.forEach((p, i) => (p.rowCount = (pages[i + 1]?.firstRow ?? rowGroupRows) - p.firstRow))
  return { pages }
}

/**
 * ColumnIndex の min/max は物理型の PLAIN バイナリで入っている。hyparquet に schema を渡して値に変換させる
 * （DOUBLE なら number）。
 */
export function parseColumnIndex(buf: ArrayBuffer, schema: SchemaElement): ColumnIndexModel {
  const ci = readColumnIndex(view(buf), schema)
  return {
    nullPages: ci.null_pages,
    min: ci.min_values,
    max: ci.max_values,
    boundaryOrder: ci.boundary_order,
    nullCounts: ci.null_counts?.map(Number),
  }
}

/** Column Chunk の葉に対応する SchemaElement（ColumnIndex の値の変換に型情報が要るため） */
export function schemaElementOf(schema: SchemaElement[], chunk: ColumnChunkModel): SchemaElement | undefined {
  // leafColumns は schema[1..] の葉を順に数えたものなので、同じ数え方で位置を逆算する
  let leaf = -1
  for (let i = 1; i < schema.length; i++) {
    if (schema[i].num_children) continue
    if (++leaf === chunk.column.index) return schema[i]
  }
  return undefined
}
