import { useRef, type ReactNode } from 'react'
import { fileOverlap, levelOverlaps } from '../../diagnose/diagnose'
import { fileKind, type Inspection } from '../../inspect'
import { HttpRangeSource } from '../../io/http'
import { LocalBlobSource } from '../../io/local'
import type { AccessPlan } from '../../plan/accessPlan'
import { planCost, type CumulativeCost } from '../../plan/compareFiles'
import { SAMPLES, SAMPLES_AVAILABLE, sampleOf, sampleUrl } from '../../samples'
import { useStore } from '../../state/store'
import { formatBytes, formatNumber } from '../../util/format'

/** 表の見出しに出す短い名前。同梱サンプルならその名前、それ以外はファイル名 */
function shortName(name: string | undefined): string {
  if (!name) return '-'
  return sampleOf(name)?.label ?? name.split('/').pop() ?? name
}


/**
 * 重なり係数（design.md D42）。COGP は Level ごと、通常の GeoParquet はファイル全体で出す。
 * COGP は Level どうしが同じ範囲を覆うので、ファイル全体の値は並び方の良し悪しを表さない
 */
function overlapText(ins: Inspection): string {
  if (ins.lod?.valid) {
    const cs = levelOverlaps(ins).flatMap((o) => (o.coefficient === undefined ? [] : [o.coefficient]))
    return cs.length ? `Level ごと ${Math.min(...cs).toFixed(2)}〜${Math.max(...cs).toFixed(2)}` : '-'
  }
  const o = fileOverlap(ins)
  return o.coefficient === undefined ? '-' : `全体 ${o.coefficient.toFixed(2)}（RG ${formatNumber(o.rowGroups)} 個）`
}

/** 値が小さい方を太字にする（読む量・回数は少ないほど良い） */
function pair(a: number | undefined, b: number | undefined, fmt: (n: number) => string): [ReactNode, ReactNode] {
  const show = (x: number | undefined, other: number | undefined) => (x === undefined ? '-' : other !== undefined && x < other ? <strong>{fmt(x)}</strong> : fmt(x))
  return [show(a, b), show(b, a)]
}

interface Row {
  label: ReactNode
  cells: [ReactNode, ReactNode]
}

/**
 * 通常の GeoParquet と COGP の比較（design.md D44）。
 * 開いているファイルとは別に「比較対象」を 1 つ開き、同じ表示範囲・縮尺・列で Access Plan を計算して funnel を並べる。
 * 比較対象は実データを読まないので、比べるのは両方とも推定（Expected）の値
 */
