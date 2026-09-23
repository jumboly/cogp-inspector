import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspect } from '../src/inspect'
import type { ReadRecord } from '../src/io/source'
import { TracedSource } from '../src/io/traced'
import { PageCache } from '../src/parquet/pages'
import { nodeFileSource } from './nodeSource'

const SAMPLE = new URL('../data/pois.cogp.parquet', import.meta.url).pathname

describe.skipIf(!existsSync(SAMPLE))('公式サンプルのページ構造', () => {
  const setup = async () => {
    const reads: ReadRecord[] = []
    const src = new TracedSource(nodeFileSource(SAMPLE), (r) => reads.push(r))
    const ins = await inspect(src)
    reads.length = 0
    return { reads, ins, cache: new PageCache(src, ins.file) }
  }

  it('bbox.xmin は OffsetIndex から 23 ページ、各ヘッダ 22B・2,048 値（design.md §3.1 の実測と一致）', async () => {
    const { ins, cache } = await setup()
    const chunk = ins.file.rowGroups[2].columns.find((c) => c.column.name === 'bbox.xmin')!
    const p = await cache.pages(chunk)
    expect(p.locatedBy).toBe('offset-index')
    expect(p.dictionary).toBeUndefined()
    expect(p.pages).toHaveLength(23)
    expect(p.pages[0].header?.type).toBe('DATA_PAGE')
    expect(p.pages[0].header?.headerSize).toBe(22)
    expect(p.pages[0].header?.numValues).toBe(2048)
    // OffsetIndex のサイズ（ヘッダ込み）= ヘッダ長 + PageHeader の compressed_page_size（ヘッダ抜き）
    for (const pg of p.pages) expect(pg.range.end - pg.range.start).toBe(pg.header!.headerSize + pg.header!.compressedSize)
    expect(p.pages.at(-1)!.range.end).toBe(chunk.range.end)
    expect(p.pages.reduce((a, pg) => a + pg.rowCount!, 0)).toBe(ins.file.rowGroups[2].numRows)

    const ci = cache.columnIndex(chunk)!
    expect(ci.min).toHaveLength(23)
    expect(typeof ci.min[0]).toBe('number')
  })

  it('id 列の先頭は辞書ページ（OffsetIndex に載らない分を Column Chunk の先頭から補う）', async () => {
    const { ins, cache } = await setup()
    const chunk = ins.file.rowGroups[0].columns[0]
    const p = await cache.pages(chunk)
    expect(p.dictionary?.index).toBe(0)
    expect(p.dictionary?.header?.type).toBe('DICTIONARY_PAGE')
    // ヘッダ長は varint の桁数で変わる（RG0 は 19B、件数の多い RG2 は 20B）
    expect(p.dictionary?.header?.headerSize).toBe(19)
    expect(p.dictionary?.header?.numValues).toBe(8103)
    expect(p.dictionary?.range.end).toBe(p.pages[1].range.start)
  })

  it('OffsetIndex が無いものとしてヘッダを順にたどっても、同じページ列になる', async () => {
    const { ins, cache } = await setup()
    const chunk = ins.file.rowGroups[2].columns.find((c) => c.column.name === 'bbox.xmin')!
    const viaIndex = await cache.pages(chunk)
    const walked = await new PageCache(cache['source'], ins.file).pages({ ...chunk, offsetIndex: undefined, columnIndex: undefined })
    expect(walked.locatedBy).toBe('header-walk')
    expect(walked.pages.map((p) => p.range)).toEqual(viaIndex.pages.map((p) => p.range))
  })

  it('Index は一度読めばキャッシュされ、隣接するものは合体して読む', async () => {
    const { ins, cache, reads } = await setup()
    const chunks = ins.file.rowGroups[5].columns
    const first = await cache.loadIndexes(chunks.map((chunk) => ({ chunk, kind: 'offset' as const })))
    expect(first).toEqual({ fetched: 8, cached: 0 })
    // parquet-rs は同じ Row Group の OffsetIndex を列順に隙間なく書くので 1 回の read にまとまる
    expect(reads).toHaveLength(1)
    const again = await cache.loadIndexes(chunks.map((chunk) => ({ chunk, kind: 'offset' as const })))
    expect(again).toEqual({ fetched: 0, cached: 8 })
    expect(reads).toHaveLength(1)
  })
})
