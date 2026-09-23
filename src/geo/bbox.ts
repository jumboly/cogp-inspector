import type { FileModel, RowGroupModel } from '../parquet/model'
import { mercatorToLonLat, type MapProjection } from './crs'
import type { GeoModel } from './geoMetadata'

export type Bbox = [xmin: number, ymin: number, xmax: number, ymax: number]

export interface RowGroupBbox {
  /** CRS の座標のままの bbox */
  bbox?: Bbox
  /** どこから求めたか。統計が無ければ none（＝ Row Group 単位で読み飛ばせない） */
  source: 'covering-stats' | 'geospatial-stats' | 'none'
  /** 求められなかった理由や注意 */
  note?: string
}

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i])

function statNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  return undefined
}

/**
 * Row Group の bbox を Footer の統計値だけから求める（ジオメトリ本体は読まない：design.md D4）。
 * 1. GeoParquet 1.1 の bbox covering 列の Row Group 統計（xmin の最小、ymin の最小、xmax の最大、ymax の最大）
 * 2. Parquet ネイティブの geospatial_statistics.bbox（GeoParquet 2.0）
 */
export function rowGroupBbox(rg: RowGroupModel, geo: GeoModel | undefined): RowGroupBbox {
  const primary = geo?.primary
  const cov = primary?.covering
  if (cov) {
    const find = (path: string[]) => rg.columns.find((c) => samePath(c.column.path, path))?.stats
    const xmin = statNumber(find(cov.xmin)?.min)
    const ymin = statNumber(find(cov.ymin)?.min)
    const xmax = statNumber(find(cov.xmax)?.max)
    const ymax = statNumber(find(cov.ymax)?.max)
    if ([xmin, ymin, xmax, ymax].every((v) => v !== undefined && Number.isFinite(v))) {
      return { bbox: [xmin!, ymin!, xmax!, ymax!], source: 'covering-stats' }
    }
  }
  if (primary) {
    const geomChunk = rg.columns.find((c) => c.column.path.length === 1 && c.column.path[0] === primary.name)
    const b = geomChunk?.raw.meta_data?.geospatial_statistics?.bbox
    if (b) return { bbox: [b.xmin, b.ymin, b.xmax, b.ymax], source: 'geospatial-stats' }
  }
  return {
    source: 'none',
    note: cov ? 'bbox covering 列に Row Group 統計がありません' : 'bbox covering も geospatial_statistics もありません',
  }
}

export function rowGroupBboxes(file: FileModel, geo: GeoModel | undefined): RowGroupBbox[] {
  return file.rowGroups.map((rg) => rowGroupBbox(rg, geo))
}

/**
 * 日付変更線をまたぐ bbox か。Parquet の Geospatial 仕様では X だけ xmin > xmax になり得て、
 * そのときは「x >= xmin または x <= xmax」と読む（design.md D48）
 */
export const wrapsX = (b: Bbox) => b[0] > b[2]

/**
 * 重なり判定のために、日付変更線をまたぐ bbox を 2 つに分ける。
 * 端を ±Infinity にするのは、「x >= xmin または x <= xmax」をそのまま表し、CRS の座標の範囲（±180 か ±20037508 か）に依らないため
 */
export function splitWrapped(b: Bbox): Bbox[] {
  return wrapsX(b) ? [[b[0], b[1], Infinity, b[3]], [-Infinity, b[1], b[2], b[3]]] : [b]
}

/** CRS の X 方向の一周の幅。日付変更線をまたぐ bbox の幅と面積を求めるのに使う。分からない CRS は undefined */
export function worldWidth(projection: MapProjection): number | undefined {
  if (projection === 'lonlat') return 360
  if (projection === 'webmercator') return 2 * 20037508.342789244
  return undefined
}

/**
 * 地図（経緯度）に載せる形へ変換する。載せられない CRS なら undefined。
 * 日付変更線をまたぐ bbox は xmax に 360 を足して返す。MapLibre は ±180 を超える経度を隣の世界として続けて描くので、
 * 1 つの矩形のまま日付変更線をまたいで描け、fitBounds・面積の計算もそのまま使えるため
 */
export function toLonLatBbox(b: Bbox, projection: MapProjection): Bbox | undefined {
  let out: Bbox
  if (projection === 'lonlat') out = [...b]
  else if (projection === 'webmercator') {
    const [x0, y0] = mercatorToLonLat(b[0], b[1])
    const [x1, y1] = mercatorToLonLat(b[2], b[3])
    out = [x0, y0, x1, y1]
  } else return undefined
  if (wrapsX(out)) out[2] += 360
  return out
}
