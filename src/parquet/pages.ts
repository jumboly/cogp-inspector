import { mapLimit, readCoalesced, type RangeRequest } from '../io/coalesce'
import type { RandomAccessSource } from '../io/source'
import type { ByteRange, ColumnChunkModel, FileModel } from './model'
import { parseColumnIndex, parseOffsetIndex, schemaElementOf, type ColumnIndexModel, type OffsetIndexModel } from './pageIndex'
import { parsePageHeader, type PageHeaderModel } from './pageHeader'

export interface PageModel {
  /** Column Chunk 内での並び順（辞書ページがあれば 0 が辞書ページ） */
  index: number
  kind: 'dictionary' | 'data'
  /** ヘッダを含むページ全体の範囲 */
  range: ByteRange
  header?: PageHeaderModel
  /** OffsetIndex の何番目か（辞書ページは OffsetIndex に載らないので undefined） */
  locationIndex?: number
  /** Row Group 内の先頭行と行数（OffsetIndex か DATA_PAGE_V2 のヘッダから分かる場合のみ） */
  firstRow?: number
  rowCount?: number
}

export interface ChunkPages {
  /** ページの位置をどう知ったか。OffsetIndex が無いとヘッダを先頭から順にたどるしかない */
  locatedBy: 'offset-index' | 'header-walk'
  pages: PageModel[]
  dictionary?: PageModel
}

export type IndexKind = 'offset' | 'column'
const INDEX_LABEL: Record<IndexKind, string> = { offset: 'OffsetIndex', column: 'ColumnIndex' }

const key = (c: ColumnChunkModel) => `${c.rowGroup}:${c.column.index}`

// ヘッダは統計値が無ければ 20 バイト前後。最初は小さく読み、途中で切れていたら広げて読み直す
const HEADER_READ_STEPS = [64, 4096, 65536, 1 << 20]
// 1 Column Chunk あたり数十ページあるので、同時 read 数を抑える
const HEADER_CONCURRENCY = 8

/**
 * Page Index とページヘッダの読み込み口。一度読んだものは保持し、同じものを二度読まない。
 * Access Simulator で地図を動かすたびに、前に読んだ Row Group の Index を読み直さないため。
 */
export class PageCache {
  /** Access Plan どおりに実データを読むときも、同じ（記録付きの）source を使う */
  readonly source: RandomAccessSource
  private readonly file: FileModel
  private readonly offsetIndexes = new Map<string, OffsetIndexModel>()
  private readonly columnIndexes = new Map<string, ColumnIndexModel>()
  private readonly chunkPages = new Map<string, Promise<ChunkPages>>()
  /** 読み込み中の Index。同時に来た要求（ページ一覧と Page bbox など）で同じ範囲を二重に読まないため */
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(source: RandomAccessSource, file: FileModel) {
    this.source = source
    this.file = file
  }

  offsetIndex(c: ColumnChunkModel): OffsetIndexModel | undefined {
    return this.offsetIndexes.get(key(c))
  }

  columnIndex(c: ColumnChunkModel): ColumnIndexModel | undefined {
    return this.columnIndexes.get(key(c))
  }

  hasIndex(c: ColumnChunkModel, kind: IndexKind): boolean {
    return (kind === 'offset' ? this.offsetIndexes : this.columnIndexes).has(key(c))
  }

  /**
   * 指定した Index をまとめて読む。読み済み・ファイルに無いものは飛ばし、残りは隣接する範囲を合体して読む。
   * 戻り値は「新たに読んだ数」と「キャッシュにあった数」（Access Plan に表示するため）。
   */
  async loadIndexes(wants: { chunk: ColumnChunkModel; kind: IndexKind }[]): Promise<{ fetched: number; cached: number }> {
    let cached = 0
    const todo: { id: string; chunk: ColumnChunkModel; kind: IndexKind; req: RangeRequest }[] = []
    const waits: Promise<void>[] = []
    const seen = new Set<string>()
    for (const w of wants) {
      const range = w.kind === 'offset' ? w.chunk.offsetIndex : w.chunk.columnIndex
      const id = `${w.kind}:${key(w.chunk)}`
      if (!range || seen.has(id)) continue
      seen.add(id)
      const pending = this.inflight.get(id)
      if (this.hasIndex(w.chunk, w.kind) || pending) {
        if (pending) waits.push(pending)
        cached++
        continue
      }
      todo.push({ ...w, id, req: { range, purpose: `${INDEX_LABEL[w.kind]} RG${w.chunk.rowGroup} ${w.chunk.column.name}` } })
    }
    if (todo.length) {
      const job = readCoalesced(
        this.source,
        todo.map((t) => t.req),
      ).then((bufs) =>
        todo.forEach((t, i) => {
          if (t.kind === 'offset') {
            this.offsetIndexes.set(key(t.chunk), parseOffsetIndex(bufs[i], this.file.rowGroups[t.chunk.rowGroup].numRows))
          } else {
            const el = schemaElementOf(this.file.schema, t.chunk)
            if (el) this.columnIndexes.set(key(t.chunk), parseColumnIndex(bufs[i], el))
          }
        }),
      )
      const settled = job.finally(() => todo.forEach((t) => this.inflight.delete(t.id)))
      // 他の要求が待つのは「読み終わったか」だけ。失敗はこの呼び出し元に返し、待つ側は自分で読み直せるようにする
      todo.forEach((t) => this.inflight.set(t.id, settled.catch(() => undefined)))
      waits.push(settled)
    }
    await Promise.all(waits)
    return { fetched: todo.length, cached }
  }

