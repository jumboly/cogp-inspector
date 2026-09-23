import type { Inspection } from '../../inspect'
import { useStore } from '../../state/store'
import { formatNumber } from '../../util/format'
import { KV } from '../common/KV'

/**
 * Row Group の中を、bbox covering 列の ColumnIndex でページ単位に区切った空間範囲。
 * Row Group の bbox より細かく読み飛ばせる（＝ Page Index が何を改善するか）ことを見せる。
 */
export function PageBboxSection({ ins, rg }: { ins: Inspection; rg: number }) {
  const state = useStore((s) => s.pageBboxes[rg])
  const setHoverSpan = useStore((s) => s.setHoverSpan)
  if (!ins.geo?.primary?.covering) return null
  return (
    <>
      <h4>Page bbox（Page Index から）</h4>
      {!state || state.status === 'loading' ? (
        <p className="muted">bbox covering 列の OffsetIndex と ColumnIndex を読み込み中…</p>
      ) : state.status === 'error' ? (
        <p className="warn">読めませんでした: {state.error}</p>
      ) : !state.data.available ? (
        <p className="muted">{state.data.reason}。この Row Group はページ単位では読み飛ばせません。</p>
      ) : (
        <>
          <KV
            rows={[
              ['行範囲の数', formatNumber(state.data.spans.length), 'bbox covering 4 列のページ境界で行を区切った数'],
              [
                '4 列のページ境界',
                state.data.aligned ? 'そろっている' : 'ずれている',
                state.data.aligned
                  ? '1 ページ = 1 つの bbox。行範囲はそのまま各列のページに対応する'
                  : '列ごとにページの切れ目が違うため、すべての切れ目で区切った。bbox は重なる各列のページの値から求めたので、実際より広めになりうる',
              ],
              ['bbox が求められない範囲', formatNumber(state.data.spans.filter((s) => !s.bbox).length), '値がすべて null のページなど。読み飛ばさず必ず読む扱いにする'],
            ]}
          />
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>行（Row Group 内）</th>
                <th>bbox（xmin, ymin, xmax, ymax）</th>
              </tr>
            </thead>
            <tbody onMouseLeave={() => setHoverSpan(null)}>
              {state.data.spans.map((s, i) => (
                <tr key={i} onMouseEnter={() => setHoverSpan({ rg, span: i })}>
                  <td>{i}</td>
                  <td>
                    {formatNumber(s.rows.start)}–{formatNumber(s.rows.end - 1)}
                  </td>
                  <td className="mono">{s.bbox ? s.bbox.map((v) => v.toFixed(3)).join(', ') : '不明'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">行にマウスを重ねると、地図でその範囲を強調します。</p>
        </>
      )}
    </>
  )
}
