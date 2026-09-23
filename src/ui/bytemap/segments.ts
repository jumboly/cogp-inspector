import { levelOfRowGroup } from '../../cogp/lod'
import type { Inspection } from '../../inspect'
import type { ByteRange } from '../../parquet/model'
import type { ChunkPages } from '../../parquet/pages'
import type { Loadable, Selection } from '../../state/store'
import { levelColor, NEUTRAL } from '../../util/color'
import { columnRole, type ColumnRole } from '../inspector/columnRole'

export type Lane = 'structure' | 'chunk' | 'page'

export interface Segment {
  lane: Lane
  range: ByteRange
  color: string
  label: string
  sel: Selection
}

// Okabe-Ito 配色の一部。色覚の違いがあっても区別しやすい
export const ROLE_COLOR: Record<ColumnRole, string> = {
  geometry: '#e69f00',
  covering: '#0072b2',
  attribute: '#9a9aa6',
}

/** ファイルを構成する領域を、先頭から末尾の順に並べる */
export function buildSegments(ins: Inspection): Segment[] {
  const { file, lod, geo } = ins
  const n = lod?.levels.length ?? 0
  const segs: Segment[] = [{ lane: 'structure', range: file.headerMagic, color: '#444', label: 'magic', sel: { kind: 'header' } }]
  for (const rg of file.rowGroups) {
    const lv = levelOfRowGroup(lod, rg.index)
    segs.push({
      lane: 'structure',
      range: rg.range,
      color: lv === undefined ? NEUTRAL : levelColor(lv, n),
      label: `RG ${rg.index}${lv === undefined ? '' : ` · Level ${lv}`}`,
      sel: { kind: 'rowGroup', rg: rg.index },
    })
    rg.columns.forEach((c, ci) =>
      segs.push({
        lane: 'chunk',
        range: c.range,
        color: ROLE_COLOR[columnRole(c.column, geo)],
        label: `RG ${rg.index} · ${c.column.name}`,
        sel: { kind: 'column', rg: rg.index, col: ci },
      }),
    )
  }
  if (file.pageIndex) segs.push({ lane: 'structure', range: file.pageIndex, color: '#b07aa1', label: 'Page Index', sel: { kind: 'pageIndex' } })
  segs.push({ lane: 'structure', range: file.footer, color: '#222', label: 'Footer', sel: { kind: 'footer' } })
  segs.push({ lane: 'structure', range: file.trailer, color: '#444', label: 'trailer', sel: { kind: 'trailer' } })
  return segs
}

export const DICT_COLOR = '#8e6c8a'
export const HEADER_COLOR = '#222'

/**
 * 読み込み済みの Column Chunk のページ。ページ本体の上に、先頭のページヘッダを重ねて描く
 * （ヘッダは 20 バイト前後なので、拡大したときだけ見える）。
 */
export function pageSegments(ins: Inspection, chunkPages: Record<string, Loadable<ChunkPages>>): Segment[] {
  const segs: Segment[] = []
  for (const [k, st] of Object.entries(chunkPages)) {
    if (st.status !== 'ready') continue
    const [rg, col] = k.split(':').map(Number)
    const chunk = ins.file.rowGroups[rg].columns[col]
    const color = ROLE_COLOR[columnRole(chunk.column, ins.geo)]
    for (const p of st.data.pages) {
      const sel: Selection = { kind: 'page', rg, col, page: p.index }
      const name = `RG ${rg} · ${chunk.column.name} · Page #${p.index}${p.kind === 'dictionary' ? '（辞書）' : ''}`
      segs.push({ lane: 'page', range: p.range, color: p.kind === 'dictionary' ? DICT_COLOR : color, label: name, sel })
      if (p.header) segs.push({ lane: 'page', range: { start: p.range.start, end: p.range.start + p.header.headerSize }, color: HEADER_COLOR, label: `${name} のページヘッダ`, sel })
    }
  }
  return segs
}

/** 選択に対応するファイル内の範囲。Level は「RG 0 から row_group_end まで」の連続範囲（prefix）になる */
export function selectionRange(ins: Inspection, sel: Selection | null, chunkPages?: Record<string, Loadable<ChunkPages>>): ByteRange | undefined {
  if (!sel) return undefined
  const { file, lod } = ins
  switch (sel.kind) {
    case 'rowGroup':
      return file.rowGroups[sel.rg].range
    case 'column':
      return file.rowGroups[sel.rg].columns[sel.col].range
    case 'page': {
      const st = chunkPages?.[`${sel.rg}:${sel.col}`]
      return st?.status === 'ready' ? st.data.pages[sel.page]?.range : file.rowGroups[sel.rg].columns[sel.col].range
    }
    case 'footer':
    case 'schema':
    case 'geo':
    case 'lod':
      return file.footer
    case 'trailer':
      return file.trailer
    case 'header':
      return file.headerMagic
    case 'pageIndex':
      return file.pageIndex
    case 'plan':
      return undefined
    case 'level': {
      const end = lod?.levels[sel.level]?.rowGroupEnd
      if (end === undefined || !file.rowGroups.length) return undefined
      return { start: file.rowGroups[0].range.start, end: file.rowGroups[Math.min(end, file.rowGroups.length - 1)].range.end }
    }
    case 'rowGroups':
      return file.rowGroups.length ? { start: file.rowGroups[0].range.start, end: file.rowGroups.at(-1)!.range.end } : undefined
    default:
      return undefined
  }
}