export function CompareFilesView({ ins, plan }: { ins: Inspection; plan: AccessPlan }) {
  const cmp = useStore((s) => s.compare)
  const sourceName = useStore((s) => s.sourceName)
  const closeCompare = useStore((s) => s.closeCompare)
  const running = useStore((s) => s.simulator.status === 'running') || cmp.planStatus === 'running'

  if (cmp.status !== 'ready' || !cmp.inspection) {
    return (
      <>
        <h4>ファイルの比較（同じ表示範囲）</h4>
        {cmp.status === 'loading' ? <p className="muted">比較対象を開いています…</p> : <ComparePicker />}
        {cmp.status === 'error' && <p className="warn">比較対象を開けませんでした: {cmp.error}</p>}
      </>
    )
  }

  const t = cmp.inspection
  const tp = cmp.plan
  const mainName = shortName(sourceName)
  const targetName = shortName(cmp.name)
  const lv = (p: AccessPlan | undefined) => (!p ? '-' : p.level.used && p.level.level ? `Level ${p.level.level.level} → RG 0–${p.level.level.rowGroupEnd}` : 'Level なし')
  const mc = planCost(plan)
  const tc = tp ? planCost(tp) : undefined
  const footer = (i: Inspection) => i.file.footer.end - i.file.footer.start

  const rows: Row[] = [
    { label: '種別', cells: [fileKind(ins), fileKind(t)] },
    { label: 'ファイル全体', cells: [`RG ${formatNumber(ins.file.rowGroups.length)}・${formatBytes(ins.file.size)}`, `RG ${formatNumber(t.file.rowGroups.length)}・${formatBytes(t.file.size)}`] },
    { label: '開くときに読む Footer', cells: pair(footer(ins), footer(t), formatBytes) },
    { label: 'Row Group の重なり係数', cells: [overlapText(ins), overlapText(t)] },
    { label: '1. Level を選ぶ', cells: [lv(plan), lv(tp)] },
    { label: '候補の Row Group（prefix）', cells: pair(plan.stages.prefix.rowGroups, tp?.stages.prefix.rowGroups, formatNumber) },
    { label: '2. bbox で絞った後の Row Group', cells: pair(plan.stages.rowGroupPruned.rowGroups, tp?.stages.rowGroupPruned.rowGroups, formatNumber) },
    { label: '3. 新たに読む Page Index', cells: [`${formatNumber(mc.indexRequests)} 回・${formatBytes(mc.indexBytes)}`, tc ? `${formatNumber(tc.indexRequests)} 回・${formatBytes(tc.indexBytes)}` : '-'] },
    { label: '4. 読む行（ページ単位）', cells: pair(plan.stages.pages.rows, tp?.stages.pages.rows, formatNumber) },
    { label: '5. Range Request（データページ）', cells: pair(mc.dataRequests, tc?.dataRequests, formatNumber) },
    { label: '読む量（データページ・選んだ列）', cells: pair(mc.dataBytes, tc?.dataBytes, formatBytes) },
    { label: '全列なら', cells: pair(plan.stages.pages.bytesAll, tp?.stages.pages.bytesAll, formatBytes) },
  ]

  return (
    <>
      <h4>
        ファイルの比較（同じ表示範囲）
        {running && <span className="muted">（再計算中。前の計画の値）</span>}
      </h4>
      <p className="compare-target">
        比較対象: <span className="mono ellipsis" title={cmp.name}>{targetName}</span>
        <button className="link" onClick={closeCompare}>
          閉じる
        </button>
      </p>
      {cmp.incomparable ? (
        <p className="warn">{cmp.incomparable}</p>
      ) : (
        <>
          {cmp.planStatus === 'error' && <p className="warn">比較対象の計画を計算できませんでした: {cmp.planError}</p>}
          <table className={`table compare${running ? ' stale' : ''}`}>
            <thead>
              <tr>
                <th>現在の表示範囲</th>
                <th>{mainName}</th>
                <th>{targetName}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.label}</td>
                  <td>{r.cells[0]}</td>
                  <td>{r.cells[1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Cumulative main={cmp.totals.main} target={cmp.totals.target} mainName={mainName} targetName={targetName} />
          <p className="muted">
            両方とも推定（Expected）の値で、少ない方を太字にしています。比較対象は Footer と Page Index だけを読み、データページは読みません（通信量が倍にならないよう、実データを読むのは開いているファイルだけ）。
            {cmp.missingColumns.length > 0 && ` 比較対象に無い列（${cmp.missingColumns.join(', ')}）は比較対象では読まない扱い。`}
          </p>
        </>
      )}
    </>
  )
}

function Cumulative({ main, target, mainName, targetName }: { main: CumulativeCost; target: CumulativeCost; mainName: string; targetName: string }) {
  const rows: Row[] = [
    { label: 'Range Request（Page Index + データページ）', cells: pair(main.indexRequests + main.dataRequests, target.indexRequests + target.dataRequests, formatNumber) },
    { label: '読む量（Page Index + データページ）', cells: pair(main.indexBytes + main.dataBytes, target.indexBytes + target.dataBytes, formatBytes) },
  ]
  return (
    <table className="table compare">
      <thead>
        <tr>
          <th>累計（地図の移動 {formatNumber(main.plans)} 回）</th>
          <th>{mainName}</th>
          <th>{targetName}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.label}</td>
            <td>{r.cells[0]}</td>
            <td>{r.cells[1]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 比較対象の選び方。同梱サンプルを開いているときは、残りのサンプルを候補に出す（design.md D45） */
function ComparePicker() {
  const openCompare = useStore((s) => s.openCompare)
  const sourceName = useStore((s) => s.sourceName)
  const fileInput = useRef<HTMLInputElement>(null)
  const current = sampleOf(sourceName)
  return (
    <>
      <p className="muted">別のファイルを「比較対象」として開くと、同じ表示範囲での読む量を並べて比べます（比較対象は Footer と Page Index だけを読みます）。</p>
      <div className="compare-picker">
        {SAMPLES_AVAILABLE &&
          current &&
          SAMPLES.filter((s) => s.id !== current.id).map((s) => (
            <button key={s.id} title={s.description} onClick={() => void openCompare(() => HttpRangeSource.open(sampleUrl(s)))}>
              サンプル（{s.label}）と比べる
            </button>
          ))}
        <button onClick={() => fileInput.current?.click()}>ローカルファイルと比べる</button>
        <input
          ref={fileInput}
          type="file"
          accept=".parquet"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void openCompare(async () => new LocalBlobSource(f, f.name))
            e.target.value = ''
          }}
        />
      </div>
    </>
  )
}
