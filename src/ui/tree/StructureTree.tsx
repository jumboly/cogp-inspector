import { useEffect, useRef, useState, type ReactNode } from 'react'
import { levelOfRowGroup } from '../../cogp/lod'
import { chunkKey, useStore, type Selection } from '../../state/store'
import { levelColor, NEUTRAL } from '../../util/color'
import { formatBytes, formatNumber } from '../../util/format'

function same(a: Selection | null, b: Selection): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function Node({ sel, label, meta, color, children, defaultOpen = false, forceOpen = false }: { sel: Selection; label: ReactNode; meta?: ReactNode; color?: string; children?: ReactNode; defaultOpen?: boolean; forceOpen?: boolean }) {
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const [open, setOpen] = useState(defaultOpen)
  const active = same(selection, sel)
  const row = useRef<HTMLDivElement>(null)
  // 地図や Byte Map で選ばれたときにも、ツリー上の位置が見えるようにする
  useEffect(() => {
    if (active) row.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const isOpen = open || forceOpen
  return (
    <li>
      <div ref={row} className={`tree-row${active ? ' active' : ''}`} onClick={() => {
          select(sel, 'tree')
          // 子を持つ行は選んだら開く（中身を見たくて選ぶことがほとんどのため）
          if (children) setOpen(true)
        }}>
        <span
          className="tree-toggle"
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
        >
          {children ? (isOpen ? '▾' : '▸') : ''}
        </span>
        {color && <span className="swatch" style={{ background: color }} />}
        <span className="tree-label">{label}</span>
        {meta && <span className="tree-meta">{meta}</span>}
      </div>
      {children && isOpen && <ul>{children}</ul>}
    </li>
  )
}

/** Column Chunk の子としてページを並べる。開いたときに初めてその Chunk のページを読む（design.md D15） */
function ChunkPageNodes({ rg, col }: { rg: number; col: number }) {
  const state = useStore((s) => s.chunkPages[chunkKey(rg, col)])
  const load = useStore((s) => s.loadChunkPages)
  useEffect(() => load(rg, col), [load, rg, col])
  if (!state || state.status === 'loading') return <li className="muted tree-note">読み込み中…</li>
  if (state.status === 'error') return <li className="warn tree-note">{state.error}</li>
  return (
    <>
      {state.data.pages.map((p) => (
        <Node
          key={p.index}
          sel={{ kind: 'page', rg, col, page: p.index }}
          label={`#${p.index} ${p.kind === 'dictionary' ? '辞書' : (p.header?.type ?? 'DATA')}`}
          meta={formatBytes(p.range.end - p.range.start)}
        />
      ))}
    </>
  )
}

/**
 * ファイルの物理的な並び順（先頭 → 末尾）でツリーを組む。
 * Schema・GeoParquet・COGP の情報がすべて末尾の Footer の中にあることを、階層そのもので見せるため。
 */
export function StructureTree() {
  const inspection = useStore((s) => s.inspection)
  const sourceName = useStore((s) => s.sourceName)
  const selection = useStore((s) => s.selection)
  if (!inspection) return <p className="muted">ファイルを開くと、ファイルの先頭から末尾への並びで構造を表示します。</p>
  const { file, geo, lod } = inspection
  const nLevels = lod?.levels.length ?? 0
  const rgColor = (rg: number) => {
    const lv = levelOfRowGroup(lod, rg)
    return lv === undefined ? NEUTRAL : levelColor(lv, nLevels)
  }

  return (
    <ul className="tree">
      <Node sel={{ kind: 'file' }} label={sourceName?.split('/').pop() ?? 'file'} meta={formatBytes(file.size)} defaultOpen>
        <Node sel={{ kind: 'header' }} label='先頭 magic "PAR1"' meta="4 B" />
        <Node sel={{ kind: 'rowGroups' }} label="Row Groups（データ本体）" meta={formatNumber(file.rowGroups.length)} forceOpen={selection?.kind === 'rowGroup' || selection?.kind === 'column' || selection?.kind === 'page'}>
          {file.rowGroups.map((rg) => (
            <Node key={rg.index} sel={{ kind: 'rowGroup', rg: rg.index }} label={`RG ${rg.index}`} meta={`${formatNumber(rg.numRows)} 行`} color={rgColor(rg.index)} forceOpen={(selection?.kind === 'column' || selection?.kind === 'page') && selection.rg === rg.index}>
              {rg.columns.map((c, ci) => (
                <Node key={ci} sel={{ kind: 'column', rg: rg.index, col: ci }} label={c.column.name} meta={formatBytes(c.compressedSize)} forceOpen={selection?.kind === 'page' && selection.rg === rg.index && selection.col === ci}>
                  <ChunkPageNodes rg={rg.index} col={ci} />
                </Node>
              ))}
            </Node>
          ))}
        </Node>
        {file.pageIndex && <Node sel={{ kind: 'pageIndex' }} label="Page Index" meta={formatBytes(file.pageIndex.end - file.pageIndex.start)} />}
        <Node sel={{ kind: 'footer' }} label="Footer（FileMetaData）" meta={formatBytes(file.footer.end - file.footer.start)} defaultOpen>
          <Node sel={{ kind: 'schema' }} label="Schema" meta={`${file.leafColumns.length} 列`} />
          {geo && <Node sel={{ kind: 'geo' }} label="GeoParquet（geo）" meta={geo.version} />}
          {lod && (
            <Node sel={{ kind: 'lod' }} label="COGP（geo.lod）" meta={`${lod.levels.length} Level`} defaultOpen>
              {lod.levels.map((l) => (
                <Node
                  key={l.level}
                  sel={{ kind: 'level', level: l.level }}
                  label={`Level ${l.level}`}
                  meta={l.newFrom <= l.rowGroupEnd ? `+RG ${l.newFrom}–${l.rowGroupEnd}` : '+0'}
                  color={levelColor(l.level, nLevels)}
                />
              ))}
            </Node>
          )}
        </Node>
        <Node sel={{ kind: 'trailer' }} label='Footer 長 + "PAR1"' meta="8 B" />
      </Node>
    </ul>
  )
}
