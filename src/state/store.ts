import { create } from 'zustand'
import { levelOfRowGroup } from '../cogp/lod'
import { SourceError } from '../io/errors'
import type { RandomAccessSource, ReadRecord } from '../io/source'
import { TracedSource } from '../io/traced'
import { inspect, type Inspection } from '../inspect'
import { pageBboxesFromCache, pageBboxIndexWants, type PageBboxes } from '../geo/pageBbox'
import { PageCache, type ChunkPages } from '../parquet/pages'
import { defaultColumns, planAccess, type AccessPlan, type PlanInput } from '../plan/accessPlan'

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
  /** page は ChunkPages.pages の添字（辞書ページがあれば 0 が辞書ページ） */
  | { kind: 'page'; rg: number; col: number; page: number }
  | { kind: 'pageIndex' }
  | { kind: 'reads' }
  | { kind: 'plan' }

/** 選択の発生元。地図以外で選んだときだけ地図をその場所へ動かす */
export type SelectOrigin = 'map' | 'tree' | 'bytemap' | 'inspector'

export type Loadable<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: string }

/** Access Plan の funnel のどの段を見ているか。地図と Physical File Map の強調に使う */
export type PlanStage = 'prefix' | 'rowGroupPruned' | 'pages' | 'requests'

export interface SimulatorState {
  enabled: boolean
  columns: number[]
  status: 'idle' | 'running' | 'ready' | 'error'
  plan?: AccessPlan
  error?: string
  focus: PlanStage
  /** 最後に計算した表示範囲と縮尺。列を変えたときに同じ範囲で計算し直すため */
  lastView?: Omit<PlanInput, 'columns'>
}

const SIM_OFF: SimulatorState = { enabled: false, columns: [], status: 'idle', focus: 'requests' }

export const chunkKey = (rg: number, col: number) => `${rg}:${col}`

interface State {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: { message: string; hint?: string }
  sourceName?: string
  sourceKind?: RandomAccessSource['kind']
  inspection?: Inspection
  /** Footer 以降の読み込み（Page Index・ページヘッダ）に使う。読んだものはすべて reads に記録される */
  pageCache?: PageCache
  /** Column Chunk ごとのページ一覧（キーは chunkKey）。選んだ Column Chunk の分だけ読む */
  chunkPages: Record<string, Loadable<ChunkPages>>
  /** Row Group ごとの Page bbox（キーは Row Group 番号）。選んだ Row Group の分だけ読む */
  pageBboxes: Record<number, Loadable<PageBboxes>>
  /** Inspector の Page bbox 一覧でホバー中の行範囲（地図で強調する） */
  hoverSpan: { rg: number; span: number } | null
  reads: ReadRecord[]
  simulator: SimulatorState
  selection: Selection | null
  selectOrigin?: SelectOrigin
  /** 地図に表示する Level（null = すべての Row Group を表示） */
  viewLevel: number | null
  hoverRowGroup: number | null
  open: (open: () => Promise<RandomAccessSource>) => Promise<void>
  select: (s: Selection | null, origin: SelectOrigin) => void
  setViewLevel: (level: number | null) => void
  setHoverRowGroup: (rg: number | null) => void
  loadChunkPages: (rg: number, col: number) => void
  loadPageBboxes: (rg: number) => void
  setHoverSpan: (h: { rg: number; span: number } | null) => void
  setSimulatorEnabled: (enabled: boolean) => void
  setSimulatorColumns: (columns: number[]) => void
  setPlanFocus: (focus: PlanStage) => void
  /** 地図から呼ぶ。表示範囲と縮尺が変わるたびに Access Plan を計算し直す */
  runSimulation: (view: Omit<PlanInput, 'columns'>) => void
}

// 地図を続けて動かしたとき、古い計算の結果で新しい結果を上書きしないための通し番号
let simToken = 0

