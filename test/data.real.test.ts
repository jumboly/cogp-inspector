import { existsSync } from 'node:fs'
import { compressors } from 'hyparquet-compressors'
import { describe, expect, it } from 'vitest'
import { dataBlocker, readPlanData, type DataReadResult, type DecodedFeature } from '../src/data/readData'
import { inspect } from '../src/inspect'
import type { ReadRecord } from '../src/io/source'
import { TracedSource } from '../src/io/traced'
import { PageCache } from '../src/parquet/pages'
import { defaultColumns, planAccess } from '../src/plan/accessPlan'
import { nodeFileSource } from './nodeSource'

const SAMPLE = new URL('../data/pois.cogp.parquet', import.meta.url).pathname
const TOKYO = { viewport: [[139.6, 35.6, 139.9, 35.8]] as [number, number, number, number][], targetResolution: 0.0003 }

describe.skipIf(!existsSync(SAMPLE))('公式サンプルの実データ読み込み', () => {
  it('Access Plan の範囲だけを読み、geometry を decode して行ごとに表示範囲と比べる', async () => {
    const reads: ReadRecord[] = []
    const src = new TracedSource(nodeFileSource(SAMPLE), (r) => reads.push(r))
    const ins = await inspect(src)
    const cache = new PageCache(src, ins.file)
    const plan = await planAccess(ins, cache, { ...TOKYO, columns: defaultColumns(ins) })
    expect(dataBlocker(ins, plan)).toBeUndefined()
    reads.length = 0

    const features: DecodedFeature[] = []
    const res = await readPlanData(ins, src, plan, { compressors, onChunk: (f) => features.push(...f) })

    // 読んだのは計画どおりの Range だけ（Actual = Expected）
    expect(reads.map((r) => ({ start: r.offset, end: r.offset + r.length }))).toEqual(plan.requests)
    expect(reads.every((r) => r.purpose.startsWith('data '))).toBe(true)
    expect(res.bytes).toBe(plan.stages.requests.bytes)
    // decode した行 = 読んだページが覆う行。ページ単位で読むので、行範囲の合計（keptRows）以上になる
    expect(res.readRows).toBeGreaterThanOrEqual(plan.stages.pages.rows)
    expect(features.length + res.emptyRows).toBe(res.readRows)
    // ページ単位の pruning は保守的なので、範囲外の行も読む。範囲内の行は必ずある
    expect(res.inViewRows).toBeGreaterThan(0)
    expect(res.inViewRows).toBeLessThan(res.readRows)
    const inView = features.find((f) => f.inView)!
    expect(inView.geometry.type).toBe('Point')
    const [x, y] = (inView.geometry as GeoJSON.Point).coordinates
    expect(x).toBeGreaterThanOrEqual(139.6)
    expect(x).toBeLessThanOrEqual(139.9)
    expect(y).toBeGreaterThanOrEqual(35.6)
    expect(y).toBeLessThanOrEqual(35.8)
    // 行は Row Group が加わった Level で色分けする。選んだ Level 以下のはず
    expect(features.every((f) => f.level !== undefined && f.level <= plan.level.level!.level)).toBe(true)
  })

  it('geometry を読む列から外すと描けない、上限を超えると読まない', async () => {
    const src = nodeFileSource(SAMPLE)
    const ins = await inspect(src)
    const cache = new PageCache(src, ins.file)
    const noGeom = await planAccess(ins, cache, { ...TOKYO, columns: defaultColumns(ins).slice(1) })
    expect(dataBlocker(ins, noGeom)).toBe('geometry-not-selected')
    // 全列 × 全体表示（最も粗い Level ではなく、細かい縮尺で世界全体）は上限を超える
    const all = await planAccess(ins, cache, { viewport: [[-180, -85, 180, 85]], targetResolution: 0.00001, columns: ins.file.leafColumns.map((c) => c.index) })
    expect(dataBlocker(ins, all)).toBe('over-limit')
  })

  it('Range を読み終えるたびに進み具合を返し、粗い Level の行から先に出る', async () => {
    const src = nodeFileSource(SAMPLE)
    const ins = await inspect(src)
    const cache = new PageCache(src, ins.file)
    const plan = await planAccess(ins, cache, { ...TOKYO, columns: defaultColumns(ins) })
    const progress: DataReadResult[] = []
    const chunkLevels: number[] = []
    const res = await readPlanData(ins, src, plan, {
      compressors,
      onChunk: (f) => f.length && chunkLevels.push(f[0].level!),
      onProgress: (p) => progress.push(p),
    })
    // 1 Range ごとに 1 回。数は増える一方で、最後は最終結果と一致する
    expect(progress.map((p) => p.doneRequests)).toEqual(plan.requests.map((_, i) => i + 1))
    expect(progress.every((p, i) => i === 0 || (p.bytes >= progress[i - 1].bytes && p.readRows >= progress[i - 1].readRows))).toBe(true)
    expect(progress.at(-1)).toMatchObject({ requests: res.requests, doneRequests: res.requests, bytes: res.bytes, readRows: res.readRows, inViewRows: res.inViewRows })
    // COGP はファイル順が粗い Level → 細かい Level なので、最初に描けるのは最も粗い Level の行（design.md D38）
    expect(chunkLevels[0]).toBe(0)
    expect(chunkLevels.at(-1)).toBe(plan.level.level!.level)
  })

  it('中断すると、それ以降の read は投げない', async () => {
    const reads: ReadRecord[] = []
    const src = new TracedSource(nodeFileSource(SAMPLE), (r) => reads.push(r))
    const ins = await inspect(src)
    const cache = new PageCache(src, ins.file)
    const plan = await planAccess(ins, cache, { ...TOKYO, columns: defaultColumns(ins) })
    reads.length = 0
    const ac = new AbortController()
    let chunks = 0
    const p = readPlanData(ins, src, plan, {
      compressors,
      signal: ac.signal,
      onChunk: () => {
        if (++chunks === 1) ac.abort()
      },
    })
    await expect(p).rejects.toThrow()
    expect(reads.length).toBeLessThan(plan.requests.length)
  })
})
