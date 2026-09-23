import { describe, expect, it } from 'vitest'
import { rowGroupBbox } from '../src/geo/bbox'
import { describeCrs, mercatorToLonLat } from '../src/geo/crs'
import { parseGeoMetadata } from '../src/geo/geoMetadata'
import type { RowGroupModel } from '../src/parquet/model'

const geoKv = (geo: unknown) => [{ key: 'geo', value: JSON.stringify(geo) }]

describe('describeCrs', () => {
  it('crs 省略は CRS84、null は不明として区別する', () => {
    expect(describeCrs(false, undefined)).toMatchObject({ state: 'omitted', mapProjection: 'lonlat' })
    expect(describeCrs(true, null)).toMatchObject({ state: 'null', mapProjection: null })
  })
  it('PROJJSON の id から地図に載せられるか判定する', () => {
    expect(describeCrs(true, { id: { authority: 'EPSG', code: 3857 } }).mapProjection).toBe('webmercator')
    expect(describeCrs(true, { id: { authority: 'EPSG', code: 6677 }, coordinate_system: { axis: [{ unit: 'metre' }] } })).toMatchObject({ mapProjection: null, unit: 'metre' })
  })
  it('Web メルカトルの原点と端を経緯度に戻せる', () => {
    expect(mercatorToLonLat(0, 0)).toEqual([0, 0])
    expect(mercatorToLonLat(20037508.342789244, 0)[0]).toBeCloseTo(180)
  })
})

describe('parseGeoMetadata', () => {
  it('geo が無ければ GeoParquet ではない', () => {
    expect(parseGeoMetadata([{ key: 'other', value: '{}' }])).toBeUndefined()
  })
  it('必須項目の欠落を報告する', () => {
    const g = parseGeoMetadata(geoKv({ columns: {} }))!
    expect(g.problems).toEqual(expect.arrayContaining(['version（必須）がありません', 'primary_column（必須）がありません']))
  })
})

function rg(stats: Record<string, [number, number]>, geospatial?: object): RowGroupModel {
  const columns = Object.entries(stats).map(([name, [min, max]]) => ({
    column: { path: name.split('.'), name },
    stats: { min, max, fromDeprecated: false },
    raw: { meta_data: {} },
  }))
  columns.push({ column: { path: ['geometry'], name: 'geometry' }, stats: undefined, raw: { meta_data: { geospatial_statistics: geospatial } } } as never)
  return { columns } as unknown as RowGroupModel
}

describe('rowGroupBbox', () => {
  const geo = parseGeoMetadata(
    geoKv({
      version: '1.1.0',
      primary_column: 'geometry',
      columns: { geometry: { encoding: 'WKB', covering: { bbox: { xmin: ['bbox', 'xmin'], ymin: ['bbox', 'ymin'], xmax: ['bbox', 'xmax'], ymax: ['bbox', 'ymax'] } } } },
    }),
  )
  it('covering 列の統計の min/max から組み立てる', () => {
    const b = rowGroupBbox(rg({ 'bbox.xmin': [1, 5], 'bbox.ymin': [2, 6], 'bbox.xmax': [3, 9], 'bbox.ymax': [4, 8] }), geo)
    expect(b).toEqual({ bbox: [1, 2, 9, 8], source: 'covering-stats' })
  })
  it('covering の統計が無ければ geospatial_statistics を使う', () => {
    const b = rowGroupBbox(rg({}, { bbox: { xmin: 10, ymin: 20, xmax: 30, ymax: 40 } }), geo)
    expect(b).toEqual({ bbox: [10, 20, 30, 40], source: 'geospatial-stats' })
  })
  it('どちらも無ければ不明とする（ジオメトリは読まない）', () => {
    expect(rowGroupBbox(rg({}), geo).source).toBe('none')
  })
})
