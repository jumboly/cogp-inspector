/**
 * 地図に表示できる CRS かどうかと、座標の単位を判定する。
 * MVP で地図に載せるのは経緯度（CRS84 / EPSG:4326）と Web メルカトル（EPSG:3857）だけ。それ以外は構造解析のみ行う。
 */
export type MapProjection = 'lonlat' | 'webmercator' | null

export interface CrsInfo {
  /** 表示用のラベル（例: "OGC:CRS84（省略時の既定）"） */
  label: string
  /** GeoParquet の crs 欄の状態。省略と null は仕様上意味が違うので区別する */
  state: 'omitted' | 'null' | 'projjson' | 'other'
  mapProjection: MapProjection
  /** resolution の単位の表示名 */
  unit: string
  raw: unknown
}

interface ProjId {
  authority?: string
  code?: string | number
}

function idOf(crs: Record<string, unknown>): ProjId | undefined {
  const id = (crs.id ?? (Array.isArray(crs.ids) ? crs.ids[0] : undefined)) as ProjId | undefined
  return id && typeof id === 'object' ? id : undefined
}

function unitOf(crs: Record<string, unknown>): string | undefined {
  // PROJJSON の座標系の最初の軸の単位を採用する（水平方向の単位として）
  const cs = crs.coordinate_system as { axis?: { unit?: unknown }[] } | undefined
  const unit = cs?.axis?.[0]?.unit
  if (typeof unit === 'string') return unit
  if (unit && typeof unit === 'object' && 'name' in unit) return String((unit as { name: unknown }).name)
  return undefined
}

export function describeCrs(hasKey: boolean, crs: unknown): CrsInfo {
  if (!hasKey) {
    return { label: 'OGC:CRS84（crs 省略時の既定）', state: 'omitted', mapProjection: 'lonlat', unit: '度（degree）', raw: undefined }
  }
  if (crs === null) {
    return { label: '不明（crs: null）', state: 'null', mapProjection: null, unit: '座標単位（CRS 不明）', raw: null }
  }
  if (crs && typeof crs === 'object') {
    const obj = crs as Record<string, unknown>
    const id = idOf(obj)
    const code = id ? `${id.authority}:${id.code}` : undefined
    const name = typeof obj.name === 'string' ? obj.name : undefined
    const label = [code, name].filter(Boolean).join(' ') || 'PROJJSON（識別子なし）'
    const upper = code?.toUpperCase()
    if (upper === 'OGC:CRS84' || upper === 'EPSG:4326') {
      return { label, state: 'projjson', mapProjection: 'lonlat', unit: '度（degree）', raw: crs }
    }
    if (upper === 'EPSG:3857') {
      return { label, state: 'projjson', mapProjection: 'webmercator', unit: 'メートル（metre）', raw: crs }
    }
    return { label, state: 'projjson', mapProjection: null, unit: unitOf(obj) ?? '座標単位（不明）', raw: crs }
  }
  return { label: String(crs), state: 'other', mapProjection: null, unit: '座標単位（不明）', raw: crs }
}

const R = 6378137

/** EPSG:3857 のメートル座標を経度・緯度に変換する（MapLibre は経緯度で受け取るため） */
export function mercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / R) * (180 / Math.PI)
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)
  return [lon, lat]
}
