import { compressors } from 'hyparquet-compressors'
import { describe, expect, it } from 'vitest'
import { readPlanData, type DecodedFeature } from '../src/data/readData'
import { fileOverlap } from '../src/diagnose/diagnose'
import { toLonLatBbox, type Bbox } from '../src/geo/bbox'
import { describeLogicalCrs, sameCrs } from '../src/geo/crs'
import { wkbTypeName } from '../src/geo/geometryTypes'
import { intersects } from '../src/geo/pageBbox'
import { fileKind, inspect, type Inspection } from '../src/inspect'
import { TracedSource } from '../src/io/traced'
import { PageCache } from '../src/parquet/pages'
import { defaultColumns, planAccess } from '../src/plan/accessPlan'
import { nodeFileSource } from './nodeSource'

// GeoParquet 2.0 / Parquet ネイティブ GEOMETRY 型の小さな公開ファイル（test/fixtures/geo2/README.md）
const fixture = (name: string) => new URL(`./fixtures/geo2/${name}`, import.meta.url).pathname
const open = async (name: string) => {
  const src = new TracedSource(nodeFileSource(fixture(name)), () => undefined)
  return { src, ins: await inspect(src) }
}

describe('describeLogicalCrs（論理型の crs の 4 通りの表記）', () => {
  it('省略は OGC:CRS84、authority:code はそのまま識別子にする', () => {
    expect(describeLogicalCrs(undefined, [])).toMatchObject({ state: 'omitted', id: 'OGC:CRS84', mapProjection: 'lonlat' })
    expect(describeLogicalCrs('EPSG:3857', [])).toMatchObject({ state: 'authority', id: 'EPSG:3857', mapProjection: 'webmercator' })
  })
  it('srid:0 は CRS 不明、ほかの srid は EPSG の番号とみなす（D47）', () => {
    expect(describeLogicalCrs('srid:0', [])).toMatchObject({ id: 'unknown', mapProjection: null })
    expect(describeLogicalCrs('srid:4326', [])).toMatchObject({ id: 'EPSG:4326', mapProjection: 'lonlat' })
  })
  it('projjson:<key> は key-value メタデータを引き、無ければその旨を出す', () => {
    const kv = [{ key: 'k', value: JSON.stringify({ name: 'WGS 84', id: { authority: 'EPSG', code: 4326 } }) }]
    expect(describeLogicalCrs('projjson:k', kv)).toMatchObject({ state: 'projjson', id: 'EPSG:4326', mapProjection: 'lonlat' })
    expect(describeLogicalCrs('projjson:none', kv).label).toContain('"none" がありません')
  })
  it('OGC:CRS84 と EPSG:4326 は同じ CRS、識別子が無ければ比べられない', () => {
    expect(sameCrs(describeLogicalCrs('EPSG:4326', []), describeLogicalCrs(undefined, []))).toBe(true)
    expect(sameCrs(describeLogicalCrs('EPSG:3857', []), describeLogicalCrs(undefined, []))).toBe(false)
    expect(sameCrs(describeLogicalCrs('{"name":"x"}', []), describeLogicalCrs(undefined, []))).toBeUndefined()
  })
})

describe('wkbTypeName', () => {
  it('ISO WKB の番号を GeoParquet の geometry_types の名前にする', () => {
    expect([1, 6, 1003, 2002, 3007].map(wkbTypeName)).toEqual(['Point', 'MultiPolygon', 'Polygon Z', 'LineString M', 'GeometryCollection ZM'])
  })
})

