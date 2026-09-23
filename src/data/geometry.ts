import type { Geometry, Position } from 'geojson'
import { wkbToGeojson } from 'hyparquet/src/wkb.js'
import type { Bbox } from '../geo/bbox'
import { mercatorToLonLat, type MapProjection } from '../geo/crs'

/** WKB を GeoJSON のジオメトリにする。null（欠損値）や壊れた WKB は undefined */
export function parseWkb(v: unknown): Geometry | undefined {
  if (!(v instanceof Uint8Array) || v.byteLength < 5) return undefined
  try {
    return wkbToGeojson({ view: new DataView(v.buffer, v.byteOffset, v.byteLength), offset: 0 }) as Geometry
  } catch {
    return undefined
  }
}

function eachPosition(g: Geometry, f: (p: Position) => void) {
  switch (g.type) {
    case 'Point':
      return f(g.coordinates)
    case 'MultiPoint':
    case 'LineString':
      return g.coordinates.forEach(f)
    case 'MultiLineString':
    case 'Polygon':
      return g.coordinates.forEach((l) => l.forEach(f))
    case 'MultiPolygon':
      return g.coordinates.forEach((p) => p.forEach((l) => l.forEach(f)))
    case 'GeometryCollection':
      return g.geometries.forEach((c) => eachPosition(c, f))
  }
}

/** ジオメトリの bbox（データの CRS のまま）。行単位の判定（design.md D36）に使う */
export function geometryBbox(g: Geometry): Bbox | undefined {
  let b: Bbox | undefined
  eachPosition(g, ([x, y]) => {
    if (!b) b = [x, y, x, y]
    else {
      if (x < b[0]) b[0] = x
      if (y < b[1]) b[1] = y
      if (x > b[2]) b[2] = x
      if (y > b[3]) b[3] = y
    }
  })
  return b
}

function mapPositions(g: Geometry, f: (p: Position) => Position): Geometry {
  switch (g.type) {
    case 'Point':
      return { type: g.type, coordinates: f(g.coordinates) }
    case 'MultiPoint':
    case 'LineString':
      return { type: g.type, coordinates: g.coordinates.map(f) } as Geometry
    case 'MultiLineString':
    case 'Polygon':
      return { type: g.type, coordinates: g.coordinates.map((l) => l.map(f)) } as Geometry
    case 'MultiPolygon':
      return { type: g.type, coordinates: g.coordinates.map((p) => p.map((l) => l.map(f))) }
    case 'GeometryCollection':
      return { type: g.type, geometries: g.geometries.map((c) => mapPositions(c, f)) }
  }
}

/** 地図（経緯度）に載せる形にする。MapLibre は経緯度で受け取るため、3857 のデータは変換する */
export function toLonLatGeometry(g: Geometry, projection: MapProjection): Geometry | undefined {
  if (projection === 'lonlat') return g
  if (projection === 'webmercator') return mapPositions(g, ([x, y]) => mercatorToLonLat(x, y))
  return undefined
}
