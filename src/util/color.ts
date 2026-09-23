// viridis の代表色。Level は「粗い → 細かい」の順序を持つ量なので、明度が単調に変わる連続配色で表す
const STOPS = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725']

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Level i（0..count-1）の色 */
export function levelColor(level: number, count: number): string {
  const t = count <= 1 ? 0 : level / (count - 1)
  const x = t * (STOPS.length - 1)
  const i = Math.min(Math.floor(x), STOPS.length - 2)
  const f = x - i
  const a = hexToRgb(STOPS[i])
  const b = hexToRgb(STOPS[i + 1])
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

/** Level を持たない（COGP でない）ファイルの Row Group の色 */
export const NEUTRAL = '#7a7a8c'
export const READ_COLOR = '#ff5a36'
export const SELECT_COLOR = '#ff2d95'
/** Access Simulator が推定した「読む予定」の範囲（実際に読んだ範囲の色と区別する） */
export const PLAN_COLOR = '#009e73'
/**
 * Expected vs Actual の照合（design.md D40）。予定どおりは「読む予定」と同じ緑にして上の段と対応が見えるようにし、
 * 予定外は読んだ範囲の赤・選択の桃色・geometry 列の橙・辞書ページの紫のどれとも区別できる黄色にする
 */
export const MATCH_COLOR = PLAN_COLOR
export const UNPLANNED_COLOR = '#f0e442'
