import { useEffect, useMemo, useRef, useState } from 'react'
import type { Inspection } from '../../inspect'
import type { ByteRange } from '../../parquet/model'
import type { AccessPlan } from '../../plan/accessPlan'
import { useStore, type PlanStage } from '../../state/store'
import { PLAN_COLOR, READ_COLOR, SELECT_COLOR } from '../../util/color'
import { formatBytes, formatNumber } from '../../util/format'
import { buildSegments, DICT_COLOR, pageSegments, ROLE_COLOR, selectionRange, type Segment } from './segments'

const AXIS_H = 18
const LANES = [
  { key: 'structure', label: '構造', h: 26 },
  { key: 'chunk', label: 'Column Chunk', h: 14 },
  { key: 'page', label: 'Page', h: 14 },
  { key: 'plan', label: '読む予定', h: 14 },
  { key: 'reads', label: '読み込み', h: 14 },
] as const
const LABEL_W = 92
const GAP = 4
const HEIGHT = AXIS_H + LANES.reduce((a, l) => a + l.h + GAP, 0)
// 2.2GB 中の Footer（0.5MB）は等倍では 1px 未満になる。存在が見えるよう最小幅を持たせる
const MIN_PX = 2
const MIN_SPAN = 64

/**
 * Access Plan の funnel で選んだ段階に応じた「読む予定」の範囲。
 * Level・Row Group の段階では Column Chunk 単位、ページ以降はページ（合体後の Range）単位で示す。
 */
function plannedRanges(ins: Inspection, plan: AccessPlan | undefined, focus: PlanStage): { ranges: ByteRange[]; label: string } | undefined {
  if (!plan) return undefined
  const cols = new Set(plan.input.columns)
  const chunksOf = (rgs: number[]) => rgs.flatMap((rg) => ins.file.rowGroups[rg].columns.filter((c) => cols.has(c.column.index)).map((c) => c.range))
  if (focus === 'prefix') {
    const end = plan.stages.prefix.rowGroups
    return { ranges: chunksOf([...Array(end).keys()]), label: 'Level の prefix・選んだ列の Column Chunk' }
  }
  if (focus === 'rowGroupPruned') return { ranges: chunksOf(plan.rowGroups.map((r) => r.rg)), label: 'Row Group の bbox で残った・選んだ列の Column Chunk' }
  if (focus === 'pages') {
    return { ranges: plan.rowGroups.flatMap((r) => r.chunkRanges.filter((c) => cols.has(c.col)).flatMap((c) => c.ranges)), label: 'Page bbox で残ったページ' }
  }
  return { ranges: plan.requests, label: '合体後の Range Request' }
}

function laneTop(i: number) {
  return AXIS_H + LANES.slice(0, i).reduce((a, l) => a + l.h + GAP, 0)
}

/**
 * 目盛りの表記。拡大して表示幅が狭いと「2.09 GB」がすべての目盛りで同じになってしまうため、
 * 表示幅が 50MB 未満ならバイト数そのもので書く。
 */
function tickLabel(b: number, span: number) {
  return span < 50 * 1024 * 1024 ? formatNumber(Math.round(b)) : formatBytes(b)
}

function niceStep(span: number, targetTicks: number) {
  const raw = span / targetTicks
  const p = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? p * 10
}

interface View {
  start: number
  end: number
}

/**
 * ファイル全体を横長のバイト配置図として描く。
 * 上段が Row Group・Page Index・Footer の配置、中段が Column Chunk（列の役割で色分け）、下段が実際に読んだ範囲。
 * ホイールで拡大、ドラッグで移動、クリックで選択。
 */
export function ByteMap() {
  const ins = useStore((s) => s.inspection)
  if (!ins) return <p className="muted">ファイル全体のバイト配置と、読み込んだ範囲を表示します。</p>
  return <ByteMapCanvas key={ins.file.size + ':' + ins.file.rowGroups.length} ins={ins} />
}

