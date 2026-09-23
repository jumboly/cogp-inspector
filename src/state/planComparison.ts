import { useMemo } from 'react'
import { geometryColumn } from '../data/readData'
import { comparePlan, expectedDecodedRows, type PlanComparison } from '../plan/compare'
import { useStore } from './store'

/**
 * いま表示している計画の Expected vs Actual。Access Plan と Physical File Map の両方で使う。
 * reads は read が 1 つ終わるたびに増えるので、読み込み中は途中までの突き合わせになる。
 */
export function usePlanComparison(): (PlanComparison & { expectedRows: number }) | undefined {
  const ins = useStore((s) => s.inspection)
  const sim = useStore((s) => s.simulator)
  const reads = useStore((s) => s.reads)
  // 読まない判定（blocked）のときは、データページは比べない（読まないのが正しい）
  const dataOn = useStore((s) => s.data.enabled && s.data.status !== 'blocked')
  const plan = sim.enabled ? sim.plan : undefined
  const { planStartedAt: from, runStartedAt } = sim
  return useMemo(() => {
    if (!ins || !plan || from === undefined) return undefined
    const to = runStartedAt !== undefined && runStartedAt > from ? runStartedAt : Infinity
    const mine = reads.filter((r) => r.startedAt >= from && r.startedAt < to)
    return { ...comparePlan(plan, mine, { data: dataOn }), expectedRows: expectedDecodedRows(plan, geometryColumn(ins)?.index) }
  }, [ins, plan, from, runStartedAt, reads, dataOn])
}
