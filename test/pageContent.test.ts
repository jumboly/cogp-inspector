import { compressors } from 'hyparquet-compressors'
import { describe, expect, it } from 'vitest'
import { decodeChunk } from '../src/data/decodeChunk'
import { readPageContent, type DataPageContent, type DictionaryContent } from '../src/data/pageContent'
import { inspect } from '../src/inspect'
import type { ReadRecord } from '../src/io/source'
import { TracedSource } from '../src/io/traced'
import { PageCache } from '../src/parquet/pages'
import { nodeFileSource } from './nodeSource'

async function open(file: string) {
  const reads: ReadRecord[] = []
  // samples/ の公開サンプルか、test/fixtures/ の fixture（パスに / を含む）
  const path = file.includes('/') ? `./fixtures/${file}` : `../samples/${file}`
  const src = new TracedSource(nodeFileSource(new URL(path, import.meta.url).pathname), (r) => reads.push(r))
  const ins = await inspect(src)
  return { src, ins, cache: new PageCache(src, ins.file), reads }
}

type Opened = Awaited<ReturnType<typeof open>>

async function content(f: Opened, rg: number, name: string, page: number) {
  const chunk = f.ins.file.rowGroups[rg].columns.find((c) => c.column.name === name)!
  const pages = await f.cache.pages(chunk)
  f.reads.length = 0
  const c = await readPageContent(f.cache, f.ins.file.schema, chunk, page, compressors)
  return { chunk, pages, c }
}

/** 同じページを hyparquet の readColumn で decode した値（行ごと）。自作の分解と突き合わせる基準 */
async function hyparquetRows(f: Opened, rg: number, name: string, page: number) {
  const chunk = f.ins.file.rowGroups[rg].columns.find((c) => c.column.name === name)!
  const pages = await f.cache.pages(chunk)
  const want = [pages.dictionary!, pages.pages[page]]
  const bufs = await Promise.all(want.map((p) => f.src.read(p.range.start, p.range.end - p.range.start, 'test')))
  const joined = new Uint8Array(bufs.reduce((a, b) => a + b.byteLength, 0))
  let at = 0
  for (const b of bufs) {
    joined.set(new Uint8Array(b), at)
    at += b.byteLength
  }
  const p = pages.pages[page]
  return decodeChunk(f.ins.file.schema, chunk, joined, [{ start: p.firstRow!, end: p.firstRow! + p.rowCount! }], compressors).values
}

/** 自作の分解から行ごとの値を組み立てる。def level が最大でない値は「その行に値が無い（空の map）」 */
function rowsFrom(data: DataPageContent, dict: DictionaryContent): unknown[][] {
  const rows = new Map<number, unknown[]>()
  for (const e of data.entries) {
    const r = rows.get(e.row) ?? []
    if (e.index !== undefined) r.push(dict.values[e.index])
    rows.set(e.row, r)
  }
  return [...rows.values()]
}

