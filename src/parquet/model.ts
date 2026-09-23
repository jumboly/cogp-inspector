import type { ColumnChunk, FileMetaData, SchemaElement, Statistics } from 'hyparquet'
import type { FooterRead } from './footer'

type MinMaxType = NonNullable<Statistics['min_value']>

/** ファイル内の半開区間 [start, end) */
export interface ByteRange {
  start: number
  end: number
}

export interface LeafColumn {
  /** Row Group 内の Column Chunk の並び順と一致する番号 */
  index: number
  path: string[]
  name: string
  physicalType: string
  logicalType?: string
  convertedType?: string
  repetition?: string
  /** Parquet ネイティブの GEOMETRY / GEOGRAPHY 論理型の属性。crs は書かれた文字列のまま（解釈は geo/crs.ts） */
  geoLogical?: { type: 'GEOMETRY' | 'GEOGRAPHY'; crs?: string; algorithm?: string }
}

export interface ColumnStats {
  min?: MinMaxType
  max?: MinMaxType
  nullCount?: number
  distinctCount?: number
  /** min_value/max_value が無く、非推奨の min/max から取った場合 true */
  fromDeprecated: boolean
  minExact?: boolean
  maxExact?: boolean
}

export interface ColumnChunkModel {
  rowGroup: number
  column: LeafColumn
  codec: string
  encodings: string[]
  numValues: number
  compressedSize: number
  uncompressedSize: number
  dataPageOffset: number
  dictionaryPageOffset?: number
  /** ページ群（辞書ページ込み）の範囲 */
  range: ByteRange
  hasDictionary: boolean
  stats?: ColumnStats
  columnIndex?: ByteRange
  offsetIndex?: ByteRange
  bloomFilterOffset?: number
  raw: ColumnChunk
}

export interface RowGroupModel {
  index: number
  numRows: number
  /** RowGroup.total_byte_size（非圧縮） */
  totalByteSize: number
  compressedSize: number
  /** 所属する Column Chunk 群を覆う範囲 */
  range: ByteRange
  /** 先頭行の、ファイル全体での行番号 */
  firstRow: number
  columns: ColumnChunkModel[]
}

export interface FileModel {
  size: number
  version: number
  numRows: number
  createdBy?: string
  keyValue: { key: string; value?: string }[]
  schema: SchemaElement[]
  leafColumns: LeafColumn[]
  rowGroups: RowGroupModel[]
  headerMagic: ByteRange
  footer: ByteRange
  trailer: ByteRange
  /** 全 Column Chunk の ColumnIndex / OffsetIndex を覆う範囲（無ければ undefined） */
  pageIndex?: ByteRange
  raw: FileMetaData
}

/** i64 は hyparquet で bigint になる。ファイルオフセットは 2^53 を超えないので number に寄せて UI で扱いやすくする */
const num = (v: bigint | number | undefined): number | undefined => (v === undefined ? undefined : Number(v))

function geoLogical(el: SchemaElement): LeafColumn['geoLogical'] {
  const lt = el.logical_type
  if (lt?.type === 'GEOMETRY') return { type: 'GEOMETRY', crs: lt.crs }
  if (lt?.type === 'GEOGRAPHY') return { type: 'GEOGRAPHY', crs: lt.crs, algorithm: lt.algorithm }
  return undefined
}

function leafColumns(schema: SchemaElement[]): LeafColumn[] {
  const leaves: LeafColumn[] = []
  // schema は深さ優先で平坦化された木。num_children を数えながら親のパスを復元する
  const stack: { name: string; remaining: number }[] = []
  for (let i = 1; i < schema.length; i++) {
    const el = schema[i]
    const path = [...stack.map((s) => s.name), el.name]
    if (el.num_children) {
      stack.push({ name: el.name, remaining: el.num_children })
      continue
    }
    leaves.push({
      index: leaves.length,
      path,
      name: path.join('.'),
      physicalType: el.type ?? '?',
      logicalType: el.logical_type?.type,
      geoLogical: geoLogical(el),
      convertedType: el.converted_type,
      repetition: el.repetition_type,
    })
    while (stack.length && --stack[stack.length - 1].remaining === 0) stack.pop()
  }
  return leaves
}

