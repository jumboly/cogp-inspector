import { describe, expect, it } from 'vitest'
import { diagnose, fileOverlap, summarize } from '../src/diagnose/diagnose'
import { inspect, type Inspection } from '../src/inspect'
import { TracedSource } from '../src/io/traced'
import { PageCache } from '../src/parquet/pages'
import { defaultColumns, planAccess, type PlanInput } from '../src/plan/accessPlan'
import { addCost, incomparable, mapColumns, planCost, ZERO_COST } from '../src/plan/compareFiles'
import { SAMPLES, sampleOf } from '../src/samples'
import { nodeFileSource } from './nodeSource'

// 同梱サンプル（samples/）は Git に入っているので、公式サンプルと違い CI でも走る
async function open(file: string): Promise<{ ins: Inspection; cache: PageCache }> {
  const src = new TracedSource(nodeFileSource(new URL(`../samples/${file}`, import.meta.url).pathname), () => undefined)
  const ins = await inspect(src)
  return { ins, cache: new PageCache(src, ins.file) }
}

const openAll = async () => {
  const [id, hilbert, cogp, cogpV2] = await Promise.all(SAMPLES.map((s) => open(s.file)))
  return { id, hilbert, cogp, cogpV2 }
}

const plan = (f: { ins: Inspection; cache: PageCache }, view: Omit<PlanInput, 'columns'>) => planAccess(f.ins, f.cache, { ...view, columns: defaultColumns(f.ins) })

// 東京 23 区全体を見渡す縮尺と、渋谷駅付近まで拡大した縮尺
const OVERVIEW = { viewport: [[139.5, 35.5, 139.95, 35.85]], targetResolution: 0.0005 } satisfies Omit<PlanInput, 'columns'>
const SHIBUYA = { viewport: [[139.69, 35.65, 139.71, 35.665]], targetResolution: 0.00002 } satisfies Omit<PlanInput, 'columns'>

