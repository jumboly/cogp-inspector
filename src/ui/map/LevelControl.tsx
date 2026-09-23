import { useStore } from '../../state/store'
import { levelColor } from '../../util/color'
import { formatBytes, formatNumber, formatPercent } from '../../util/format'

/**
 * 地図の左上のパネル。Access Simulator の ON/OFF と、COGP の表示 Level の選択。
 * Simulator の間は Level を表示範囲の縮尺から自動で選ぶので、手動の選択は無効にする（design.md D19）。
 */
export function LevelControl() {
  const ins = useStore((s) => s.inspection)!
  const sim = useStore((s) => s.simulator)
  const setSimulatorEnabled = useStore((s) => s.setSimulatorEnabled)
  const select = useStore((s) => s.select)
  const unit = ins.geo?.primary?.crs.unit ?? ''
  return (
    <div className="level-control">
      <div className="sim-row">
        <label title="地図の表示範囲と縮尺から、リーダーが読むバイト範囲を推定します">
          <input type="checkbox" checked={sim.enabled} onChange={(e) => setSimulatorEnabled(e.target.checked)} /> Access Simulator
        </label>
        {sim.enabled && (
          <>
            <span className="muted">{sim.status === 'running' ? '計算中…' : sim.status === 'error' ? `エラー: ${sim.error}` : sim.plan ? `目標 resolution ${sim.plan.input.targetResolution.toPrecision(3)} ${unit}/px` : ''}</span>
            <button onClick={() => select({ kind: 'plan' }, 'inspector')}>Access Plan</button>
          </>
        )}
      </div>
      {ins.lod && <LevelSection />}
    </div>
  )
}

function LevelSection() {
  const ins = useStore((s) => s.inspection)!
  const viewLevel = useStore((s) => s.viewLevel)
  const setViewLevel = useStore((s) => s.setViewLevel)
  const auto = useStore((s) => s.simulator.enabled)
  const lod = ins.lod!
  const n = lod.levels.length
  const l = viewLevel === null ? undefined : lod.levels[viewLevel]
  const unit = ins.geo?.primary?.crs.unit ?? ''

  return (
    <>
      {!lod.valid && <div className="warn">lod が COGP 仕様に違反しています。仕様では Level 選択に使ってはいけないため、この表示は参考です。</div>}
      <div className="level-control-row">
        <label>
          表示 Level{auto && '（自動）'}{' '}
          <select value={viewLevel ?? ''} disabled={auto} onChange={(e) => setViewLevel(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">すべての Row Group</option>
            {lod.levels.map((lv) => (
              <option key={lv.level} value={lv.level}>
                Level {lv.level}（RG 0–{lv.rowGroupEnd}）
              </option>
            ))}
          </select>
        </label>
        <button disabled={auto || viewLevel === null || viewLevel === 0} onClick={() => setViewLevel(viewLevel === null ? 0 : viewLevel - 1)} title="粗く">
          −
        </button>
        <button disabled={auto || viewLevel === n - 1} onClick={() => setViewLevel(viewLevel === null ? 0 : viewLevel + 1)} title="細かく">
          ＋
        </button>
      </div>
      <input type="range" min={0} max={n - 1} value={viewLevel ?? n - 1} disabled={auto} onChange={(e) => setViewLevel(Number(e.target.value))} aria-label="表示 Level" />
      <div className="level-legend">
        {lod.levels.map((lv) => (
          <span key={lv.level} style={{ background: levelColor(lv.level, n), opacity: viewLevel === null || lv.level <= viewLevel ? 1 : 0.2 }} />
        ))}
      </div>
      {auto ? (
        <div className="muted">
          地図を動かすと、縮尺から Level を選び直します。太線 = 表示範囲と重なり読む Row Group、細線 = 読み飛ばす Row Group
          <br />
          青の枠 = 読む範囲に残ったページ（薄い枠は読み飛ばすページ）
        </div>
      ) : l ? (
        <div className="muted">
          resolution {l.resolution.toPrecision(3)} {unit} / 読む RG {formatNumber(l.rowGroupEnd + 1)} 個・{formatNumber(l.prefixRows)} 行 / {formatBytes(l.prefixCompressedBytes)}（{formatPercent(l.prefixCompressedBytes, ins.file.size)}）
          <br />
          太線 = この Level で増えた Row Group、細線 = 前の Level から引き継いだ Row Group
        </div>
      ) : (
        <div className="muted">色 = Row Group が属する Level（紫: 粗い → 黄: 細かい）</div>
      )}
    </>
  )
}
