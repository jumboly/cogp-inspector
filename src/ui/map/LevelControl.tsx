import { useStore } from '../../state/store'
import { levelColor } from '../../util/color'
import { formatBytes, formatNumber, formatPercent } from '../../util/format'

/** 地図に表示する COGP Level を選ぶ。Level を上げると、prefix が伸びて細かい Row Group が加わる様子を見せる */
export function LevelControl() {
  const ins = useStore((s) => s.inspection)!
  const viewLevel = useStore((s) => s.viewLevel)
  const setViewLevel = useStore((s) => s.setViewLevel)
  const lod = ins.lod!
  const n = lod.levels.length
  const l = viewLevel === null ? undefined : lod.levels[viewLevel]
  const unit = ins.geo?.primary?.crs.unit ?? ''

  return (
    <div className="level-control">
      {!lod.valid && <div className="warn">lod が COGP 仕様に違反しています。仕様では Level 選択に使ってはいけないため、この表示は参考です。</div>}
      <div className="level-control-row">
        <label>
          表示 Level{' '}
          <select value={viewLevel ?? ''} onChange={(e) => setViewLevel(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">すべての Row Group</option>
            {lod.levels.map((lv) => (
              <option key={lv.level} value={lv.level}>
                Level {lv.level}（RG 0–{lv.rowGroupEnd}）
              </option>
            ))}
          </select>
        </label>
        <button disabled={viewLevel === null || viewLevel === 0} onClick={() => setViewLevel(viewLevel === null ? 0 : viewLevel - 1)} title="粗く">
          −
        </button>
        <button disabled={viewLevel === n - 1} onClick={() => setViewLevel(viewLevel === null ? 0 : viewLevel + 1)} title="細かく">
          ＋
        </button>
      </div>
      <input type="range" min={0} max={n - 1} value={viewLevel ?? n - 1} onChange={(e) => setViewLevel(Number(e.target.value))} aria-label="表示 Level" />
      <div className="level-legend">
        {lod.levels.map((lv) => (
          <span key={lv.level} style={{ background: levelColor(lv.level, n), opacity: viewLevel === null || lv.level <= viewLevel ? 1 : 0.2 }} />
        ))}
      </div>
      {l ? (
        <div className="muted">
          resolution {l.resolution.toPrecision(3)} {unit} / 読む RG {formatNumber(l.rowGroupEnd + 1)} 個・{formatNumber(l.prefixRows)} 行 / {formatBytes(l.prefixCompressedBytes)}（{formatPercent(l.prefixCompressedBytes, ins.file.size)}）
          <br />
          太線 = この Level で増えた Row Group、細線 = 前の Level から引き継いだ Row Group
        </div>
      ) : (
        <div className="muted">色 = Row Group が属する Level（紫: 粗い → 黄: 細かい）</div>
      )}
    </div>
  )
}
