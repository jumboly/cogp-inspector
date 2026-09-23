import type { LodModel } from '../../cogp/lod'
import { useStore } from '../../state/store'
import { levelColor } from '../../util/color'
import { formatBytes } from '../../util/format'

/**
 * COGP の prefix 構造を図にする。各行が 1 つの Level で、横軸は Row Group 番号（0 → 末尾）。
 * 「Level N は RG 0 から row_group_end までを全部読む」＝ 前の Level の範囲を含んだまま右へ伸びることを見せる。
 * 色の濃い部分がその Level で新しく加わる Row Group、薄い部分は前の Level から引き継いだ Row Group。
 */
export function LevelPrefix({ lod, rowGroupCount, highlight }: { lod: LodModel; rowGroupCount: number; highlight?: number }) {
  const select = useStore((s) => s.select)
  const n = lod.levels.length
  const pct = (rg: number) => `${(rg / rowGroupCount) * 100}%`
  return (
    <div className="prefix">
      <div className="prefix-axis">
        <span>RG 0</span>
        <span>RG {rowGroupCount - 1}</span>
      </div>
      {lod.levels.map((l) => {
        const color = levelColor(l.level, n)
        const end = Math.min(l.rowGroupEnd, rowGroupCount - 1) + 1
        return (
          <div
            key={l.level}
            className={`prefix-row${highlight === l.level ? ' active' : ''}`}
            onClick={() => select({ kind: 'level', level: l.level }, 'inspector')}
            title={`Level ${l.level}: RG 0–${l.rowGroupEnd} を読む（新規 RG ${l.newFrom}–${l.rowGroupEnd}、${formatBytes(l.prefixCompressedBytes)}）`}
          >
            <span className="prefix-label">L{l.level}</span>
            <span className="prefix-track">
              <span className="prefix-old" style={{ left: 0, width: pct(Math.min(l.newFrom, end)), background: color }} />
              <span className="prefix-new" style={{ left: pct(l.newFrom), width: pct(Math.max(end - l.newFrom, 0)), background: color }} />
            </span>
          </div>
        )
      })}
    </div>
  )
}
