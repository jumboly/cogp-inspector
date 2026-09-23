import { describeCrs, type CrsInfo } from './crs'

export interface CoveringBbox {
  /** 各値は Parquet の列パス（例: ["bbox", "xmin"]） */
  xmin: string[]
  ymin: string[]
  xmax: string[]
  ymax: string[]
}

export interface GeoColumnModel {
  name: string
  encoding?: string
  geometryTypes: string[]
  crs: CrsInfo
  edges?: string
  orientation?: string
  bbox?: number[]
  epoch?: number
  covering?: CoveringBbox
}

export interface GeoModel {
  version?: string
  primaryColumn?: string
  columns: GeoColumnModel[]
  primary?: GeoColumnModel
  /** key-value メタデータ geo の JSON をそのまま */
  raw: Record<string, unknown>
  /** 仕様上必須の項目の欠落など */
  problems: string[]
}

function asPath(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : undefined
}

function parseCovering(v: unknown): CoveringBbox | undefined {
  const bbox = (v as { bbox?: Record<string, unknown> } | undefined)?.bbox
  if (!bbox) return undefined
  const xmin = asPath(bbox.xmin)
  const ymin = asPath(bbox.ymin)
  const xmax = asPath(bbox.xmax)
  const ymax = asPath(bbox.ymax)
  return xmin && ymin && xmax && ymax ? { xmin, ymin, xmax, ymax } : undefined
}

/** key-value メタデータの `geo` を解析する。無ければ undefined（＝ GeoParquet ではない） */
export function parseGeoMetadata(keyValue: { key: string; value?: string }[]): GeoModel | undefined {
  const entry = keyValue.find((kv) => kv.key === 'geo')
  if (!entry?.value) return undefined
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(entry.value)
  } catch (e) {
    return { columns: [], raw: {}, problems: [`geo メタデータが JSON として読めません: ${(e as Error).message}`] }
  }
  const problems: string[] = []
  if (typeof raw.version !== 'string') problems.push('version（必須）がありません')
  if (typeof raw.primary_column !== 'string') problems.push('primary_column（必須）がありません')
  const colsRaw = (raw.columns ?? {}) as Record<string, Record<string, unknown>>
  if (!raw.columns) problems.push('columns（必須）がありません')

  const columns = Object.entries(colsRaw).map(
    ([name, c]): GeoColumnModel => ({
      name,
      encoding: typeof c.encoding === 'string' ? c.encoding : undefined,
      geometryTypes: Array.isArray(c.geometry_types) ? c.geometry_types.map(String) : [],
      crs: describeCrs('crs' in c, c.crs),
      edges: typeof c.edges === 'string' ? c.edges : undefined,
      orientation: typeof c.orientation === 'string' ? c.orientation : undefined,
      bbox: Array.isArray(c.bbox) ? c.bbox.map(Number) : undefined,
      epoch: typeof c.epoch === 'number' ? c.epoch : undefined,
      covering: parseCovering(c.covering),
    }),
  )
  const primaryColumn = typeof raw.primary_column === 'string' ? raw.primary_column : undefined
  const primary = columns.find((c) => c.name === primaryColumn)
  if (primaryColumn && !primary) problems.push(`primary_column "${primaryColumn}" が columns にありません`)
  return { version: raw.version as string | undefined, primaryColumn, columns, primary, raw, problems }
}