describe('同梱の比較用サンプル', () => {
  it('3 つとも同じ行数・同じ列で、COGP だけが lod を持つ（D43）', async () => {
    const { id, hilbert, cogp } = await openAll()
    expect(id.ins.file.numRows).toBe(hilbert.ins.file.numRows)
    expect(id.ins.file.numRows).toBe(cogp.ins.file.numRows)
    const names = (f: { ins: Inspection }) => f.ins.file.leafColumns.map((c) => c.name).sort()
    expect(names(hilbert)).toEqual(names(id))
    expect(names(cogp)).toEqual(names(id))
    expect(id.ins.lod).toBeUndefined()
    expect(hilbert.ins.lod).toBeUndefined()
    expect(cogp.ins.lod?.valid).toBe(true)
    for (const f of [id, hilbert, cogp]) {
      expect(f.ins.file.pageIndex).toBeTruthy()
      expect(f.ins.file.rowGroups.every((r) => r.numRows <= 8192)).toBe(true)
      expect(summarize(diagnose(f.ins, () => undefined)).mustNg).toBe(0)
      expect(f.ins.file.size).toBeLessThan(20 * 1024 * 1024)
    }
  })

  it('元の順は Row Group がどれもデータ全体を覆い、Hilbert 順は重なりがほとんど無い（D42）', async () => {
    const { id, hilbert } = await openAll()
    const n = id.ins.file.rowGroups.length
    expect(fileOverlap(id.ins).coefficient).toBeGreaterThan(n * 0.9)
    expect(fileOverlap(hilbert.ins).coefficient).toBeLessThan(1.5)
  })

  it('全体表示では COGP が最も少なく読み、拡大すると Hilbert 順が Row Group とページで絞れる', async () => {
    const { id, hilbert, cogp } = await openAll()
    const [io, ho, co] = await Promise.all([plan(id, OVERVIEW), plan(hilbert, OVERVIEW), plan(cogp, OVERVIEW)])
    // Level が無いと、全体表示では全行を読むしかない
    expect(io.stages.pages.rows).toBe(id.ins.file.numRows)
    expect(ho.stages.pages.rows).toBe(hilbert.ins.file.numRows)
    expect(co.level.used).toBe(true)
    expect(co.stages.requests.bytes * 5).toBeLessThan(ho.stages.requests.bytes)

    const [iz, hz, cz] = await Promise.all([plan(id, SHIBUYA), plan(hilbert, SHIBUYA), plan(cogp, SHIBUYA)])
    // 元の順はどの Row Group も表示範囲に掛かるので、拡大しても読み飛ばせない
    expect(iz.stages.rowGroupPruned.rowGroups).toBe(id.ins.file.rowGroups.length)
    expect(iz.stages.pages.rows).toBe(id.ins.file.numRows)
    expect(hz.stages.rowGroupPruned.rowGroups).toBeLessThan(5)
    expect(hz.stages.requests.bytes * 10).toBeLessThan(iz.stages.requests.bytes)
    // COGP は細かい Level ほど多くの Level の Row Group を読むので、拡大時は Hilbert 順より多く読む（仕様どおりの振る舞い）
    expect(cz.stages.requests.bytes).toBeGreaterThan(hz.stages.requests.bytes)
  })

  it('比較の補助: 列は名前で対応づけ、累計は計画ごとに足す（D44）', async () => {
    const { id, cogp } = await openAll()
    const cols = defaultColumns(cogp.ins)
    const mapped = mapColumns(cogp.ins, id.ins, cols)
    expect(mapped.missing).toEqual([])
    expect(mapped.columns.map((c) => id.ins.file.leafColumns[c].name).sort()).toEqual(cols.map((c) => cogp.ins.file.leafColumns[c].name).sort())
    expect(incomparable(cogp.ins, id.ins)).toBeUndefined()

    const p1 = await plan(cogp, OVERVIEW)
    const p2 = await plan(cogp, SHIBUYA)
    const total = addCost(addCost(ZERO_COST, p1), p2)
    expect(total.plans).toBe(2)
    expect(total.dataBytes).toBe(planCost(p1).dataBytes + planCost(p2).dataBytes)
    // 2 回目は 1 回目に読んだ Index をキャッシュから使うので、新たに読む Index には数えない
    expect(planCost(await plan(cogp, OVERVIEW)).indexRequests).toBe(0)
  })

  it('COGP（2.0）は GEOMETRY 論理型を使い、Level・Row Group・読む範囲の絞り込みは COGP と同じ（D49）', async () => {
    const { cogp, cogpV2 } = await openAll()
    const g = cogpV2.ins.geo!
    expect(g).toMatchObject({ hasGeo: true, version: '2.0.0', primary: { logical: { type: 'GEOMETRY' }, crs: { id: 'OGC:CRS84' } } })
    expect(cogpV2.ins.lod?.valid).toBe(true)
    // 圧縮後のバイト数は書き手（pyarrow と parquet-rs）で違うので、lod に書かれた値だけを比べる
    const lodOf = (f: typeof cogp) => f.ins.lod!.levels.map((l) => [l.resolution, l.rowGroupEnd])
    expect(lodOf(cogpV2)).toEqual(lodOf(cogp))
    expect(cogpV2.ins.file.rowGroups.map((r) => r.numRows)).toEqual(cogp.ins.file.rowGroups.map((r) => r.numRows))
    const v = Object.fromEntries(diagnose(cogpV2.ins, () => undefined).map((d) => [d.id, d.verdict]))
    expect(v).toMatchObject({ geoparquet: 'ok', 'geo2-crs': 'ok', 'geo2-types': 'ok', 'geo2-native': 'ok' })
    // Row Group の bbox は covering 列の統計を優先する（geospatial_statistics と同じ範囲になる）
    expect(cogpV2.ins.rowGroupBboxes.map((b) => b.bbox)).toEqual(cogp.ins.rowGroupBboxes.map((b) => b.bbox))
    for (const view of [OVERVIEW, SHIBUYA]) {
      const [a, b] = await Promise.all([plan(cogp, view), plan(cogpV2, view)])
      expect(b.level.level?.level).toBe(a.level.level?.level)
      expect(b.stages.rowGroupPruned.rowGroups).toBe(a.stages.rowGroupPruned.rowGroups)
      expect(b.stages.pages.rows).toBe(a.stages.pages.rows)
    }
  })

  it('URL・ファイル名から同梱サンプルを見分ける', () => {
    expect(sampleOf('https://www.jumboly.jp/cogp-inspector/samples/tokyo.cogp.parquet')?.id).toBe('cogp')
    expect(sampleOf('tokyo-id.parquet')?.id).toBe('id')
    expect(sampleOf('/samples/tokyo.cogp-v2.parquet')?.id).toBe('cogp-v2')
    expect(sampleOf('pois.cogp.parquet')).toBeUndefined()
  })
})