  /** Column Chunk のページ一覧をヘッダ込みで作る（Column Chunk を選んだときに呼ぶ：design.md D16） */
  pages(c: ColumnChunkModel): Promise<ChunkPages> {
    const k = key(c)
    let p = this.chunkPages.get(k)
    if (!p) {
      p = this.buildPages(c)
      // 失敗を覚えておくと再試行できなくなるので、失敗したら捨てる
      p.catch(() => this.chunkPages.delete(k))
      this.chunkPages.set(k, p)
    }
    return p
  }

  private async buildPages(c: ColumnChunkModel): Promise<ChunkPages> {
    await this.loadIndexes([
      { chunk: c, kind: 'offset' },
      { chunk: c, kind: 'column' },
    ])
    const oi = this.offsetIndex(c)
    return oi ? this.pagesFromOffsetIndex(c, oi) : this.walkPages(c)
  }

  private async pagesFromOffsetIndex(c: ColumnChunkModel, oi: OffsetIndexModel): Promise<ChunkPages> {
    const pages: PageModel[] = []
    const firstData = oi.pages[0]?.offset ?? c.range.end
    // OffsetIndex に辞書ページは載らない。Column Chunk の先頭から最初のデータページまでの隙間が辞書ページ
    if (c.range.start < firstData) pages.push({ index: 0, kind: 'dictionary', range: { start: c.range.start, end: firstData } })
    oi.pages.forEach((loc, i) =>
      pages.push({
        index: pages.length,
        kind: 'data',
        range: { start: loc.offset, end: loc.offset + loc.compressedSize },
        locationIndex: i,
        firstRow: loc.firstRow,
        rowCount: loc.rowCount,
      }),
    )
    await mapLimit(pages, HEADER_CONCURRENCY, async (p) => {
      p.header = await this.readHeader(p.range.start, p.range.end, `page-header RG${c.rowGroup} ${c.column.name} #${p.index}`)
      if (p.header.type === 'DICTIONARY_PAGE') p.kind = 'dictionary'
    })
    return { locatedBy: 'offset-index', pages, dictionary: pages.find((p) => p.kind === 'dictionary') }
  }

  /** OffsetIndex が無いファイル: 次のページの位置は「今のヘッダ長 + ページ本体長」でしか分からないので、1 つずつ順に読む */
  private async walkPages(c: ColumnChunkModel): Promise<ChunkPages> {
    const pages: PageModel[] = []
    let pos = c.range.start
    let row = 0
    while (pos < c.range.end) {
      const header = await this.readHeader(pos, c.range.end, `page-header RG${c.rowGroup} ${c.column.name} #${pages.length}（順にたどる）`)
      const end = pos + header.headerSize + header.compressedSize
      const kind = header.type === 'DICTIONARY_PAGE' ? 'dictionary' : 'data'
      // v1 のヘッダには行数が無い（num_values は繰り返し列だと行数と一致しない）。行数が分かるのは v2 だけ
      const rows = header.numRows
      pages.push({ index: pages.length, kind, range: { start: pos, end }, header, firstRow: kind === 'data' && rows !== undefined ? row : undefined, rowCount: kind === 'data' ? rows : undefined })
      if (rows !== undefined) row += rows
      if (end <= pos) throw new Error(`RG${c.rowGroup} ${c.column.name}: ページサイズが不正です（位置 ${pos}）`)
      pos = end
    }
    return { locatedBy: 'header-walk', pages, dictionary: pages.find((p) => p.kind === 'dictionary') }
  }

  private async readHeader(offset: number, limit: number, purpose: string): Promise<PageHeaderModel> {
    for (const step of HEADER_READ_STEPS) {
      const len = Math.min(step, limit - offset, this.source.size - offset)
      const buf = await this.source.read(offset, len, purpose)
      try {
        return parsePageHeader(buf)
      } catch (e) {
        // 読んだ範囲でヘッダが切れていた。これ以上広げられなければあきらめる
        if (!(e instanceof RangeError) || len < step) throw e
      }
    }
    throw new Error(`${purpose}: ページヘッダが 1MiB を超えています`)
  }
}
