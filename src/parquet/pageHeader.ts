import { Encodings, PageTypes } from 'hyparquet/src/constants.js'
// PageHeader のデコーダ（hyparquet の parquetHeader）は非公開なので、公開されている Thrift デコーダで自前に読む。
// hyparquet の内部モジュールに依存するため、package.json でバージョンを固定している（design.md §3.1）
import { deserializeTCompactProtocol } from 'hyparquet/src/thrift.js'

export interface PageHeaderModel {
  type: string
  /** Thrift でエンコードされたヘッダ自体のバイト数 */
  headerSize: number
  /** ヘッダを含まない、圧縮後のページ本体のサイズ */
  compressedSize: number
  uncompressedSize: number
  crc?: number
  numValues?: number
  encoding?: string
  /** DATA_PAGE_V2 のみ */
  numNulls?: number
  numRows?: number
  isCompressed?: boolean
  /** DATA_PAGE_V2 のみ。v2 の level は圧縮されず、長さの前置きも無くページ本体の先頭に置かれるので、長さをヘッダから知る */
  defLevelsByteLength?: number
  repLevelsByteLength?: number
  /** DICTIONARY_PAGE のみ */
  isSorted?: boolean
  /** ページ単位の Statistics があるか（v1/v2 のデータページヘッダに任意で入る） */
  hasStatistics: boolean
}

type Thrift = Record<string, unknown>

/**
 * buf の先頭からページヘッダを 1 つデコードする。
 * buf が短すぎてヘッダが途中で切れていると RangeError になるので、呼び出し側で長く読み直す。
 * フィールド番号は parquet.thrift の PageHeader / DataPageHeader / DictionaryPageHeader / DataPageHeaderV2 に従う。
 */
export function parsePageHeader(buf: ArrayBuffer): PageHeaderModel {
  const reader = { view: new DataView(buf), offset: 0 }
  const h = deserializeTCompactProtocol(reader) as Thrift
  const v1 = h.field_5 as Thrift | undefined
  const dict = h.field_7 as Thrift | undefined
  const v2 = h.field_8 as Thrift | undefined
  const encodingName = (e: unknown) => (typeof e === 'number' ? (Encodings[e] ?? `不明(${e})`) : undefined)
  const base = {
    type: PageTypes[h.field_1 as number] ?? `不明(${String(h.field_1)})`,
    headerSize: reader.offset,
    uncompressedSize: h.field_2 as number,
    compressedSize: h.field_3 as number,
    crc: h.field_4 as number | undefined,
  }
  if (dict) return { ...base, numValues: dict.field_1 as number, encoding: encodingName(dict.field_2), isSorted: dict.field_3 as boolean | undefined, hasStatistics: false }
  if (v2) {
    return {
      ...base,
      numValues: v2.field_1 as number,
      numNulls: v2.field_2 as number,
      numRows: v2.field_3 as number,
      encoding: encodingName(v2.field_4),
      // is_compressed は省略時 true（parquet.thrift の既定値）
      isCompressed: (v2.field_7 as boolean | undefined) ?? true,
      defLevelsByteLength: v2.field_5 as number,
      repLevelsByteLength: v2.field_6 as number,
      hasStatistics: v2.field_8 !== undefined,
    }
  }
  if (v1) return { ...base, numValues: v1.field_1 as number, encoding: encodingName(v1.field_2), hasStatistics: v1.field_5 !== undefined }
  return { ...base, hasStatistics: false }
}
