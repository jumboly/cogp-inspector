import type { Compressors } from 'hyparquet'
import { create } from 'zustand'
import { levelOfRowGroup } from '../cogp/lod'
import { dataBlocker, readPlanData, type DataBlocker, type DataReadResult, type DecodedFeature } from '../data/readData'
import { SourceError } from '../io/errors'
import type { RandomAccessSource, ReadRecord } from '../io/source'
import { TracedSource } from '../io/traced'
import { inspect, type Inspection } from '../inspect'
import { pageBboxesFromCache, pageBboxIndexWants, type PageBboxes } from '../geo/pageBbox'
import { PageCache, type ChunkPages } from '../parquet/pages'
import { defaultColumns, planAccess, type AccessPlan, type PlanInput } from '../plan/accessPlan'
import { addCost, incomparable, mapColumns, ZERO_COST, type CumulativeCost } from '../plan/compareFiles'

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
  /** id があれば、その read を選んでいる（Physical File Map でその範囲を示す） */
  | { kind: 'reads'; id?: number }
  | { kind: 'plan' }
  | { kind: 'diagnosis' }

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
  /**
   * plan の計算を始めた時刻と、最後に計算を始めた時刻（performance.now()）。
   * この間に始まった read を「その計画の Actual」とみなす（design.md D39）。計算中の新しい計画の read を古い計画に混ぜないため
   */
  planStartedAt?: number
  runStartedAt?: number
}

const SIM_OFF: SimulatorState = { enabled: false, columns: [], status: 'idle', focus: 'requests' }

/** 「実データを読む」（design.md D32）。Access Plan の計算が終わるたびに、その計画どおりに読んで描く */
export interface DataState {
  enabled: boolean
  status: 'idle' | 'reading' | 'done' | 'blocked' | 'error'
  blocker?: DataBlocker
  /** 読み込み中はその時点までの集計（doneRequests < requests）、読み終わると最終結果 */
  result?: DataReadResult
  error?: string
  /**
   * 地図に描く行。読み終わった Column Chunk から描き足す（design.md D38）。
   * 新しい計画の最初の Column Chunk が decode されるまでは、前の計画の行を残す（地図が一瞬空になるのを避ける）
   */
  features: DecodedFeature[]
}

const DATA_OFF: DataState = { enabled: false, status: 'idle', features: [] }

/**
 * 比較対象（design.md D44）。主ファイルとは別に 1 つ開き、Footer と Page Index だけを読む（実データは読まない）。
 * 同じ表示範囲で Access Plan を計算し、主ファイルの funnel と並べる
 */
export interface CompareState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  name?: string
  error?: string
  inspection?: Inspection
  pageCache?: PageCache
  /** 比較対象で実際に読んだ範囲。主ファイルの Range 記録・Physical File Map に混ぜないため別に持つ */
  reads: ReadRecord[]
  planStatus: 'idle' | 'running' | 'ready' | 'error'
  plan?: AccessPlan
  planError?: string
  /** 同じ表示範囲で比べられない理由（CRS が違うなど）。あれば計画は計算しない */
  incomparable?: string
  /** 主ファイルで選んだ列のうち、比較対象に同じ名前の列が無いもの */
  missingColumns: string[]
  /** Simulator を ON にしてから（または比較対象・読む列を変えてから）の累計。両方の計画がそろった回だけ足す */
  totals: { main: CumulativeCost; target: CumulativeCost }
}

const NO_TOTALS = { main: ZERO_COST, target: ZERO_COST }
const COMPARE_OFF: CompareState = { status: 'idle', reads: [], planStatus: 'idle', missingColumns: [], totals: NO_TOTALS }

// 展開ライブラリは「実データを読む」を初めて ON にしたときに読み込む（初期表示のバンドルを増やさない：D34）
let compressorsPromise: Promise<Compressors> | undefined
const loadCompressors = () => (compressorsPromise ??= import('hyparquet-compressors').then((m) => m.compressors))

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
  data: DataState
  compare: CompareState
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
  setDataEnabled: (enabled: boolean) => void
  /** 地図から呼ぶ。表示範囲と縮尺が変わるたびに Access Plan を計算し直す */
  runSimulation: (view: Omit<PlanInput, 'columns'>) => void
  openCompare: (open: () => Promise<RandomAccessSource>) => Promise<void>
  closeCompare: () => void
}

// 地図を続けて動かしたとき、古い計算の結果で新しい結果を上書きしないための通し番号
let simToken = 0
// 読み込み中の実データ。地図が動いたら中断する（design.md D33）
let dataAbort: AbortController | undefined
const abortData = () => {
  dataAbort?.abort()
  dataAbort = undefined
}

