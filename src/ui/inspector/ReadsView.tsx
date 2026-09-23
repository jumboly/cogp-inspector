import { useMemo } from 'react'
import { CATEGORY_LABEL, groupBursts, readCategory, type ReadCategory } from '../../io/readCategory'
import type { ReadRecord } from '../../io/source'
import { useStore } from '../../state/store'
import { formatBytes, formatNumber, formatPercent, formatRange } from '../../util/format'

// 画面が重くならないよう、表示する「まとまり」は新しい順にこの数まで
const MAX_BURSTS = 30

/**
 * 実際に読んだ範囲（Actual）の記録。1 回の操作で続けて起きた read を 1 つの「まとまり」にし、
 * その中で各 read がいつ始まり何 ms かかったかを横棒（ウォーターフォール）で並べる。
 * URL で開いた場合、1 行が 1 回の HTTP Range Request。
 */
export function ReadsView({ fileSize, selectedId }: { fileSize: number; selectedId?: number }) {
  const reads = useStore((s) => s.reads)
  const kind = useStore((s) => s.sourceKind)
  const bursts = useMemo(() => groupBursts(reads), [reads])
  const byCat = useMemo(() => {
    const m = new Map<ReadCategory, { count: number; bytes: number; ms: number }>()
    for (const r of reads) {
      const c = readCategory(r.purpose)
      const v = m.get(c) ?? { count: 0, bytes: 0, ms: 0 }
      m.set(c, { count: v.count + 1, bytes: v.bytes + r.length, ms: v.ms + r.durationMs })
    }
    return [...m.entries()]
  }, [reads])
  const total = reads.reduce((a, r) => a + r.length, 0)
  const t0 = bursts[0]?.startedAt ?? 0

  return (
    <>
      <h3>Range Request（実際に読んだ範囲）</h3>
      <p className="muted">
        {kind === 'http'
          ? '1 行が 1 回の HTTP Range Request（Range: bytes=開始-終了）です。'
          : 'ローカルファイルは File.slice で必要な範囲だけを読んでいます。URL で開くと、1 行が 1 回の HTTP Range Request になります。'}
        データページはまだ読んでいません（Access Simulator の「読む量」は推定です）。
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>目的</th>
            <th>回数</th>
            <th>サイズ</th>
            <th>平均時間</th>
          </tr>
        </thead>
        <tbody>
          {byCat.map(([c, v]) => (
            <tr key={c}>
              <td>
                <span className={`cat cat-${c}`}>{CATEGORY_LABEL[c]}</span>
              </td>
              <td>{formatNumber(v.count)}</td>
              <td>{formatBytes(v.bytes)}</td>
              <td>{(v.ms / v.count).toFixed(1)} ms</td>
            </tr>
          ))}
          <tr>
            <td>合計</td>
            <td>{formatNumber(reads.length)}</td>
            <td>
              {formatBytes(total)}（ファイルの {formatPercent(total, fileSize)}）
            </td>
            <td />
          </tr>
        </tbody>
      </table>
      <h4>操作ごとの読み込み（新しい順）</h4>
      {[...bursts]
        .reverse()
        .slice(0, MAX_BURSTS)
        .map((b) => (
          <BurstView key={b.reads[0].id} reads={b.reads} start={b.startedAt} end={b.endedAt} t0={t0} kind={kind} selectedId={selectedId} />
        ))}
      {bursts.length > MAX_BURSTS && <p className="muted">ほか {formatNumber(bursts.length - MAX_BURSTS)} 件の古い操作は省略しています。</p>}
    </>
  )
}

function BurstView({ reads, start, end, t0, kind, selectedId }: { reads: ReadRecord[]; start: number; end: number; t0: number; kind?: 'local' | 'http'; selectedId?: number }) {
  const select = useStore((s) => s.select)
  const span = Math.max(end - start, 1)
  const bytes = reads.reduce((a, r) => a + r.length, 0)
  const merged = reads.filter((r) => r.purpose.includes('（合体）')).length
  return (
    <details className="burst" open={reads.some((r) => r.id === selectedId) || undefined}>
      <summary>
        +{((start - t0) / 1000).toFixed(2)} s ・ {formatNumber(reads.length)} 回 ・ {formatBytes(bytes)} ・ {span.toFixed(0)} ms
        <span className="muted"> {summarize(reads)}</span>
      </summary>
      {merged > 0 && <p className="muted">「合体」は隣り合う複数の Index を 1 回の read にまとめたものです（{formatNumber(merged)} 回）。</p>}
      <table className="table waterfall">
        <tbody>
          {reads.map((r) => (
            <tr key={r.id} className={`clickable${r.id === selectedId ? ' active' : ''}${r.error ? ' row-error' : ''}`} onClick={() => select({ kind: 'reads', id: r.id }, 'inspector')} title={`${r.purpose}\n${kind === 'http' ? r.rangeHeader : formatRange({ start: r.offset, end: r.offset + r.length })}${r.error ? `\nエラー: ${r.error}` : ''}`}>
              <td>#{r.id}</td>
              <td className="waterfall-purpose">
                <span className={`cat cat-${readCategory(r.purpose)}`} /> {r.purpose}
              </td>
              <td>{formatBytes(r.length)}</td>
              <td className="waterfall-cell">
                {/* まとまりの開始からの経過時間で並べる。同時に走った read（並列の Range Request）が縦に重なって見える */}
                <span className="waterfall-bar" style={{ left: `${((r.startedAt - start) / span) * 100}%`, width: `max(2px, ${(r.durationMs / span) * 100}%)` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

function summarize(reads: ReadRecord[]) {
  const m = new Map<ReadCategory, number>()
  for (const r of reads) m.set(readCategory(r.purpose), (m.get(readCategory(r.purpose)) ?? 0) + 1)
  return [...m.entries()].map(([c, n]) => `${CATEGORY_LABEL[c]} ${n}`).join(' / ')
}