function stats(chunk: ColumnChunk): ColumnStats | undefined {
  const s = chunk.meta_data?.statistics
  if (!s) return undefined
  const hasNew = s.min_value !== undefined || s.max_value !== undefined
  return {
    min: hasNew ? s.min_value : s.min,
    max: hasNew ? s.max_value : s.max,
    nullCount: num(s.null_count),
    distinctCount: num(s.distinct_count),
    fromDeprecated: !hasNew && (s.min !== undefined || s.max !== undefined),
    minExact: s.is_min_value_exact,
    maxExact: s.is_max_value_exact,
  }
}

function indexRange(offset: bigint | undefined, length: number | undefined): ByteRange | undefined {
  if (offset === undefined || length === undefined) return undefined
  return { start: Number(offset), end: Number(offset) + length }
}

export function buildFileModel(size: number, footer: FooterRead): FileModel {
  const md = footer.metadata
  const leaves = leafColumns(md.schema)
  let firstRow = 0
  let pageIndex: ByteRange | undefined

  const rowGroups = md.row_groups.map((rg, rgIndex): RowGroupModel => {
    const columns = rg.columns.map((chunk, ci): ColumnChunkModel => {
      const meta = chunk.meta_data
      if (!meta) throw new Error(`Row Group ${rgIndex} の列 ${ci} に ColumnMetaData がありません`)
      const dataPageOffset = Number(meta.data_page_offset)
      // 辞書ページがあればそれが Column Chunk の先頭。dictionary_page_offset を 0 で書く writer もあるため正の値だけ採用する
      const dictOffset = num(meta.dictionary_page_offset)
      const dictionaryPageOffset = dictOffset !== undefined && dictOffset > 0 && dictOffset < dataPageOffset ? dictOffset : undefined
      const start = dictionaryPageOffset ?? dataPageOffset
      const compressedSize = Number(meta.total_compressed_size)
      const columnIndex = indexRange(chunk.column_index_offset, chunk.column_index_length)
      const offsetIndex = indexRange(chunk.offset_index_offset, chunk.offset_index_length)
      for (const r of [columnIndex, offsetIndex]) {
        if (r) pageIndex = pageIndex ? { start: Math.min(pageIndex.start, r.start), end: Math.max(pageIndex.end, r.end) } : { ...r }
      }
      return {
        rowGroup: rgIndex,
        column: leaves[ci] ?? { index: ci, path: meta.path_in_schema, name: meta.path_in_schema.join('.'), physicalType: meta.type },
        codec: meta.codec,
        encodings: meta.encodings ?? [],
        numValues: Number(meta.num_values),
        compressedSize,
        uncompressedSize: Number(meta.total_uncompressed_size),
        dataPageOffset,
        dictionaryPageOffset,
        range: { start, end: start + compressedSize },
        hasDictionary: dictionaryPageOffset !== undefined || (meta.encoding_stats?.some((e) => e.page_type === 'DICTIONARY_PAGE') ?? false),
        stats: stats(chunk),
        columnIndex,
        offsetIndex,
        bloomFilterOffset: num(meta.bloom_filter_offset),
        raw: chunk,
      }
    })
    const numRows = Number(rg.num_rows)
    const model: RowGroupModel = {
      index: rgIndex,
      numRows,
      totalByteSize: Number(rg.total_byte_size),
      compressedSize: num(rg.total_compressed_size) ?? columns.reduce((a, c) => a + c.compressedSize, 0),
      range: {
        start: Math.min(...columns.map((c) => c.range.start)),
        end: Math.max(...columns.map((c) => c.range.end)),
      },
      firstRow,
      columns,
    }
    firstRow += numRows
    return model
  })

  return {
    size,
    version: md.version,
    numRows: Number(md.num_rows),
    createdBy: md.created_by,
    keyValue: md.key_value_metadata ?? [],
    schema: md.schema,
    leafColumns: leaves,
    rowGroups,
    headerMagic: { start: 0, end: 4 },
    footer: { start: footer.metadataOffset, end: footer.metadataOffset + footer.metadataLength },
    trailer: { start: footer.trailerOffset, end: footer.trailerOffset + 8 },
    pageIndex,
    raw: md,
  }
}
