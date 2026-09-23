import type { FileModel } from '../parquet/model'
import { describeCrs, describeLogicalCrs, type CrsInfo } from './crs'

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
  /** 地図の投影と resolution の単位に使う CRS。論理型があれば論理型、無ければ geo の crs（design.md D47） */
  crs: CrsInfo
  /** geo メタデータの columns に載っているか（論理型だけの列は false） */
  inGeo: boolean
  /** geo メタデータ側の crs。列が geo に無ければ undefined */
  geoCrs?: CrsInfo
  /** Parquet ネイティブの GEOMETRY / GEOGRAPHY 論理型（GeoParquet 2.0）。無ければ undefined */
  logical?: { type: 'GEOMETRY' | 'GEOGRAPHY'; crsText?: string; algorithm?: string; crs: CrsInfo }
  edges?: string
  orientation?: string
  bbox?: number[]
  epoch?: number
  covering?: CoveringBbox
}

export interface GeoModel {
  /** key-value メタデータに geo があるか。false なら論理型だけから組み立てた（design.md D46） */
  hasGeo: boolean
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
    return { hasGeo: true, columns: [], raw: {}, problems: [`geo メタデータが JSON として読めません: ${(e as Error).message}`] }
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
      inGeo: true,
      geoCrs: describeCrs('crs' in c, c.crs),
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
  return { hasGeo: true, version: raw.version as string | undefined, primaryColumn, columns, primary, raw, problems }
}

/**
 * geo メタデータと Parquet ネイティブの GEOMETRY / GEOGRAPHY 論理型を合わせて GeoModel を作る。
 * どちらも無ければ undefined（＝ ジオメトリを持たない Parquet）。
 * geo が無く論理型だけのファイルは GeoParquet 2.0 に準拠しないが、2.0 の reader は読めるべきとされるので、
 * スキーマ上で最初の geometry 列を主ジオメトリ列として扱う（design.md D46）
 */
export function buildGeoModel(file: FileModel): GeoModel | undefined {
  const fromGeo = parseGeoMetadata(file.keyValue)
  // 仕様上 geometry 列はスキーマのルートに置くので、パスの長さ 1 の列だけを見る
  const natives = file.leafColumns.filter((c) => c.path.length === 1 && c.geoLogical)
  if (!fromGeo && !natives.length) return undefined
  const logicalOf = (name: string): GeoColumnModel['logical'] => {
    const g = natives.find((c) => c.path[0] === name)?.geoLogical
    return g && { type: g.type, crsText: g.crs, algorithm: g.algorithm, crs: describeLogicalCrs(g.crs, file.keyValue) }
  }
  const columns: GeoColumnModel[] = (fromGeo?.columns ?? []).map((c) => {
    const logical = logicalOf(c.name)
    return logical ? { ...c, logical, crs: logical.crs } : c
  })
  for (const n of natives) {
    if (columns.some((c) => c.name === n.path[0])) continue
    const logical = logicalOf(n.path[0])!
    // 論理型の値は WKB と決まっている（Parquet の Geospatial 仕様）
    columns.push({ name: n.path[0], encoding: 'WKB', geometryTypes: [], crs: logical.crs, inGeo: false, logical })
  }
  const primaryColumn = fromGeo ? fromGeo.primaryColumn : columns[0].name
  return {
    hasGeo: !!fromGeo,
    version: fromGeo?.version,
    primaryColumn,
    columns,
    primary: columns.find((c) => c.name === primaryColumn),
    raw: fromGeo?.raw ?? {},
    problems: fromGeo?.problems ?? [],
  }
}