describe('辞書ページとデータページの中身（D53〜D59）', () => {
  it('入れ子でない id 列: level は def だけ、index から引いた値が hyparquet と一致する', async () => {
    const f = await open('tokyo-id.parquet')
    const { c, pages } = await content(f, 0, 'id', 1)
    if (c.kind !== 'data') throw new Error(c.kind)
    expect(c.data.maxRep).toBe(0)
    expect(c.data.maxDef).toBe(1)
    expect(c.data.sections.map((s) => s.kind)).toEqual(['length', 'def', 'bit-width', 'index'])
    // 最後の区切りの後ろにバイトが余らない
    expect(c.data.sections.at(-1)!.end).toBe(c.data.bodySize)
    expect(c.data.entries).toHaveLength(pages.pages[1].rowCount!)
    const values = c.data.entries.map((e) => (e.index === undefined ? null : c.dictionary.values[e.index]))
    expect(values).toEqual(await hyparquetRows(f, 0, 'id', 1))
    // id はほぼ一意なので、辞書を使っても index の方が PLAIN より小さくなる程度にしか効かない
    expect(c.data.plainBytes).toBe(values.filter((v) => v !== null).length * 8)
  })

  it('入れ子の tags.key 列: rep level 0 で行が変わり、行ごとの値が hyparquet と一致する', async () => {
    const f = await open('tokyo-id.parquet')
    const { c, pages } = await content(f, 0, 'tags.key_value.key', 1)
    if (c.kind !== 'data') throw new Error(c.kind)
    expect(c.data.maxRep).toBe(1)
    expect(c.data.maxDef).toBe(2)
    expect(c.data.sections.map((s) => s.kind)).toEqual(['length', 'rep', 'length', 'def', 'bit-width', 'index'])
    const p = pages.pages[1]
    expect(c.data.entries[0].row).toBe(p.firstRow)
    expect(c.data.entries.at(-1)!.row).toBe(p.firstRow! + p.rowCount! - 1)
    // hyparquet は Map を「key_value の繰り返し」の 1 段を残して組み立てるので、平らにしてから比べる
    const expected = (await hyparquetRows(f, 0, 'tags.key_value.key', 1)) as (string[][] | undefined)[]
    expect(rowsFrom(c.data, c.dictionary)).toEqual(expected.map((r) => r?.flat() ?? []))
    // key は同じ値が何度も出るので、index は PLAIN の数分の 1 で済む
    expect(c.data.indexBytes * 3).toBeLessThan(c.data.plainBytes)
  })

  it('辞書ページとデータページが隣り合っていれば 1 回の read にまとめ、辞書は 2 回目から読まない', async () => {
    const f = await open('tokyo-id.parquet')
    const { pages } = await content(f, 0, 'id', 1)
    expect(f.reads).toHaveLength(1)
    expect(f.reads[0].length).toBe(pages.pages[1].range.end - pages.dictionary!.range.start)
    await content(f, 0, 'id', 2)
    expect(f.reads).toHaveLength(1)
    expect(f.reads[0].offset).toBe(pages.pages[2].range.start)
  })

  it('辞書ページだけを選んだときは辞書の一覧を返す', async () => {
    const f = await open('tokyo.cogp.parquet')
    const { c, pages } = await content(f, 27, 'tags.key_value.key', 0)
    if (c.kind !== 'dictionary') throw new Error(c.kind)
    expect(c.dictionary.values).toHaveLength(pages.dictionary!.header!.numValues!)
    expect(c.dictionary.values.every((v) => typeof v === 'string')).toBe(true)
    expect(new Set(c.dictionary.values).size).toBe(c.dictionary.values.length)
  })

  it('辞書で符号化されていないページは読まずに理由を返す', async () => {
    const f = await open('tokyo-id.parquet')
    const { c } = await content(f, 0, 'bbox.xmin', 0)
    expect(c).toEqual({ kind: 'not-dictionary', encoding: 'PLAIN', hasDictionary: false })
    expect(f.reads).toHaveLength(0)
  })

  // v2 のページと fallback は公開サンプルに無いので、make_dictionary.py で作った fixture で確かめる
  it.each(['dictionary/v2.parquet', 'dictionary/fallback.parquet'])('%s: 辞書で符号化された全ページで、値が hyparquet と一致する', async (file) => {
    const f = await open(file)
    const kinds = new Set<string>()
    let fallback = 0
    for (const chunk of f.ins.file.rowGroups[0].columns) {
      const pages = await f.cache.pages(chunk)
      for (const p of pages.pages) {
        if (p.kind !== 'data') continue
        kinds.add(p.header!.type)
        const c = await readPageContent(f.cache, f.ins.file.schema, chunk, p.index, compressors)
        if (c.kind === 'not-dictionary') {
          expect(c.hasDictionary).toBe(true)
          fallback++
          continue
        }
        if (c.kind !== 'data') throw new Error(c.kind)
        expect(c.data.sections.at(-1)!.end).toBe(c.data.bodySize)
        expect(new Set(c.data.entries.map((e) => e.row)).size).toBe(p.rowCount)
        // null の置き方は入れ子の組み立て方で変わるので、null でない値の並びで比べる
        const mine = c.data.entries.flatMap((e) => (e.index === undefined ? [] : [c.dictionary.values[e.index]]))
        const theirs = (await hyparquetRows(f, 0, chunk.column.name, p.index)).flat(3).filter((v) => v !== null && v !== undefined)
        expect(mine, `${chunk.column.name} #${p.index}`).toEqual(theirs)
      }
    }
    if (file.includes('v2')) expect([...kinds]).toEqual(['DATA_PAGE_V2'])
    else expect(fallback).toBeGreaterThan(0)
  })
})
