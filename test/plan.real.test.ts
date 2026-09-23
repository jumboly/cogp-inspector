import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspect } from '../src/inspect'
import type { ReadRecord } from '../src/io/source'
import { TracedSource } from '../src/io/traced'
import { PageCache } from '../src/parquet/pages'
import { defaultColumns, planAccess } from '../src/plan/accessPlan'
import { nodeFileSource } from './nodeSource'

const SAMPLE = new URL('../data/pois.cogp.parquet', import.meta.url).pathname

describe.skipIf(!existsSync(SAMPLE))('公式サンプルの Access Plan', () => {
  it('東京周辺を細かい縮尺で見ると、Level → Row Group → Page の順に絞られる', async () => {
    const reads: ReadRecord[] = []
    const src = new TracedSource(nodeFileSource(SAMPLE), (r) => reads.push(r))
    const ins = await inspect(src)
    reads.length = 0
    const cache = new PageCache(src, ins.file)
    const columns = defaultColumns(ins)
    expect(columns.map((c) => ins.file.leafColumns[c].name)).toEqual(['geometry', 'bbox.xmin', 'bbox.ymin', 'bbox.xmax', 'bbox.ymax'])

    const plan = await planAccess(ins, cache, { viewport: [[139.6, 35.6, 139.9, 35.8]], targetResolution: 0.0003, columns })
    const s = plan.stages
    expect(plan.level.used).toBe(true)
    expect(s.prefix.rowGroups).toBeLessThanOrEqual(s.file.rowGroups)
    expect(s.rowGroupPruned.rowGroups).toBeLessThan(s.prefix.rowGroups)
    expect(s.pages.rows).toBeLessThan(s.rowGroupPruned.rows)
    expect(s.pages.bytes).toBeLessThan(s.rowGroupPruned.bytes)
    expect(s.pages.bytes).toBeLessThan(s.pages.bytesAll)
    expect(s.requests.coalesced).toBeLessThanOrEqual(s.requests.logical)
    expect(s.requests.bytes).toBe(s.pages.bytes)
    // 読んだのは Page Index だけ（データページは推定のみで読まない）
    expect(reads.every((r) => /Index/.test(r.purpose))).toBe(true)
    expect(s.pageIndex.fetched).toBeGreaterThan(0)

    // 同じ範囲をもう一度計算すると、Index はすべてキャッシュから
    const again = await planAccess(ins, cache, plan.input)
    expect(again.stages.pageIndex.fetched).toBe(0)
    expect(again.requests).toEqual(plan.requests)
  })
})