export const useStore = create<State>((set, get) => ({
  status: 'idle',
  reads: [],
  chunkPages: {},
  pageBboxes: {},
  hoverSpan: null,
  simulator: SIM_OFF,
  selection: null,
  viewLevel: null,
  hoverRowGroup: null,

  async open(openSource) {
    set({ status: 'loading', error: undefined, inspection: undefined, pageCache: undefined, chunkPages: {}, pageBboxes: {}, hoverSpan: null, reads: [], simulator: SIM_OFF, selection: null, viewLevel: null, hoverRowGroup: null })
    try {
      const raw = await openSource()
      set({ sourceName: raw.name, sourceKind: raw.kind })
      const source = new TracedSource(raw, (r) => set({ reads: [...get().reads, r] }))
      const inspection = await inspect(source)
      set({ status: 'ready', inspection, pageCache: new PageCache(source, inspection.file), selection: { kind: 'file' }, selectOrigin: 'tree' })
    } catch (e) {
      const err = e instanceof SourceError ? { message: e.message, hint: e.hint } : { message: (e as Error).message }
      set({ status: 'error', error: err })
    }
  },

  select(selection, origin) {
    // Row Group を選んだら、その Row Group が属する Level も地図上で分かるよう表示 Level を合わせる
    const patch: Partial<State> = { selection, selectOrigin: origin }
    // Simulator の間は表示 Level を Simulator が決めるので、選択では変えない（design.md D19）
    const manualLevel = !get().simulator.enabled
    if (manualLevel && selection?.kind === 'level') patch.viewLevel = selection.level
    if (selection?.kind === 'column' || selection?.kind === 'page') get().loadChunkPages(selection.rg, selection.col)
    // Row Group の中のものを選んだら、その Row Group のページの空間範囲も読む（design.md D15）
    if (selection?.kind === 'rowGroup' || selection?.kind === 'column' || selection?.kind === 'page') get().loadPageBboxes(selection.rg)
    if (manualLevel && selection?.kind === 'rowGroup') {
      const view = get().viewLevel
      const lod = get().inspection?.lod
      const lv = levelOfRowGroup(lod, selection.rg)
      if (view !== null && lv !== undefined && lv > view) patch.viewLevel = lv
    }
    set(patch)
  },
  setViewLevel: (viewLevel) => {
    if (!get().simulator.enabled) set({ viewLevel })
  },
  setHoverRowGroup: (hoverRowGroup) => set({ hoverRowGroup }),

  loadChunkPages(rg, col) {
    const { pageCache, inspection, chunkPages } = get()
    const k = chunkKey(rg, col)
    if (!pageCache || !inspection || chunkPages[k]?.status === 'ready' || chunkPages[k]?.status === 'loading') return
    const chunk = inspection.file.rowGroups[rg].columns[col]
    set({ chunkPages: { ...chunkPages, [k]: { status: 'loading' } } })
    const done = (v: Loadable<ChunkPages>) => {
      // 読み込み中に別のファイルを開いていたら、古い結果は捨てる
      if (get().pageCache === pageCache) set({ chunkPages: { ...get().chunkPages, [k]: v } })
    }
    pageCache.pages(chunk).then(
      (data) => done({ status: 'ready', data }),
      (e) => done({ status: 'error', error: (e as Error).message }),
    )
  },

  loadPageBboxes(rg) {
    const { pageCache, inspection, pageBboxes } = get()
    if (!pageCache || !inspection || pageBboxes[rg]?.status === 'ready' || pageBboxes[rg]?.status === 'loading') return
    const model = inspection.file.rowGroups[rg]
    set({ pageBboxes: { ...pageBboxes, [rg]: { status: 'loading' } } })
    const done = (v: Loadable<PageBboxes>) => {
      if (get().pageCache === pageCache) set({ pageBboxes: { ...get().pageBboxes, [rg]: v } })
    }
    pageCache.loadIndexes(pageBboxIndexWants(model, inspection.geo)).then(
      () => done({ status: 'ready', data: pageBboxesFromCache(pageCache, model, inspection.geo) }),
      (e) => done({ status: 'error', error: (e as Error).message }),
    )
  },
  setHoverSpan: (hoverSpan) => set({ hoverSpan }),

  setSimulatorEnabled(enabled) {
    const { inspection, simulator } = get()
    if (!inspection) return
    if (!enabled) {
      set({ simulator: { ...SIM_OFF, columns: simulator.columns }, viewLevel: null, selection: get().selection?.kind === 'plan' ? { kind: 'file' } : get().selection })
      return
    }
    // 計算は地図が表示範囲を渡したとき（runSimulation）に始まる
    set({
      simulator: { ...SIM_OFF, enabled: true, columns: simulator.columns.length ? simulator.columns : defaultColumns(inspection) },
      selection: { kind: 'plan' },
      selectOrigin: 'inspector',
    })
  },
  setSimulatorColumns(columns) {
    set({ simulator: { ...get().simulator, columns } })
    const last = get().simulator.lastView
    if (last) get().runSimulation(last)
  },
  setPlanFocus: (focus) => set({ simulator: { ...get().simulator, focus } }),

  runSimulation(view) {
    const { inspection, pageCache, simulator } = get()
    if (!inspection || !pageCache || !simulator.enabled) return
    const token = ++simToken
    set({ simulator: { ...simulator, status: 'running', lastView: view } })
    planAccess(inspection, pageCache, { ...view, columns: simulator.columns }).then(
      (plan) => {
        if (token !== simToken || !get().simulator.enabled) return
        // Simulator の間は、選ばれた Level の prefix を地図に表示する（手動の Level 選択は無効：design.md D19）
        set({ simulator: { ...get().simulator, status: 'ready', plan, error: undefined }, viewLevel: plan.level.used ? (plan.level.level?.level ?? null) : null })
      },
      (e) => {
        if (token !== simToken) return
        set({ simulator: { ...get().simulator, status: 'error', error: (e as Error).message } })
      },
    )
  },
}))
