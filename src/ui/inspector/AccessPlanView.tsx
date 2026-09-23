import type { ReactNode } from 'react'
import type { Inspection } from '../../inspect'
import { MAX_DATA_BYTES, type DataBlocker } from '../../data/readData'
import { READ_CONCURRENCY } from '../../io/coalesce'
import { MAX_PAGE_INDEX_ROW_GROUPS, type AccessPlan } from '../../plan/accessPlan'
import { useStore, type DataState, type PlanStage } from '../../state/store'
import { levelColor } from '../../util/color'
import { formatBytes, formatNumber, formatPercent } from '../../util/format'
import { columnRole, ROLE_LABEL } from './columnRole'

/**
 * Access Simulator の結果を、候補が段階ごとに絞られていく funnel として見せる（design.md D20）。
 * 各段をクリックすると、地図と Physical File Map がその段の結果を強調する。
 */
export function AccessPlanView({ ins }: { ins: Inspection }) {
  const sim = useStore((s) => s.simulator)
  const setSimulatorEnabled = useStore((s) => s.setSimulatorEnabled)
  if (!sim.enabled) {
    return (
      <>
        <p>地図の左上の「Access Simulator」を ON にすると、表示範囲と縮尺からリーダーが読む範囲を推定します。</p>
        <button onClick={() => setSimulatorEnabled(true)}>Access Simulator を ON にする</button>
      </>
    )
  }
  return (
    <>
      <h3>Access Plan（推定）</h3>
      <DataToggle />
      <ColumnPicker ins={ins} />
      {sim.status === 'error' && <p className="warn">計算できませんでした: {sim.error}</p>}
      {!sim.plan ? <p className="muted">計算中…</p> : <Funnel ins={ins} plan={sim.plan} focus={sim.focus} running={sim.status === 'running'} />}
    </>
  )
}

function DataToggle() {
  const enabled = useStore((s) => s.data.enabled)
  const setDataEnabled = useStore((s) => s.setDataEnabled)
  return (
    <label className="data-toggle" title="推定した範囲のデータページを実際に読み、geometry を decode して地図に描きます（design.md D32）">
      <input type="checkbox" checked={enabled} onChange={(e) => setDataEnabled(e.target.checked)} /> 実データを読む（通信が発生します）
    </label>
  )
}

/** 読む列の選択（design.md D21）。列を足し引きすると、読む量が変わる様子で列指向の利点が見える */
function ColumnPicker({ ins }: { ins: Inspection }) {
  const columns = useStore((s) => s.simulator.columns)
  const setColumns = useStore((s) => s.setSimulatorColumns)
  const toggle = (i: number) => setColumns(columns.includes(i) ? columns.filter((c) => c !== i) : [...columns, i].sort((a, b) => a - b))
  return (
    <fieldset className="col-picker">
      <legend>読む列</legend>
      {ins.file.leafColumns.map((c) => {
        const role = columnRole(c, ins.geo)
        return (
          <label key={c.index} title={ROLE_LABEL[role]}>
            <input type="checkbox" checked={columns.includes(c.index)} onChange={() => toggle(c.index)} />
            <span className={`mono col-${role}`}>{c.name}</span>
          </label>
        )
      })}
    </fieldset>
  )
}

interface Row {
  stage?: PlanStage
  label: ReactNode
  count: ReactNode
  bytes?: number
  bytesAll?: number
  note: ReactNode
}