export const useStore = create<State>((set, get) => ({
  status: 'idle',
  reads: [],
  chunkPages: {},
  pageBboxes: {},
  hoverSpan: null,
  simulator: SIM_OFF,
  data: DATA_OFF,
  compare: COMPARE_OFF,
  selection: null,
  viewLevel: null,
  hoverRowGroup: null,

  async open(openSource) {
    abortData()
    set({ status: 'loading', error: undefined, inspection: undefined, pageCache: undefined, chunkPages: {}, pageBboxes: {}, hoverSpan: null, reads: [], simulator: SIM_OFF, data: DATA_OFF, compare: COMPARE_OFF, selection: null, viewLevel: null, hoverRowGroup: null })
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
      abortData()
      set({ simulator: { ...SIM_OFF, columns: simulator.columns }, data: DATA_OFF, compare: resetComparePlan(get().compare), viewLevel: null, selection: get().selection?.kind === 'plan' ? { kind: 'file' } : get().selection })
      return
    }
    // 計算は地図が表示範囲を渡したとき（runSimulation）に始まる
    set({
      simulator: { ...SIM_OFF, enabled: true, columns: simulator.columns.length ? simulator.columns : defaultColumns(inspection) },
      compare: resetComparePlan(get().compare),
      selection: { kind: 'plan' },
      selectOrigin: 'inspector',
    })
  },
  setSimulatorColumns(columns) {
    // 読む列が変わると 1 回あたりの量が変わるので、累計は数え直す
    set({ simulator: { ...get().simulator, columns }, compare: { ...get().compare, totals: NO_TOTALS } })
    const last = get().simulator.lastView
    if (last) get().runSimulation(last)
  },
  setPlanFocus: (focus) => set({ simulator: { ...get().simulator, focus } }),

  setDataEnabled(enabled) {
    abortData()
    if (!enabled) {
      set({ data: DATA_OFF })
      return
    }
    set({ data: { ...DATA_OFF, enabled: true } })
    const { plan, status } = get().simulator
    // 計算中なら、終わったときに runSimulation から読み始める
    if (plan && status === 'ready') readData(plan)
  },

  runSimulation(view) {
    const { inspection, pageCache, simulator } = get()
    if (!inspection || !pageCache || !simulator.enabled) return
    const token = ++simToken
    // 計画が変わるので、前の計画の実データの読み込みは止める（描いた結果は次の結果が出るまで残す）
    abortData()
    const startedAt = performance.now()
    set({ simulator: { ...simulator, status: 'running', lastView: view, runStartedAt: startedAt } })
    // 中断した計画の進み具合（n / m Range）を、新しい計画の計算中に出し続けないよう消す
    const { data } = get()
    if (data.status === 'reading') set({ data: { ...data, result: undefined } })
    const mainPlan = planAccess(inspection, pageCache, { ...view, columns: simulator.columns })
    const targetCache = get().compare.pageCache
    const targetPlan = planCompare(view, simulator.columns, token)
    // 累計は、同じ表示範囲について両方の計画がそろった回だけ足す（片方だけ足すと回数がずれて比べられない）
    void Promise.all([mainPlan, targetPlan]).then(
      ([m, t]) => {
        const c = get().compare
        if (token !== simToken || !t || c.pageCache !== targetCache) return
        set({ compare: { ...c, totals: { main: addCost(c.totals.main, m), target: addCost(c.totals.target, t) } } })
      },
      () => undefined,
    )
    mainPlan.then(
      (plan) => {
        if (token !== simToken || !get().simulator.enabled) return
        // Simulator の間は、選ばれた Level の prefix を地図に表示する（手動の Level 選択は無効：design.md D19）
        set({ simulator: { ...get().simulator, status: 'ready', plan, planStartedAt: startedAt, error: undefined }, viewLevel: plan.level.used ? (plan.level.level?.level ?? null) : null })
        if (get().data.enabled) readData(plan)
      },
      (e) => {
        if (token !== simToken) return
        set({ simulator: { ...get().simulator, status: 'error', error: (e as Error).message } })
      },
    )
  },

  async openCompare(openSource) {
    const pageCache = get().pageCache
    set({ compare: { ...COMPARE_OFF, status: 'loading' } })
    const setCompare = (patch: Partial<CompareState>) => set({ compare: { ...get().compare, ...patch } })
    try {
      const raw = await openSource()
      setCompare({ name: raw.name })
      const source = new TracedSource(raw, (r) => setCompare({ reads: [...get().compare.reads, r] }))
      const inspection = await inspect(source)
      // 開いている間に主ファイルを開き直していたら、古い比較対象は捨てる
      if (get().pageCache !== pageCache || get().compare.name !== raw.name) return
      const main = get().inspection
      setCompare({ status: 'ready', inspection, pageCache: new PageCache(source, inspection.file), incomparable: main ? incomparable(main, inspection) : undefined })
      const last = get().simulator.lastView
      if (get().simulator.enabled && last) get().runSimulation(last)
    } catch (e) {
      if (get().pageCache === pageCache) setCompare({ status: 'error', error: (e as Error).message })
    }
  },
  closeCompare: () => set({ compare: COMPARE_OFF }),
}))

