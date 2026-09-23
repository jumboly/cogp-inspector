const BASE = ['', 'Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection']
const DIM = ['', ' Z', ' M', ' ZM']

/**
 * geospatial_statistics.geospatial_types の ISO WKB の型番号を、GeoParquet の geometry_types と同じ名前にする
 * （例: 1003 → "Polygon Z"）。2.0 では両者が一致する MUST があり、同じ表記にしておけば比べられるため
 */
export function wkbTypeName(code: number): string {
  const base = BASE[code % 1000]
  const dim = DIM[Math.floor(code / 1000)]
  return base && dim !== undefined ? `${base}${dim}` : `不明な型 ${code}`
}
