import type { CompressionCodec, Compressors, ParquetType, SchemaElement } from 'hyparquet'
// 展開と PLAIN の decode・型の変換は hyparquet の内部関数を使う（design.md D31 と同じ理由。バージョンは package.json で固定）
import { DEFAULT_PARSERS, convert } from 'hyparquet/src/convert.js'
import { decompressPage } from 'hyparquet/src/datapage.js'
import { readPlain } from 'hyparquet/src/plain.js'
import { getMaxDefinitionLevel, getMaxRepetitionLevel, getSchemaPath } from 'hyparquet/src/schema.js'
import { readCoalesced } from '../io/coalesce'
import type { ColumnChunkModel } from '../parquet/model'
import { bitWidthOf, decodeHybrid, type HybridRun } from '../parquet/hybrid'
import type { PageCache, PageModel } from '../parquet/pages'

/**
 * 辞書ページとデータページの中身を読み、level・index・辞書の値に分ける。design.md D53〜D59。
 * バイト位置はすべて「展開後のページ本体」の中での位置（ヘッダは含まない）。
 */

export interface DictionaryContent {
  /** 表示用に変換した値（文字列など） */
  values: unknown[]
  /** 各値を PLAIN で書いたときのバイト数（BYTE_ARRAY は長さの 4 バイトを含む） */
  plainSizes: number[]
  /** 展開後の辞書ページ本体のバイト数 */
  bodySize: number
}

export type SectionKind = 'rep' | 'def' | 'length' | 'bit-width' | 'index'

export interface BodySection {
  kind: SectionKind
  start: number
  end: number
  /** level・index の RLE / Bit-Packing の区切り。位置はページ本体の中での位置に直してある */
  runs?: HybridRun[]
}

export interface ValueEntry {
  /** ページ内での値の順番（level の並びの順） */
  pos: number
  /** Row Group 内の行番号。OffsetIndex が無く先頭行が分からなければ、ページ内の行番号 */
  row: number
  rep?: number
  def?: number
  /** 辞書の番号。null（def level が最大値より小さい）の値には無い */
  index?: number
}

export interface DataPageContent {
  encoding: string
  /** 展開後のページ本体（v2 は level と展開した値をつないだもの）のバイト数 */
  bodySize: number
  sections: BodySection[]
  maxRep: number
  maxDef: number
  /** index の bit width（ページ本体の 1 バイト目に書かれた値） */
  bitWidth: number
  entries: ValueEntry[]
  /** 行番号が Row Group の中の番号か（false ならページ内の番号） */
  rowsAbsolute: boolean
  /** null でない値を PLAIN で書いたときのバイト数（D56） */
  plainBytes: number
  /** index 部分（bit width の 1 バイトを含む）のバイト数 */
  indexBytes: number
  levelBytes: number
}

export type PageContent =
  | { kind: 'dictionary'; dictionary: DictionaryContent }
  | { kind: 'data'; dictionary: DictionaryContent; data: DataPageContent }
  /** 辞書で符号化されていないデータページ（D58）。辞書があれば fallback */
  | { kind: 'not-dictionary'; encoding: string; hasDictionary: boolean }

const DICTIONARY_ENCODINGS = ['RLE_DICTIONARY', 'PLAIN_DICTIONARY']

/** ボタンを出せるページか。ヘッダの符号化で決める（読む前に分かる） */
export function isDictionaryEncoded(p: PageModel): boolean {
  return p.kind === 'dictionary' || DICTIONARY_ENCODINGS.includes(p.header?.encoding ?? '')
}

/**
 * ページ（と Column Chunk の辞書ページ）を読んで中身を分ける。
 * 辞書ページは Column Chunk ごとに残し、同じ Chunk の別のページでは読み直さない（D53）。
 * まだ読んでいなければ、辞書ページとデータページが隣り合うとき 1 回の read にまとめる（D22 の合体と同じ方針）。
 */