/** Simulator の ON/OFF で計画と累計を捨てる（比較対象のファイルは開いたまま） */
function resetComparePlan(c: CompareState): CompareState {
  return { ...c, planStatus: 'idle', plan: undefined, planError: undefined, missingColumns: [], totals: NO_TOTALS }
}

/**
 * 比較対象の Access Plan を、主ファイルと同じ表示範囲・縮尺・列（名前で対応づけ）で計算する。
 * 比較対象が無い・比べられないときは undefined
 */
function planCompare(view: Omit<PlanInput, 'columns'>, mainColumns: number[], token: number): Promise<AccessPlan | undefined> {
  const { inspection: main, compare } = useStore.getState()
  const { inspection, pageCache } = compare
  if (!main || !inspection || !pageCache || compare.status !== 'ready' || compare.incomparable) return Promise.resolve(undefined)
  const setCompare = (patch: Partial<CompareState>) => {
    const c = useStore.getState().compare
    // 計算中に比較対象を閉じた・開き直したら捨てる
    if (c.pageCache === pageCache) useStore.setState({ compare: { ...c, ...patch } })
  }
  const { columns, missing } = mapColumns(main, inspection, mainColumns)
  setCompare({ planStatus: 'running', missingColumns: missing })
  const p = planAccess(inspection, pageCache, { ...view, columns })
  p.then(
    (plan) => {
      if (token === simToken) setCompare({ planStatus: 'ready', plan, planError: undefined })
    },
    (e) => {
      if (token === simToken) setCompare({ planStatus: 'error', planError: (e as Error).message })
    },
  )
  return p.catch(() => undefined)
}

/** 計画どおりに実データを読み、decode して地図に描く行を store に入れる */
function readData(plan: AccessPlan) {
  const { inspection, pageCache } = useStore.getState()
  const source = pageCache?.source
  if (!inspection || !source) return
  const setData = (patch: Partial<DataState>) => useStore.setState({ data: { ...useStore.getState().data, ...patch } })
  const blocker = dataBlocker(inspection, plan)
  if (blocker) {
    // 読めないときは前の描画も消す。残すと「いまの表示範囲で読んだ結果」と誤解させるため
    setData({ status: 'blocked', blocker, result: undefined, error: undefined, features: [] })
    return
  }
  abortData()
  const ac = new AbortController()
  dataAbort = ac
  setData({ status: 'reading', blocker: undefined, error: undefined, result: undefined })

  // decode した行と進み具合は描画フレームごとにまとめて store に入れる。
  // Column Chunk ごとに入れると、数万行の GeoJSON を地図に渡し直す回数が Range 数だけ増えて描画が詰まるため
  // 新しい計画で描く行。最初の行が出るまでは undefined のままにして、前の計画の行を地図に残す
  let features: DecodedFeature[] | undefined
  let progress: DataReadResult | undefined
  let frame: number | undefined
  const flush = () => {
    frame = undefined
    if (ac.signal.aborted) return
    const patch: Partial<DataState> = {}
    // 配列を作り直して渡す（zustand は参照が変わったときだけ地図に描き直させるため）
    if (features) patch.features = features.slice()
    if (progress) patch.result = progress
    setData(patch)
  }
  const schedule = () => {
    frame ??= requestAnimationFrame(flush)
  }
  const onChunk = (f: DecodedFeature[]) => {
    if (!f.length) return
    const acc = (features ??= [])
    // push(...f) は行数が大きいと引数の上限を超えるので 1 つずつ足す
    for (const x of f) acc.push(x)
    schedule()
  }
  const onProgress = (p: DataReadResult) => {
    progress = p
    schedule()
  }

  loadCompressors()
    .then((compressors) => readPlanData(inspection, source, plan, { compressors, signal: ac.signal, onChunk, onProgress }))
    .then(
      (result) => {
        if (frame !== undefined) cancelAnimationFrame(frame)
        if (ac.signal.aborted || !useStore.getState().data.enabled) return
        // 範囲内に描く行が 1 つも無かった場合も、前の計画の行は消す
        setData({ status: 'done', result, features: features ?? [] })
      },
      (e) => {
        if (frame !== undefined) cancelAnimationFrame(frame)
        // 中断は新しい計画に置き換わっただけなので、エラーとして見せない
        if (ac.signal.aborted) return
        setData({ status: 'error', error: (e as Error).message })
        // 1 つ失敗しても他の read は続いてしまう。結果はもう使わないので、残りを止めて通信を減らす
        ac.abort()
      },
    )
}
