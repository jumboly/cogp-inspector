import { describe, expect, it } from 'vitest'
import type { ReadRecord } from '../src/io/source'
import type { AccessPlan } from '../src/plan/accessPlan'
import { comparePlan } from '../src/plan/compare'

// 照合に使うのは Expected の 2 種類の Range だけなので、それ以外は省いた計画で試す
const plan = {
  stages: { pageIndex: { requests: [{ start: 1000, end: 1100 }] } },
  requests: [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
    { start: 40, end: 50 },
  ],
} as unknown as AccessPlan

let id = 0
const read = (offset: number, length: number, purpose: string, extra: Partial<ReadRecord> = {}): ReadRecord => ({ id: ++id, offset, length, purpose, startedAt: id, durationMs: 1, ...extra })

describe('comparePlan', () => {
  it('範囲が一致すれば予定どおり、無ければ予定外、読めなかった予定は未読', () => {
    const cmp = comparePlan(
      plan,
      [
        read(1000, 100, 'OffsetIndex RG0 geometry ほか 3 件（合体）'),
        read(0, 10, 'data RG0 geometry（2 ページ）'),
        read(20, 10, 'data RG1 geometry（1 ページ）'),
        // 計画に無い範囲（前の計画の Index の続きなど）
        read(2000, 50, 'ColumnIndex RG5 bbox.xmin'),
        // 中断した read は Actual に数えず、その範囲は未読になる
        read(40, 10, 'data RG2 geometry（1 ページ）', { error: 'aborted', aborted: true }),
        // 計画と関係のない read（ページヘッダ）は対象外
        read(0, 64, 'page-header RG0 geometry'),
      ],
      { data: true },
    )
    expect(cmp.reads.map((c) => c.match)).toEqual(['planned', 'planned', 'planned', 'unplanned', 'failed'])
    expect(cmp.unread).toEqual([{ kind: 'data', range: { start: 40, end: 50 } }])
    expect(cmp.expected).toEqual({ index: { requests: 1, bytes: 100 }, data: { requests: 3, bytes: 30 } })
    expect(cmp.actual.index).toMatchObject({ requests: 2, bytes: 150 })
    expect(cmp.actual.data).toMatchObject({ requests: 2, bytes: 20 })
  })

  it('同じ範囲を二度読んだら、二度目は予定外', () => {
    const cmp = comparePlan(plan, [read(0, 10, 'data RG0 geometry（2 ページ）'), read(0, 10, 'data RG0 geometry（2 ページ）')], { data: true })
    expect(cmp.reads.map((c) => c.match)).toEqual(['planned', 'unplanned'])
  })

  it('データページを比べないときは、データページの read も未読も出さない', () => {
    const cmp = comparePlan(plan, [read(1000, 100, 'OffsetIndex RG0 geometry'), read(0, 10, 'data RG0 geometry（2 ページ）')], { data: false })
    expect(cmp.reads).toHaveLength(1)
    expect(cmp.unread).toEqual([])
    expect(cmp.expected.data).toEqual({ requests: 3, bytes: 30 })
  })
})