function Funnel({ ins, plan, focus, running }: { ins: Inspection; plan: AccessPlan; focus: PlanStage; running: boolean }) {
  const setFocus = useStore((s) => s.setPlanFocus)
  const data = useStore((s) => s.data)
  const select = useStore((s) => s.select)
  const s = plan.stages
  const lod = ins.lod
  const lv = plan.level.level
  const unit = ins.geo?.primary?.crs.unit ?? '座標単位'
  const top = s.file.bytes || 1
  const rows: Row[] = [
    { label: 'ファイル全体', count: `RG ${formatNumber(s.file.rowGroups)}`, bytes: s.file.bytes, bytesAll: s.file.bytesAll, note: `${formatNumber(s.file.rows)} 行` },
    {
      stage: 'prefix',
      label: (
        <>
          1. Level を選ぶ
          {lv && lod && <span className="swatch" style={{ background: levelColor(lv.level, lod.levels.length), marginLeft: 4 }} />}
        </>
      ),
      count: plan.level.used && lv ? `Level ${lv.level} → RG 0–${lv.rowGroupEnd}` : 'Level なし',
      bytes: s.prefix.bytes,
      bytesAll: s.prefix.bytesAll,
      note: (
        <>
          {plan.level.note}。目標 resolution {plan.input.targetResolution.toPrecision(3)} {unit}/px。先頭から RG {formatNumber(s.prefix.rowGroups)} 個（{formatNumber(s.prefix.rows)} 行）が候補
        </>
      ),
    },
    {
      stage: 'rowGroupPruned',
      label: '2. Row Group の bbox で絞る',
      count: `RG ${formatNumber(s.rowGroupPruned.rowGroups)}`,
      bytes: s.rowGroupPruned.bytes,
      bytesAll: s.rowGroupPruned.bytesAll,
      note: (
        <>
          Footer の統計値だけで判定（追加の読み込みなし）。表示範囲と重ならない {formatNumber(s.rowGroupPruned.pruned)} 個を読み飛ばす
          {s.rowGroupPruned.unknown > 0 && `。統計が無く判定できない ${formatNumber(s.rowGroupPruned.unknown)} 個は読む`}
        </>
      ),
    },
    {
      label: '3. Page Index を読む',
      count: `${formatNumber(s.pageIndex.fetched + s.pageIndex.cached)} 件`,
      note: s.pageIndex.skipped ? (
        <>候補の Row Group が {MAX_PAGE_INDEX_ROW_GROUPS} 個を超えるため、このツールでは Page Index を読まない（Range Request が多くなりすぎるため）。拡大すると候補が減り、ページ単位で絞れるようになる</>
      ) : (
        <>
          残った Row Group の分だけ読む（{formatBytes(s.pageIndex.bytes)}）。今回新たに読んだ {formatNumber(s.pageIndex.fetched)} 件、キャッシュ済み {formatNumber(s.pageIndex.cached)} 件
          {s.pageIndex.rowGroupsWithPageBbox < s.rowGroupPruned.rowGroups && `。Page bbox が求められない Row Group ${formatNumber(s.rowGroupPruned.rowGroups - s.pageIndex.rowGroupsWithPageBbox)} 個はページ単位では絞れない`}
        </>
      ),
    },
    {
      stage: 'pages',
      label: '4. Page bbox で絞る',
      count: s.pages.spans ? `${formatNumber(s.pages.spansKept)} / ${formatNumber(s.pages.spans)} 範囲` : '-',
      bytes: s.pages.bytes,
      bytesAll: s.pages.bytesAll,
      note: <>bbox covering 列の ColumnIndex で、表示範囲と重なるページだけを残す。読む行 {formatNumber(s.pages.rows)}（Row Group 単位なら {formatNumber(s.rowGroupPruned.rows)}）。辞書ページは必要なので含める</>,
    },
    {
      stage: 'requests',
      label: '5. Range にまとめる',
      count: `${formatNumber(s.requests.logical)} → ${formatNumber(s.requests.coalesced)} 回`,
      bytes: s.requests.bytes,
      note: <>隣接・重なるページ範囲を 1 回の Range Request にまとめる（隙間は埋めない）。全列なら {formatNumber(s.requests.logicalAll)} → {formatNumber(s.requests.coalescedAll)} 回</>,
    },
    decodeRow(data, plan),
  ]

  return (
    <>
      <table className={`table funnel${running ? ' stale' : ''}`}>
        <thead>
          <tr>
            <th>段階</th>
            <th>候補</th>
            <th>読む量（選んだ列）</th>
            <th>全列なら</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <FunnelRow key={i} row={r} top={top} active={r.stage === focus} onClick={r.stage ? () => setFocus(r.stage!) : undefined} fileSize={ins.file.size} />
          ))}
        </tbody>
      </table>
      <p className="muted">
        段階をクリックすると、地図と Physical File Map がその段階の結果を強調します。
        {data.enabled ? '5. までの「読む量」は推定、6. は実際に読んで decode した結果です。' : '「読む量」はデータページの推定で、まだ読んでいません（実際に読んだのは Page Index だけ）。'}
      </p>
      <h4>読む Row Group（{formatNumber(plan.rowGroups.length)} 個）</h4>
      <table className="table">
        <thead>
          <tr>
            <th>RG</th>
            <th>判定</th>
            <th>読むページ範囲</th>
            <th>読む量</th>
          </tr>
        </thead>
        <tbody>
          {plan.rowGroups.map((r) => {
            const bytes = r.chunkRanges.filter((c) => plan.input.columns.includes(c.col)).reduce((a, c) => a + c.ranges.reduce((b, x) => b + x.end - x.start, 0), 0)
            return (
              <tr key={r.rg} className="clickable" onClick={() => select({ kind: 'rowGroup', rg: r.rg }, 'inspector')}>
                <td>{r.rg}</td>
                <td>{r.rgDecision === 'unknown' ? '統計なし（読む）' : '重なる'}</td>
                <td>{r.spanKept ? `${r.spanKept.filter(Boolean).length} / ${r.spanKept.length}` : 'ページ単位では絞れない'}</td>
                <td>{formatBytes(bytes)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

const BLOCKER_NOTE: Record<DataBlocker, string> = {
  'no-geometry-column': '主ジオメトリ列が見つからないため描けない',
  'unsupported-encoding': 'geometry の encoding が WKB ではないため、このツールでは decode しない（GeoArrow は未対応）',
  unmappable: 'CRS が地図表示に未対応のため描かない',
  'geometry-not-selected': 'geometry 列を読んでいないので描けない。描くには geometry 列が要る（列指向なので、要らない列は読まずに済む）',
  'nothing-to-read': '表示範囲と重なるページが無いので、読むものが無い',
  'over-limit': `読む量が上限 ${formatBytes(MAX_DATA_BYTES)} を超えるため読まない（lod の無いファイルの全体表示や、大きい列を足したときの歯止め）。拡大するか、読む列を減らすと読める`,
}

/** 6. 実データの decode（design.md D31〜D36）。行単位の判定まで行い、読んだ行と範囲内の行を比べる */
function decodeRow(data: DataState, plan: AccessPlan): Row {
  const label = '6. 読んで decode する'
  if (!data.enabled) return { label, count: '-', note: '「実データを読む」を ON にすると、この計画どおりにデータページを読み、geometry を decode して地図に描きます' }
  if (data.status === 'blocked' && data.blocker) return { label, count: '読まない', note: BLOCKER_NOTE[data.blocker] }
  if (data.status === 'error') return { label, count: 'エラー', note: data.error }
  const r = data.result
  if (!r) return { label, count: '読み込み中…', note: `${formatNumber(plan.requests.length)} 回の Range Request で読む` }
  if (data.status === 'reading') {
    // 読み終わった Range から描き足す（design.md D38）。ファイル順 = 粗い Level から読むので、全体像が先に出る
    return {
      label,
      count: `${formatNumber(r.doneRequests)} / ${formatNumber(r.requests)} Range`,
      bytes: r.bytes,
      note: (
        <>
          読み込み中（{Math.round(r.ms)} ms）。ファイル順に同時 {READ_CONCURRENCY} 本で読み、読み終わった Column Chunk から描き足している。いままでに {formatNumber(r.readRows)} 行を decode し、範囲内は{' '}
          {formatNumber(r.inViewRows)} 行
        </>
      ),
    }
  }
  return {
    label,
    count: `${formatNumber(r.inViewRows)} / ${formatNumber(r.readRows)} 行`,
    bytes: r.bytes,
    note: (
      <>
        {formatNumber(r.requests)} 回の Range Request で読み（{Math.round(r.ms)} ms）、geometry を decode した。読んだページが覆う {formatNumber(r.readRows)} 行のうち、ジオメトリの bbox が表示範囲と重なるのは {formatNumber(r.inViewRows)} 行（
        {formatPercent(r.inViewRows, r.readRows)}）。残りはページ単位の絞り込みでは除けず「読んだが捨てる」行（地図の灰色の点）
        {r.emptyRows > 0 && `。geometry が空で描けない行 ${formatNumber(r.emptyRows)}`}
      </>
    ),
  }
}

function FunnelRow({ row, top, active, onClick, fileSize }: { row: Row; top: number; active: boolean; onClick?: () => void; fileSize: number }) {
  return (
    <>
      <tr className={`${onClick ? 'clickable' : ''}${active ? ' active' : ''}`} onClick={onClick}>
        <td>{row.label}</td>
        <td>{row.count}</td>
        <td>
          {row.bytes !== undefined ? (
            <>
              {formatBytes(row.bytes)}
              <span className="funnel-bar">
                {/* 2.2GB から数 MB まで縮むので、線形だと後半の段が見えない。割合の対数で幅を決める */}
                <span style={{ width: `${Math.max(2, 100 + Math.log10(Math.max(row.bytes, 1) / top) * 25)}%` }} />
              </span>
              <span className="muted">{formatPercent(row.bytes, fileSize)}</span>
            </>
          ) : (
            '-'
          )}
        </td>
        <td>{row.bytesAll !== undefined ? formatBytes(row.bytesAll) : '-'}</td>
      </tr>
      <tr className={`funnel-note${active ? ' active' : ''}`}>
        <td colSpan={4}>{row.note}</td>
      </tr>
    </>
  )
}
