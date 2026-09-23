import type { ReactNode } from 'react'
import type { ReadKind } from '../../plan/compare'
import { usePlanComparison } from '../../state/planComparison'
import { useStore } from '../../state/store'
import { formatBytes, formatNumber } from '../../util/format'

const KIND_LABEL: Record<ReadKind, string> = { index: 'Page Index', data: 'データページ' }
// 一覧が長くなると funnel が画面外に押し出されるので、ずれた read は先頭だけ出す
const MAX_LISTED = 20

/**
 * Expected vs Actual（design.md D39・D40）。funnel の推定と、同じ計画で実際に起きた read を並べる。
 * 自前で読むので通常は一致する。一致しないときは、ずれた read を一覧にして理由を読めるようにする。
 */
export function PlanComparisonView() {
  const cmp = usePlanComparison()
  const data = useStore((s) => s.data)
  const select = useStore((s) => s.select)
  const running = useStore((s) => s.simulator.status === 'running')
  if (!cmp) return null
  const { expected: e, actual: a } = cmp
  // 再計算中は前の計画の読み込みを中断済みなので、「読み込み中」ではなく古い値として見せる
  const reading = !running && data.enabled && data.status === 'reading'
  const noData = !cmp.dataCompared
  const noDataNote = !data.enabled ? '「実データを読む」が OFF' : '読まない判定'

  const rows: { label: ReactNode; exp: ReactNode; act: ReactNode; diff: ReactNode }[] = [
    { label: 'Range Request（Page Index）', exp: formatNumber(e.index.requests), act: formatNumber(a.index.requests), diff: diff(a.index.requests - e.index.requests, formatNumber) },
    { label: 'バイト数（Page Index）', exp: formatBytes(e.index.bytes), act: formatBytes(a.index.bytes), diff: diff(a.index.bytes - e.index.bytes, formatBytes) },
    noData
      ? { label: 'Range Request（データページ）', exp: formatNumber(e.data.requests), act: `-（${noDataNote}）`, diff: '-' }
      : { label: 'Range Request（データページ）', exp: formatNumber(e.data.requests), act: formatNumber(a.data.requests), diff: diff(a.data.requests - e.data.requests, formatNumber) },
    noData
      ? { label: 'バイト数（データページ）', exp: formatBytes(e.data.bytes), act: '-', diff: '-' }
      : { label: 'バイト数（データページ）', exp: formatBytes(e.data.bytes), act: formatBytes(a.data.bytes), diff: diff(a.data.bytes - e.data.bytes, formatBytes) },
  ]
  const r = data.result
  if (!noData && r) {
    rows.push(
      { label: 'decode した行', exp: formatNumber(cmp.expectedRows), act: formatNumber(r.readRows), diff: diff(r.readRows - cmp.expectedRows, formatNumber) },
      // 範囲内かどうかはジオメトリを decode して初めて分かるので、Expected は無い
      { label: '範囲内の行', exp: '-', act: formatNumber(r.inViewRows), diff: '-' },
    )
  }
  // 推定では時間を見積もらないので Actual だけ。Page Index を読み終えてからデータを読むので、2 つは順に続く
  rows.push({ label: '所要時間（Page Index）', exp: '-', act: a.index.ms === undefined ? '-' : `${Math.round(a.index.ms)} ms`, diff: '-' })
  if (!noData) rows.push({ label: '所要時間（データページ）', exp: '-', act: a.data.ms === undefined ? '-' : `${Math.round(a.data.ms)} ms`, diff: '-' })

  const count = (m: 'planned' | 'unplanned' | 'failed') => cmp.reads.filter((c) => c.match === m).length
  const planned = count('planned')
  const unplanned = count('unplanned')
  const failed = count('failed')
  const off = cmp.reads.filter((c) => c.match !== 'planned')
  const listed = off.slice(0, MAX_LISTED)
  const hidden = off.length - listed.length
  // 未読は理由がどれも同じ（読む前に止めた・失敗した）なので、1 行にまとめる。
  // 読み込み中の未読は「まだ読んでいない」だけなので出さない（行が出たり消えたりして読みにくいため）
  const unreadBytes = cmp.unread.reduce((acc, u) => acc + u.range.end - u.range.start, 0)
  const showUnread = !reading && cmp.unread.length > 0

  return (
    <>
      <h4>
        Expected vs Actual（推定と実測・この計画）
        {running ? <span className="muted">（地図が動いたので再計算中。前の計画の値）</span> : reading && <span className="muted">（読み込み中。途中までの値）</span>}
      </h4>
      <table className={`table compare${running ? ' stale' : ''}`}>
        <thead>
          <tr>
            <th>項目</th>
            <th>Expected</th>
            <th>Actual</th>
            <th>差</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>{row.label}</td>
              <td>{row.exp}</td>
              <td>{row.act}</td>
              <td>{row.diff}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        read の照合: <span className="match-planned">予定どおり {formatNumber(planned)}</span> ・ <span className="match-unplanned">予定外 {formatNumber(unplanned)}</span> ・{' '}
        <span className="match-unread">
          未読 {formatNumber(cmp.unread.length)}
          {reading && '（まだ読んでいない分を含む）'}
        </span>
        {failed > 0 && `（中断・失敗した read ${formatNumber(failed)}）`}
      </p>
      {listed.length === 0 && !showUnread ? (
        <p className="muted">
          {reading ? 'これまでの read' : 'すべての read'} が推定した Range と一致しています（推定どおりに読めている）。
          {e.index.requests === 0 && 'Page Index は前に読んだものを使い回したので、この計画では新たに読んでいません。'}
        </p>
      ) : (
        <>
          <table className="table compare-list">
            <thead>
              <tr>
                <th>照合</th>
                <th>種類</th>
                <th>範囲</th>
                <th>理由の手がかり</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((c) => (
                <tr key={c.read.id} className="clickable" onClick={() => select({ kind: 'reads', id: c.read.id }, 'inspector')}>
                  <td className={c.match === 'failed' ? 'match-unread' : 'match-unplanned'}>{c.match === 'failed' ? (c.read.aborted ? '中断' : '失敗') : '予定外'}</td>
                  <td>{KIND_LABEL[c.kind]}</td>
                  <td className="mono">{formatBytes(c.read.length)}</td>
                  <td>
                    #{c.read.id} {c.read.purpose}
                    {/* 中断はブラウザの定型文（英語）しか出ないので、照合の列の「中断」だけで示す */}
                    {c.read.error && !c.read.aborted && `（${c.read.error}）`}
                  </td>
                </tr>
              ))}
              {showUnread && (
                <tr>
                  <td className="match-unread">未読</td>
                  <td>{[...new Set(cmp.unread.map((u) => KIND_LABEL[u.kind]))].join('・')}</td>
                  <td className="mono">{formatBytes(unreadBytes)}</td>
                  <td>読む予定だった {formatNumber(cmp.unread.length)} Range を読んでいない（Physical File Map の「実際に読んだ」の段の破線の枠）</td>
                </tr>
              )}
            </tbody>
          </table>
          {hidden > 0 && <p className="muted">ほか {formatNumber(hidden)} 件</p>}
          <p className="muted">
            予定外の Page Index は、地図を続けて動かしたときの前の計画の読み込みの続きや、Row Group を選んで読んだ Index であることが多い。未読は、地図を動かして読み込みを中断したときや、read が失敗して残りを止めたときに出る。
          </p>
        </>
      )}
    </>
  )
}

function diff(d: number, fmt: (n: number) => string): ReactNode {
  if (d === 0) return <span className="match-planned">一致</span>
  return <span className="match-unplanned">{d > 0 ? `+${fmt(d)}` : `−${fmt(-d)}`}</span>
}
