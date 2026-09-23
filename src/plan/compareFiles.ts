import type { Inspection } from '../inspect'
import type { AccessPlan } from './accessPlan'

/**
 * 開いているファイルと「比較対象」のファイルを、同じ表示範囲の Access Plan で比べる（design.md D44）。
 * 比較対象は実データを読まないので、比べるのは両方とも推定（Expected）の値にそろえる。
 */

export interface PlanCost {
  /** 計画の途中で新たに読む Page Index（合体後の Range。キャッシュ済みの分は含まない） */
  indexRequests: number
  indexBytes: number
  /** データページを読む Range Request（合体後）とバイト数 */
  dataRequests: number
  dataBytes: number
}

export interface CumulativeCost extends PlanCost {
  /** 足し合わせた計画の数（地図を動かした回数） */
  plans: number
}

export const ZERO_COST: CumulativeCost = { plans: 0, indexRequests: 0, indexBytes: 0, dataRequests: 0, dataBytes: 0 }

export function planCost(plan: AccessPlan): PlanCost {
  const idx = plan.stages.pageIndex.requests
  return {
    indexRequests: idx.length,
    indexBytes: idx.reduce((a, r) => a + r.end - r.start, 0),
    dataRequests: plan.requests.length,
    dataBytes: plan.stages.requests.bytes,
  }
}

export function addCost(acc: CumulativeCost, plan: AccessPlan): CumulativeCost {
  const c = planCost(plan)
  return {
    plans: acc.plans + 1,
    indexRequests: acc.indexRequests + c.indexRequests,
    indexBytes: acc.indexBytes + c.indexBytes,
    dataRequests: acc.dataRequests + c.dataRequests,
    dataBytes: acc.dataBytes + c.dataBytes,
  }
}

/**
 * 主ファイルで選んだ列を、比較対象の同じ名前の列に対応づける。
 * 列の並びはファイルごとに違いうる（cogp は bbox 列を作り直す）ので、番号ではなく名前で合わせる
 */
export function mapColumns(main: Inspection, target: Inspection, columns: number[]): { columns: number[]; missing: string[] } {
  const byName = new Map(target.file.leafColumns.map((c) => [c.name, c.index]))
  const out: number[] = []
  const missing: string[] = []
  for (const i of columns) {
    const name = main.file.leafColumns[i]?.name
    const j = name === undefined ? undefined : byName.get(name)
    if (j === undefined) missing.push(name ?? `#${i}`)
    else out.push(j)
  }
  return { columns: out.sort((a, b) => a - b), missing }
}

/**
 * 同じ表示範囲を比べられないときの理由。表示範囲は主ファイルの CRS で渡されるので、CRS が違うと同じ範囲にならない
 */
export function incomparable(main: Inspection, target: Inspection): string | undefined {
  const a = main.geo?.primary?.crs.mapProjection
  const b = target.geo?.primary?.crs.mapProjection
  if (!b) return '比較対象の CRS が地図表示に未対応のため、同じ表示範囲で計算できない'
  if (a !== b) return '2 つのファイルの CRS が違うため、同じ表示範囲で計算できない'
  return undefined
}