describe('GeoParquet 2.0 の実ファイル', () => {
  it('geo と論理型の両方を持つファイルは、論理型の crs を使い geo の crs も残す（D47）', async () => {
    const { ins } = await open('geoparquet-example.parquet')
    const g = ins.geo!
    expect(g).toMatchObject({ hasGeo: true, version: '2.0.0', primaryColumn: 'geometry' })
    expect(g.primary).toMatchObject({ inGeo: true, logical: { type: 'GEOMETRY' }, crs: { id: 'OGC:CRS84' } })
    expect(sameCrs(g.primary!.crs, g.primary!.geoCrs!)).toBe(true)
    expect(fileKind(ins)).toBe('GeoParquet')
    expect(ins.rowGroupBboxes[0]).toMatchObject({ source: 'geospatial-stats' })
  })

  it('geo が無ければ論理型から組み立て、最初の geometry 列を主ジオメトリ列にする（D46）', async () => {
    const { ins } = await open('crs-default.parquet')
    expect(ins.geo).toMatchObject({ hasGeo: false, primaryColumn: 'geometry', primary: { inGeo: false, encoding: 'WKB', crs: { mapProjection: 'lonlat' } } })
    expect(fileKind(ins)).toBe('GeoParquet（geo なし）')
    expect(ins.rowGroupBboxes[0]).toEqual({ bbox: [-111, 41, -104, 45], source: 'geospatial-stats' })
    expect(ins.lod).toBeUndefined()
  })

  it('srid・projjson:<key>・PROJJSON 埋め込みのどれでも同じ CRS として読む', async () => {
    const labels = await Promise.all(['crs-srid.parquet', 'crs-projjson.parquet', 'crs-arbitrary-value.parquet'].map(async (f) => (await open(f)).ins.geo!.primary!.crs))
    // srid:5070 は EPSG:5070 とみなす。projjson の 2 つは PROJJSON に id が無いので名前で出る
    expect(labels[0]).toMatchObject({ id: 'EPSG:5070', mapProjection: null })
    expect(labels[1].label).toContain('NAD83 / Conus Albers')
    expect(labels[1].label).toContain('projjson:projjson_epsg_5070')
    expect(labels[2].label).toContain('NAD83 / Conus Albers')
  })

  it('GEOGRAPHY の algorithm を持ち、Row Group ごとに geospatial_statistics の bbox を使う', async () => {
    const { ins } = await open('geography-polygons.parquet')
    expect(ins.geo!.primary!.logical).toMatchObject({ type: 'GEOGRAPHY', algorithm: 'SPHERICAL' })
    expect(ins.file.rowGroups).toHaveLength(50)
    expect(ins.rowGroupBboxes.every((b) => b.source === 'geospatial-stats')).toBe(true)
  })

  it('論理型の geometry 列も WKB のまま decode して描ける', async () => {
    const { src, ins } = await open('crs-default.parquet')
    const cache = new PageCache(src, ins.file)
    const plan = await planAccess(ins, cache, { viewport: [[-112, 40, -103, 46]], targetResolution: 0.01, columns: defaultColumns(ins) })
    const features: DecodedFeature[] = []
    const res = await readPlanData(ins, src, plan, { compressors, onChunk: (f) => features.push(...f) })
    expect(res.readRows).toBeGreaterThan(0)
    expect(res.emptyRows).toBe(0)
    expect(features[0].geometry.type).toBe('Polygon')
  })
})

describe('日付変更線をまたぐ bbox（xmin > xmax、D48）', () => {
  // 東経 170° から西経 170° まで（日付変更線をはさんで 20° 幅）
  const wrapped: Bbox = [170, -10, -170, 10]

  it('どちら側の表示範囲とも重なり、反対側の地域とは重ならない', () => {
    expect(intersects(wrapped, [175, 0, 180, 5])).toBe(true)
    expect(intersects(wrapped, [-180, 0, -175, 5])).toBe(true)
    expect(intersects(wrapped, [0, 0, 10, 5])).toBe(false)
    // 両方がまたいでいれば、日付変更線の上で必ず重なる
    expect(intersects(wrapped, [179, 0, -179, 5])).toBe(true)
  })

  it('地図用には xmax に 360 を足し、1 つの矩形として日付変更線をまたいで描く', () => {
    expect(toLonLatBbox(wrapped, 'lonlat')).toEqual([170, -10, 190, 10])
    expect(toLonLatBbox([10, 0, 20, 5], 'lonlat')).toEqual([10, 0, 20, 5])
  })

  it('重なり係数は一周分ずらした幅（20°）で面積を求める', () => {
    const ins = {
      file: { rowGroups: [{}, {}] },
      geo: { primary: { crs: { mapProjection: 'lonlat' } } },
      rowGroupBboxes: [
        { bbox: wrapped, source: 'geospatial-stats' },
        { bbox: [170, -10, 180, 10], source: 'geospatial-stats' },
      ],
    } as unknown as Inspection
    // 面積の合計 20×20 + 10×20 = 600、合わせた範囲 20×20 = 400
    expect(fileOverlap(ins).coefficient).toBeCloseTo(1.5)
  })
})