export async function readPageContent(cache: PageCache, schema: SchemaElement[], chunk: ColumnChunkModel, pageIndex: number, compressors: Compressors): Promise<PageContent> {
  const pages = await cache.pages(chunk)
  const page = pages.pages[pageIndex]
  if (!page) throw new Error(`ページ #${pageIndex} がありません`)
  const where = `RG${chunk.rowGroup} ${chunk.column.name}`
  if (page.kind === 'data' && !isDictionaryEncoded(page)) return { kind: 'not-dictionary', encoding: page.header?.encoding ?? '?', hasDictionary: !!pages.dictionary }
  const dict = pages.dictionary
  if (!dict) throw new Error(`${where}: 辞書ページがありません`)
  const key = `${chunk.rowGroup}:${chunk.column.index}`
  const dictionaries = dictionariesOf(cache)
  const cached = dictionaries.get(key)
  const wants = [...(cached ? [] : [dict]), ...(page === dict ? [] : [page])]
  const bufs = await readCoalesced(
    cache.source,
    wants.map((p) => ({ range: p.range, purpose: `page-content ${where} #${p.index}（${p.kind === 'dictionary' ? '辞書ページ' : 'データページ'}）` })),
  )
  const decoder = columnDecoder(schema, chunk, compressors)
  const dictionary = cached ?? parseDictionary(new Uint8Array(bufs[0]), dict, decoder)
  dictionaries.set(key, dictionary)
  if (page === dict) return { kind: 'dictionary', dictionary }
  return { kind: 'data', dictionary, data: parseDataPage(new Uint8Array(bufs[bufs.length - 1]), page, decoder, dictionary) }
}

// PageCache はファイルを開き直すと作り直されるので、それに結び付けておけば辞書も一緒に捨てられる
const DICTIONARIES = new WeakMap<PageCache, Map<string, DictionaryContent>>()

function dictionariesOf(cache: PageCache): Map<string, DictionaryContent> {
  let m = DICTIONARIES.get(cache)
  if (!m) DICTIONARIES.set(cache, (m = new Map()))
  return m
}

interface Decoder {
  schemaPath: ReturnType<typeof getSchemaPath>
  element: SchemaElement
  type: ParquetType
  codec: CompressionCodec
  compressors: Compressors
}

function columnDecoder(schema: SchemaElement[], chunk: ColumnChunkModel, compressors: Compressors): Decoder {
  const meta = chunk.raw.meta_data
  if (!meta) throw new Error(`RG${chunk.rowGroup} ${chunk.column.name}: ColumnMetaData がありません`)
  const schemaPath = getSchemaPath(schema, chunk.column.path)
  return { schemaPath, element: schemaPath[schemaPath.length - 1].element, type: meta.type, codec: meta.codec, compressors }
}

/** ヘッダを除いたページ本体。ヘッダの長さはページ一覧を作るときに分かっている */
function bodyOf(buf: Uint8Array, p: PageModel): Uint8Array {
  const h = p.header
  if (!h) throw new Error(`ページ #${p.index} のヘッダがありません`)
  return buf.subarray(h.headerSize, h.headerSize + h.compressedSize)
}

function parseDictionary(buf: Uint8Array, p: PageModel, d: Decoder): DictionaryContent {
  const h = p.header!
  const body = decompressPage(bodyOf(buf, p), h.uncompressedSize, d.codec, d.compressors)
  const n = h.numValues ?? 0
  const raw = readPlain({ view: new DataView(body.buffer, body.byteOffset, body.byteLength), offset: 0 }, d.type, n, d.element.type_length)
  const plainSizes = Array.from(raw as ArrayLike<unknown>, (v) => plainSize(d.type, v, d.element.type_length))
  const values = Array.from(convert(raw, { ...d, pathInSchema: [], parsers: DEFAULT_PARSERS, utf8: true }) as ArrayLike<unknown>)
  return { values, plainSizes, bodySize: body.length }
}

function plainSize(type: string, v: unknown, typeLength?: number): number {
  switch (type) {
    case 'BYTE_ARRAY':
      return 4 + (v as Uint8Array).length
    case 'FIXED_LEN_BYTE_ARRAY':
      return typeLength ?? 0
    case 'INT32':
    case 'FLOAT':
      return 4
    case 'INT64':
    case 'DOUBLE':
      return 8
    case 'INT96':
      return 12
    // BOOLEAN は 1 ビットだが、辞書で符号化されることは無いので 1 バイトで数えておく
    default:
      return 1
  }
}

