import { create } from 'zustand'
import { levelOfRowGroup } from '../cogp/lod'
import { SourceError } from '../io/errors'
import type { RandomAccessSource, ReadRecord } from '../io/source'
import { TracedSource } from '../io/traced'
import { inspect, type Inspection } from '../inspect'

/**
 * Tree / Map / Inspector / ByteMap が共有する「いま何を見ているか」。
 * 1 つの選択を全ペインが購読することで、地図で選んだ Row Group がファイル上のどこかを同時に示せる。
 */
export type Selection =
  | { kind: 'file' }
  | { kind: 'header' }
  | { kind: 'footer' }
  | { kind: 'trailer' }
  | { kind: 'schema' }
  | { kind: 'geo' }
  | { kind: 'lod' }
  | { kind: 'level'; level: number }
  | { kind: 'rowGroups' }
  | { kind: 'rowGroup'; rg: number }
  | { kind: 'column'; rg: number; col: number }
  | { kind: 'pageIndex' }
  | { kind: 'reads' }

/** 選択の発生元。地図以外で選んだときだけ地図をその場所へ動かす */
export type SelectOrigin = 'map' | 'tree' | 'bytemap' | 'inspector'

interface State {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: { message: string; hint?: string }
  sourceName?: string
  sourceKind?: RandomAccessSource['kind']
  inspection?: Inspection
  reads: ReadRecord[]
  selection: Selection | null
  selectOrigin?: SelectOrigin
  /** 地図に表示する Level（null = すべての Row Group を表示） */
  viewLevel: number | null
  hoverRowGroup: number | null
  open: (open: () => Promise<RandomAccessSource>) => Promise<void>
  select: (s: Selection | null, origin: SelectOrigin) => void
  setViewLevel: (level: number | null) => void
  setHoverRowGroup: (rg: number | null) => void
}

export const useStore = create<State>((set, get) => ({
  status: 'idle',
  reads: [],
  selection: null,
  viewLevel: null,
  hoverRowGroup: null,

  async open(openSource) {
    set({ status: 'loading', error: undefined, inspection: undefined, reads: [], selection: null, viewLevel: null, hoverRowGroup: null })
    try {
      const raw = await openSource()
      set({ sourceName: raw.name, sourceKind: raw.kind })
      const source = new TracedSource(raw, (r) => set({ reads: [...get().reads, r] }))
      const inspection = await inspect(source)
      set({ status: 'ready', inspection, selection: { kind: 'file' }, selectOrigin: 'tree' })
    } catch (e) {
      const err = e instanceof SourceError ? { message: e.message, hint: e.hint } : { message: (e as Error).message }
      set({ status: 'error', error: err })
    }
  },

  select(selection, origin) {
    // Row Group を選んだら、その Row Group が属する Level も地図上で分かるよう表示 Level を合わせる
    const patch: Partial<State> = { selection, selectOrigin: origin }
    if (selection?.kind === 'level') patch.viewLevel = selection.level
    if (selection?.kind === 'rowGroup') {
      const view = get().viewLevel
      const lod = get().inspection?.lod
      const lv = levelOfRowGroup(lod, selection.rg)
      if (view !== null && lv !== undefined && lv > view) patch.viewLevel = lv
    }
    set(patch)
  },
  setViewLevel: (viewLevel) => set({ viewLevel }),
  setHoverRowGroup: (hoverRowGroup) => set({ hoverRowGroup }),
}))
