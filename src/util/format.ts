const units = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '-'
  let v = n
  let u = 0
  while (Math.abs(v) >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return u === 0 ? `${v} B` : `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[u]}`
}

export const formatNumber = (n: number) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '-')

export function formatPercent(part: number, whole: number): string {
  if (!whole) return '-'
  const p = (part / whole) * 100
  return `${p < 0.01 && p > 0 ? p.toExponential(1) : p.toFixed(p < 1 ? 3 : 1)} %`
}

export const formatRange = (r: { start: number; end: number }) => `${formatNumber(r.start)} – ${formatNumber(r.end - 1)}`

export function formatValue(v: unknown): string {
  if (v === undefined) return '-'
  if (v === null) return 'null'
  if (typeof v === 'number') return Number.isInteger(v) ? formatNumber(v) : String(v)
  if (typeof v === 'bigint') return formatNumber(Number(v))
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`
  if (v instanceof Date) return v.toISOString()
  const s = String(v)
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

/** hyparquet のメタデータには bigint と Uint8Array が混ざるので、そのままでは JSON.stringify できない */
export function toJsonText(v: unknown): string {
  return JSON.stringify(
    v,
    (_, x) => (typeof x === 'bigint' ? Number(x) : x instanceof Uint8Array ? `<${x.byteLength} bytes>` : x),
    2,
  )
}