function parseDataPage(buf: Uint8Array, p: PageModel, d: Decoder, dict: DictionaryContent): DataPageContent {
  const h = p.header!
  const maxRep = getMaxRepetitionLevel(d.schemaPath)
  const maxDef = getMaxDefinitionLevel(d.schemaPath)
  const numValues = h.numValues ?? 0
  const sections: BodySection[] = []
  let body: Uint8Array
  let pos = 0
  let rep: number[] | undefined
  let def: number[] | undefined
  // 区切りの位置をページ本体の中の位置に直して section に付ける
  const levels = (kind: 'rep' | 'def', max: number, start: number, end: number) => {
    const r = decodeHybrid(body, start, end, bitWidthOf(max), numValues)
    sections.push({ kind, start, end, runs: r.runs })
    return r.values
  }
  if (h.type === 'DATA_PAGE_V2') {
    // v2: rep level → def level（どちらも圧縮されず長さの前置きも無い）→ 値（is_compressed なら圧縮）
    const raw = bodyOf(buf, p)
    const repLen = h.repLevelsByteLength ?? 0
    const defLen = h.defLevelsByteLength ?? 0
    const levelPart = raw.subarray(0, repLen + defLen)
    const valuePart = raw.subarray(repLen + defLen)
    const values = h.isCompressed === false ? valuePart : decompressPage(valuePart, h.uncompressedSize - repLen - defLen, d.codec, d.compressors)
    body = new Uint8Array(levelPart.length + values.length)
    body.set(levelPart)
    body.set(values, levelPart.length)
    if (maxRep > 0) rep = levels('rep', maxRep, 0, repLen)
    if (maxDef > 0) def = levels('def', maxDef, repLen, repLen + defLen)
    pos = repLen + defLen
  } else {
    // v1: ページ本体全体が圧縮されている。level は「4 バイトの長さ + hybrid」の形で rep → def の順
    body = decompressPage(bodyOf(buf, p), h.uncompressedSize, d.codec, d.compressors)
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
    const prefixed = (kind: 'rep' | 'def', max: number) => {
      const len = view.getUint32(pos, true)
      sections.push({ kind: 'length', start: pos, end: pos + 4 })
      const values = levels(kind, max, pos + 4, pos + 4 + len)
      pos += 4 + len
      return values
    }
    if (maxRep > 0) rep = prefixed('rep', maxRep)
    if (maxDef > 0) def = prefixed('def', maxDef)
  }
  const nonNull = def ? def.filter((v) => v === maxDef).length : numValues
  const bitWidth = body[pos]
  sections.push({ kind: 'bit-width', start: pos, end: pos + 1 })
  const idx = bitWidth === 0 ? { values: new Array<number>(nonNull).fill(0), runs: [], end: pos + 1 } : decodeHybrid(body, pos + 1, body.length, bitWidth, nonNull)
  sections.push({ kind: 'index', start: pos + 1, end: idx.end, runs: idx.runs })
  const entries: ValueEntry[] = []
  const firstRow = p.firstRow
  let row = (firstRow ?? 0) - 1
  let k = 0
  let plainBytes = 0
  for (let i = 0; i < numValues; i++) {
    const r = rep?.[i]
    // rep level 0 のところから次の行が始まる。rep level が無い列は 1 値 = 1 行
    if (r === undefined || r === 0) row++
    const df = def?.[i]
    const e: ValueEntry = { pos: i, row, rep: r, def: df }
    if (df === undefined || df === maxDef) {
      e.index = idx.values[k++]
      if (e.index >= dict.values.length) throw new Error(`index ${e.index} が辞書の件数 ${dict.values.length} を超えています（値 #${i}）`)
      plainBytes += dict.plainSizes[e.index]
    }
    entries.push(e)
  }
  const levelBytes = sections.filter((s) => s.kind === 'rep' || s.kind === 'def' || s.kind === 'length').reduce((a, s) => a + s.end - s.start, 0)
  return { encoding: h.encoding ?? '?', bodySize: body.length, sections, maxRep, maxDef, bitWidth, entries, rowsAbsolute: firstRow !== undefined, plainBytes, indexBytes: idx.end - pos, levelBytes }
}