function ByteMapCanvas({ ins }: { ins: Inspection }) {
  const reads = useStore((s) => s.reads)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const hoverRg = useStore((s) => s.hoverRowGroup)
  const chunkPages = useStore((s) => s.chunkPages)
  const sim = useStore((s) => s.simulator)
  const planned = useMemo(() => plannedRanges(ins, sim.enabled ? sim.plan : undefined, sim.focus), [ins, sim.enabled, sim.plan, sim.focus])
  const canvas = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const [view, setView] = useState<View>({ start: 0, end: ins.file.size })
  const [hover, setHover] = useState<Pick<Segment, 'label' | 'range' | 'sel'> | null>(null)
  const drag = useRef<{ x: number; view: View; moved: boolean } | null>(null)
  const baseSegments = useMemo(() => buildSegments(ins), [ins])
  const segments = useMemo(() => [...baseSegments, ...pageSegments(ins, chunkPages)], [baseSegments, ins, chunkPages])
  const selRange = selectionRange(ins, selection, chunkPages)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const plotW = width - LABEL_W
  const toX = (b: number) => LABEL_W + ((b - view.start) / (view.end - view.start)) * plotW
  const toByte = (x: number) => view.start + ((x - LABEL_W) / plotW) * (view.end - view.start)
  const rect = (r: ByteRange) => {
    const x0 = toX(r.start)
    const x1 = toX(r.end)
    const w = Math.max(x1 - x0, MIN_PX)
    return { x: x1 - x0 < MIN_PX ? x0 - (MIN_PX - (x1 - x0)) / 2 : x0, w }
  }

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = HEIGHT * dpr
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const css = getComputedStyle(c)
    const text = css.getPropertyValue('--text') || '#222'
    const muted = css.getPropertyValue('--muted') || '#888'
    const border = css.getPropertyValue('--border') || '#ddd'
    g.clearRect(0, 0, width, HEIGHT)
    g.font = '11px system-ui, sans-serif'
    g.textBaseline = 'middle'

    // 目盛り
    const step = niceStep(view.end - view.start, Math.max(2, Math.floor(plotW / 130)))
    g.fillStyle = muted
    g.strokeStyle = border
    for (let t = Math.ceil(view.start / step) * step; t <= view.end; t += step) {
      const x = toX(t)
      g.beginPath()
      g.moveTo(x, AXIS_H - 4)
      g.lineTo(x, HEIGHT)
      g.stroke()
      g.fillText(tickLabel(t, view.end - view.start), x + 2, 8)
    }

    LANES.forEach((lane, i) => {
      const y = laneTop(i)
      g.fillStyle = muted
      g.fillText(lane.label, 4, y + lane.h / 2)
      g.save()
      g.beginPath()
      g.rect(LABEL_W, y, plotW, lane.h)
      g.clip()
      if (lane.key === 'plan') {
        if (!planned) {
          g.fillStyle = muted
          g.fillText('Access Simulator を ON にすると、表示範囲から推定した読む範囲を表示します', LABEL_W + 6, y + lane.h / 2)
        } else {
          g.fillStyle = PLAN_COLOR
          for (const r of planned.ranges) {
            if (r.end < view.start || r.start > view.end) continue
            const { x, w } = rect(r)
            g.fillRect(x, y, w, lane.h)
          }
        }
      } else if (lane.key === 'page' && !segments.some((s) => s.lane === 'page')) {
        g.fillStyle = muted
        g.fillText('Column Chunk を選ぶと、その Chunk のページを読んで表示します', LABEL_W + 6, y + lane.h / 2)
      } else if (lane.key === 'reads') {
        g.fillStyle = READ_COLOR
        for (const r of reads) {
          const { x, w } = rect({ start: r.offset, end: r.offset + r.length })
          g.fillRect(x, y, w, lane.h)
        }
      } else {
        for (const s of segments) {
          if (s.lane !== lane.key || s.range.end < view.start || s.range.start > view.end) continue
          const { x, w } = rect(s.range)
          g.fillStyle = s.color
          g.fillRect(x, y, w, lane.h)
          // 隣り合うページが 1 本の帯に見えないよう、十分な幅があれば境目を描く
          if (lane.key === 'page' && w > 4) {
            g.fillStyle = 'rgba(255,255,255,0.7)'
            g.fillRect(x, y, 1, lane.h)
          }
          if (lane.key === 'structure' && w > 44) {
            g.fillStyle = '#fff'
            g.fillText(s.label.split(' · ')[0], Math.max(x, LABEL_W) + 3, y + lane.h / 2)
          }
        }
      }
      g.restore()
    })

    // 地図でホバー中の Row Group と、選択範囲の枠
    const outline = (r: ByteRange, color: string, dash: number[]) => {
      const { x, w } = rect(r)
      g.save()
      g.strokeStyle = color
      g.lineWidth = 2
      g.setLineDash(dash)
      g.strokeRect(x - 1, AXIS_H - 1, w + 2, HEIGHT - AXIS_H - GAP + 2)
      g.restore()
    }
    if (hoverRg !== null) outline(ins.file.rowGroups[hoverRg].range, SELECT_COLOR, [3, 2])
    if (selRange) outline(selRange, SELECT_COLOR, [])
    g.fillStyle = text
  }, [width, view, segments, reads, selRange, hoverRg, ins, plotW, planned])

  const hitTest = (x: number, y: number) => {
    const laneIdx = LANES.findIndex((_, i) => y >= laneTop(i) && y < laneTop(i) + LANES[i].h)
    if (laneIdx < 0 || x < LABEL_W) return null
    const lane = LANES[laneIdx].key
    if (lane === 'plan') {
      const r = planned?.ranges.find((r) => {
        const { x: rx, w } = rect(r)
        return x >= rx && x <= rx + w
      })
      return r ? { label: `読む予定（${planned!.label}）`, range: r, sel: { kind: 'plan' } as const } : null
    }
    if (lane === 'reads') {
      const r = [...reads].reverse().find((r) => {
        const { x: rx, w } = rect({ start: r.offset, end: r.offset + r.length })
        return x >= rx && x <= rx + w
      })
      return r ? { label: `読み込み #${r.id}: ${r.purpose}`, range: { start: r.offset, end: r.offset + r.length }, sel: { kind: 'reads' } as const } : null
    }
    // 最小幅で広げて描いた領域も拾えるよう、描画と同じ矩形で判定する（後に描いたものが上）
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i]
      if (s.lane !== lane) continue
      const { x: sx, w } = rect(s.range)
      if (x >= sx && x <= sx + w) return s
    }
    return null
  }

  const zoomTo = (r: ByteRange | undefined, pad = 0.15) => {
    if (!r) return
    const span = Math.max(r.end - r.start, MIN_SPAN)
    const start = Math.max(0, r.start - span * pad)
    const end = Math.min(ins.file.size, r.start + span * (1 + pad))
    setView({ start, end })
  }

  const clampView = (v: View): View => {
    const span = Math.min(Math.max(v.end - v.start, MIN_SPAN), ins.file.size)
    const start = Math.min(Math.max(v.start, 0), ins.file.size - span)
    return { start, end: start + span }
  }

  // React の onWheel は passive で preventDefault できないため、ページのスクロールを止めるには直接登録する
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const x = e.offsetX
      setView((v) => {
        const at = v.start + ((x - LABEL_W) / plotW) * (v.end - v.start)
        const k = Math.exp(e.deltaY * 0.002)
        return clampView({ start: at - (at - v.start) * k, end: at + (v.end - at) * k })
      })
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  })

  const span = view.end - view.start
  return (
    <div className="bytemap" ref={wrap}>
      <div className="bytemap-bar">
        <button onClick={() => setView({ start: 0, end: ins.file.size })}>全体</button>
        <button onClick={() => zoomTo(selRange)} disabled={!selRange}>
          選択範囲へ
        </button>
        <button onClick={() => zoomTo({ start: ins.file.pageIndex?.start ?? ins.file.footer.start, end: ins.file.size }, 0.05)}>末尾（Footer 周辺）へ</button>
        <span className="legend">
          <i style={{ background: ROLE_COLOR.geometry }} /> geometry <i style={{ background: ROLE_COLOR.covering }} /> bbox covering <i style={{ background: ROLE_COLOR.attribute }} /> 属性 <i style={{ background: DICT_COLOR }} /> 辞書ページ <i style={{ background: PLAN_COLOR }} /> 読む予定 <i style={{ background: READ_COLOR }} /> 読んだ範囲
        </span>
        <span className="muted bytemap-info">
          {hover
            ? `${hover.label} ｜ ${formatNumber(hover.range.start)} – ${formatNumber(hover.range.end - 1)}（${formatBytes(hover.range.end - hover.range.start)}）`
            : `表示中 ${tickLabel(view.start, span)} – ${tickLabel(view.end, span)}（${formatBytes(span)}）｜ホイールで拡大・ドラッグで移動・クリックで選択`}
        </span>
      </div>
      <canvas
        ref={canvas}
        style={{ width, height: HEIGHT }}
        onMouseDown={(e) => (drag.current = { x: e.nativeEvent.offsetX, view, moved: false })}
        onMouseMove={(e) => {
          const { offsetX: x, offsetY: y } = e.nativeEvent
          const d = drag.current
          if (d) {
            const dx = x - d.x
            if (Math.abs(dx) > 3) d.moved = true
            if (d.moved) {
              const db = (dx / plotW) * (d.view.end - d.view.start)
              setView(clampView({ start: d.view.start - db, end: d.view.end - db }))
            }
            return
          }
          setHover(hitTest(x, y))
        }}
        onMouseLeave={() => {
          drag.current = null
          setHover(null)
        }}
        onMouseUp={(e) => {
          const d = drag.current
          drag.current = null
          if (d?.moved) return
          const hit = hitTest(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
          if (hit) select(hit.sel, 'bytemap')
        }}
        onDoubleClick={(e) => {
          const at = toByte(e.nativeEvent.offsetX)
          const s = span / 4
          setView(clampView({ start: at - s / 2, end: at + s / 2 }))
        }}
      />
    </div>
  )
}
