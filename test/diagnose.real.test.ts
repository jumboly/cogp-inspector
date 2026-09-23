import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseLod } from '../src/cogp/lod'
import { diagnose, levelOverlaps, summarize } from '../src/diagnose/diagnose'
import { pageBboxesFromCache, pageBboxIndexWants } from '../src/geo/pageBbox'
import { inspect } from '../src/inspect'
import type { ReadRecord } from '../src/io/source'
import { TracedSource } from '../src/io/traced'
import { PageCache } from '../src/parquet/pages'
import { nodeFileSource } from './nodeSource'

const SAMPLE = new URL('../data/pois.cogp.parquet', import.meta.url).pathname

describe.skipIf(!existsSync(SAMPLE))('公式サンプルの診断', () => {
  it('Footer だけで判定し、MUST はすべて満たす。ページ境界は Index を読むまで未確認', async () => {
    const reads: ReadRecord[] = []
    const src = new TracedSource(nodeFileSource(SAMPLE), (r) => reads.push(r))
    const ins = await inspect(src)
    const cache = new PageCache(src, ins.file)
    const byCache = (rg: number) => {
      const pb = pageBboxesFromCache(cache, ins.file.rowGroups[rg], ins.geo)
      return pb.available ? pb : undefined
    }
    const before = reads.length
    const items = diagnose(ins, byCache)
    // 診断のために追加の read はしない（D15・D41）
    expect(reads.length).toBe(before)

    const byId = Object.fromEntries(items.map((i) => [i.id, i]))
    expect(items.filter((i) => i.group === 'must' && i.verdict === 'ng')).toEqual([])
    expect(byId['res-order'].verdict).toBe('ok')
    expect(byId['rows-once'].verdict).toBe('unknown')
    expect(byId['stats'].verdict).toBe('ok')
    expect(byId['covering'].verdict).toBe('ok')
    expect(byId['page-index'].verdict).toBe('ok')
    expect(byId['page-aligned'].verdict).toBe('unknown')
    expect(summarize(items).mustNg).toBe(0)

    // RG 0 の Page Index を読むと、その分だけページ境界を判定できる（cogp-rs は 4 列とも 2,048 行ごとに切る）
    await cache.loadIndexes(pageBboxIndexWants(ins.file.rowGroups[0], ins.geo))
    const after = diagnose(ins, byCache).find((i) => i.id === 'page-aligned')!
    expect(after.verdict).toBe('ok')
    expect(after.value).toContain('確認済み 1 / 468')
  })

  it('Level ごとの重なり係数を Row Group の統計から求める', async () => {
    const ins = await inspect(nodeFileSource(SAMPLE))
    const o = levelOverlaps(ins)
    expect(o).toHaveLength(ins.lod!.levels.length)
    // Row Group が 1 つだけの Level は、自分の範囲 ÷ 自分の範囲 = 1
    expect(o[0]).toMatchObject({ rowGroups: 1, withBbox: 1, coefficient: 1 })
    expect(o.every((x) => x.coefficient === undefined || x.coefficient > 0)).toBe(true)
  })

  it('lod が仕様違反なら、崩れた条件の項目だけが違反になる', async () => {
    const ins = await inspect(nodeFileSource(SAMPLE))
    const n = ins.file.rowGroups.length
    const raw = { ...ins.geo!.raw, lod: { levels: [{ row_group_end: 0, resolution: 1 }, { row_group_end: n - 2, resolution: 2 }] } }
    const broken = { ...ins, lod: parseLod({ ...ins.geo!, raw }, ins.file) }
    const items = diagnose(broken, () => undefined)
    const ng = items.filter((i) => i.verdict === 'ng').map((i) => i.id)
    expect(ng.sort()).toEqual(['res-order', 'rge-last'])
    expect(items.find((i) => i.id === 'lod-use')).toBeDefined()
    // SHOULD・目安の項目は MUST の違反に数えない
    expect(summarize(items).mustNg).toBe(2)
  })
})
