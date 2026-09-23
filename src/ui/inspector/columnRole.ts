import type { GeoModel } from '../../geo/geoMetadata'
import type { LeafColumn } from '../../parquet/model'

export type ColumnRole = 'geometry' | 'covering' | 'attribute'

/** ジオメトリ列・bbox covering 列・属性列を見分ける（UI で色分けし、空間検索に効く列を目立たせるため） */
export function columnRole(col: LeafColumn, geo: GeoModel | undefined): ColumnRole {
  if (!geo) return 'attribute'
  if (col.path.length === 1 && geo.columns.some((g) => g.name === col.path[0])) return 'geometry'
  const cov = geo.primary?.covering
  if (cov && [cov.xmin, cov.ymin, cov.xmax, cov.ymax].some((p) => p.join('.') === col.name)) return 'covering'
  return 'attribute'
}

export const ROLE_LABEL: Record<ColumnRole, string> = {
  geometry: 'geometry',
  covering: 'bbox covering',
  attribute: '属性',
}
