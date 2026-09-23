/**
 * 地図に表示できる CRS かどうかと、座標の単位を判定する。
 * MVP で地図に載せるのは経緯度（CRS84 / EPSG:4326）と Web メルカトル（EPSG:3857）だけ。それ以外は構造解析のみ行う。
 */
export type MapProjection = 'lonlat' | 'webmercator' | null

export interface CrsInfo {
  /** 表示用のラベル（例: "OGC:CRS84（省略時の既定）"） */
  label: string
  /**
   * crs 欄の状態。省略と null は仕様上意味が違うので区別する。
   * authority・srid は Parquet の論理型だけが使う表記（geo 側は PROJJSON か null だけ）
   */
  state: 'omitted' | 'null' | 'projjson' | 'authority' | 'srid' | 'other'
  /**
   * CRS の同一性を比べるための識別子（例: "EPSG:4326"、CRS 不明は "unknown"）。
   * PROJJSON に id が無いなど、比べようがないときは undefined
   */
  id?: string
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
    return { label: 'OGC:CRS84（crs 省略時の既定）', state: 'omitted', id: 'OGC:CRS84', mapProjection: 'lonlat', unit: '度（degree）', raw: undefined }
  }
  if (crs === null) {
    return { label: '不明（crs: null）', state: 'null', id: 'unknown', mapProjection: null, unit: '座標単位（CRS 不明）', raw: null }
  }
  if (crs && typeof crs === 'object') {
    const obj = crs as Record<string, unknown>
    const id = idOf(obj)
    const code = id ? `${id.authority}:${id.code}` : undefined
    const name = typeof obj.name === 'string' ? obj.name : undefined
    const label = [code, name].filter(Boolean).join(' ') || 'PROJJSON（識別子なし）'
    const known = code ? knownCrs(code) : undefined
    return { label, state: 'projjson', id: code?.toUpperCase(), mapProjection: known?.mapProjection ?? null, unit: known?.unit ?? unitOf(obj) ?? '座標単位（不明）', raw: crs }
  }
  return { label: String(crs), state: 'other', mapProjection: null, unit: '座標単位（不明）', raw: crs }
}

function knownCrs(code: string): { mapProjection: MapProjection; unit: string } | undefined {
  const upper = code.toUpperCase()
  if (upper === 'OGC:CRS84' || upper === 'EPSG:4326') return { mapProjection: 'lonlat', unit: '度（degree）' }
  if (upper === 'EPSG:3857') return { mapProjection: 'webmercator', unit: 'メートル（metre）' }
  return undefined
}

/**
 * Parquet の GEOMETRY / GEOGRAPHY 論理型の crs を解釈する（GeoParquet 2.0 では CRS の正はこちら：design.md D47）。
 * 表記は PROJJSON・authority:code・srid:<n>・projjson:<key>（key-value メタデータを指す）の 4 通りで、省略は OGC:CRS84。
 */
export function describeLogicalCrs(text: string | undefined, keyValue: { key: string; value?: string }[]): CrsInfo {
  if (text === undefined) return describeCrs(false, undefined)
  const t = text.trim()
  if (t.startsWith('{')) {
    try {
      return describeCrs(true, JSON.parse(t))
    } catch {
      return { label: `PROJJSON として読めません: ${t.slice(0, 40)}…`, state: 'other', mapProjection: null, unit: '座標単位（不明）', raw: t }
    }
  }
  const m = /^([^:]+):(.+)$/.exec(t)
  if (!m) return { label: t, state: 'other', mapProjection: null, unit: '座標単位（不明）', raw: t }
  const [, scheme, rest] = m
  if (scheme.toLowerCase() === 'projjson') {
    const entry = keyValue.find((kv) => kv.key === rest)
    if (!entry?.value) {
      return { label: `${t}（key-value メタデータに "${rest}" がありません）`, state: 'other', mapProjection: null, unit: '座標単位（不明）', raw: t }
    }
    try {
      const info = describeCrs(true, JSON.parse(entry.value))
      return { ...info, label: `${info.label}（${t} から参照）` }
    } catch {
      return { label: `${t}（参照先が PROJJSON として読めません）`, state: 'other', mapProjection: null, unit: '座標単位（不明）', raw: entry.value }
    }
  }
  if (scheme.toLowerCase() === 'srid') {
    // srid の番号の意味は仕様上は実装ごとだが、0 は CRS 不明（GeoPackage の慣習）。
    // 4326・3857 は EPSG の番号と同じ使われ方がほとんどなので、地図に載せる（D47）
    if (rest === '0') return { label: '不明（srid:0）', state: 'srid', id: 'unknown', mapProjection: null, unit: '座標単位（CRS 不明）', raw: t }
    const known = knownCrs(`EPSG:${rest}`)
    return {
      label: `${t}（EPSG:${rest} とみなす）`,
      state: 'srid',
      id: `EPSG:${rest}`,
      mapProjection: known?.mapProjection ?? null,
      unit: known?.unit ?? '座標単位（不明）',
      raw: t,
    }
  }
  const known = knownCrs(t)
  return { label: t, state: 'authority', id: t.toUpperCase(), mapProjection: known?.mapProjection ?? null, unit: known?.unit ?? '座標単位（不明）', raw: t }
}

/** OGC:CRS84 と EPSG:4326 は GeoParquet・Parquet の仕様で同じ CRS とみなす（軸の順だけが違う） */
const canonical = (id: string) => (id === 'EPSG:4326' ? 'OGC:CRS84' : id)

/** 2 つの CRS が同じか。どちらかの識別子が分からなければ undefined（比べられない） */
export function sameCrs(a: CrsInfo, b: CrsInfo): boolean | undefined {
  if (!a.id || !b.id) return undefined
  return canonical(a.id) === canonical(b.id)
}

const R = 6378137

/** EPSG:3857 のメートル座標を経度・緯度に変換する（MapLibre は経緯度で受け取るため） */
export function mercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / R) * (180 / Math.PI)
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)
  return [lon, lat]
}

// Web メルカトルは緯度 ±85.0511° までしか表せない（それ以上は y が発散する）
const MAX_MERCATOR_LAT = 85.0511287798

/** 経度・緯度を EPSG:3857 のメートル座標に変換する（地図の表示範囲を 3857 のデータと比べるため） */
export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const phi = (Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat)) * Math.PI) / 180
  return [(lon * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + phi / 2))]
}
