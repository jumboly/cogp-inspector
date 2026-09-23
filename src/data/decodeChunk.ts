import type { Compressors, DecodedArray, SchemaElement } from 'hyparquet'
// ページの展開・decode は hyparquet の内部関数を使う（design.md D31）。
// 公開 API の parquetRead は読む範囲を自分で決めてしまい、Access Plan どおりに読めないため。
// 内部モジュールに依存するので、package.json で hyparquet のバージョンを固定している
import { readColumn } from 'hyparquet/src/column.js'
import { DEFAULT_PARSERS } from 'hyparquet/src/convert.js'
import { getSchemaPath } from 'hyparquet/src/schema.js'
import type { RowSpan } from '../geo/pageBbox'
import type { ColumnChunkModel } from '../parquet/model'

/**
 * 1 つの Column Chunk について読んだページを decode し、値を Row Group 内の行番号と並べて返す。
 *
 * pages は「辞書ページ（あれば）＋読んだデータページ」をファイル順につないだバイト列。
 * readColumn はヘッダを順にたどって最後まで decode するので、読み飛ばしたページを抜いてつないでも
 * 値はページ順に並んで出てくる。rows（読んだデータページが覆う行）と突き合わせて行番号を戻す。
 */
export function decodeChunk(schema: SchemaElement[], chunk: ColumnChunkModel, pages: Uint8Array, rows: RowSpan[], compressors: Compressors): { rows: Int32Array; values: unknown[] } {
  const meta = chunk.raw.meta_data
  if (!meta) throw new Error(`RG${chunk.rowGroup} ${chunk.column.name}: ColumnMetaData がありません`)
  const schemaPath = getSchemaPath(schema, chunk.column.path)
  const decoder = {
    pathInSchema: chunk.column.path,
    type: meta.type,
    element: schemaPath[schemaPath.length - 1].element,
    schemaPath,
    codec: meta.codec,
    parsers: DEFAULT_PARSERS,
    compressors,
    // WKB などのバイナリ列を文字列にしない（D6 で geo から論理型を補わないので、既定の utf8 だと文字列化される）
    utf8: false,
  }
  const expected = rows.reduce((a, r) => a + r.end - r.start, 0)
  const reader = { view: new DataView(pages.buffer, pages.byteOffset, pages.byteLength), offset: 0 }
  // selectEnd は「この行数に達したら止める」。つないだページの行数ちょうどを渡し、末尾まで decode させる
  const { data } = readColumn(reader, { groupStart: 0, groupRows: expected, selectStart: 0, selectEnd: expected }, decoder)
  const values = flatten(data)
  if (values.length !== expected) {
    throw new Error(`RG${chunk.rowGroup} ${chunk.column.name}: decode した値 ${values.length} 件が、読んだページの行数 ${expected} と一致しません`)
  }
  const rowNumbers = new Int32Array(expected)
  let i = 0
  for (const r of rows) for (let row = r.start; row < r.end; row++) rowNumbers[i++] = row
  return { rows: rowNumbers, values }
}

function flatten(chunks: DecodedArray[]): unknown[] {
  if (chunks.length === 1) return Array.from(chunks[0] as ArrayLike<unknown>)
  const out: unknown[] = []
  for (const c of chunks) for (let i = 0; i < c.length; i++) out.push((c as ArrayLike<unknown>)[i])
  return out
}
