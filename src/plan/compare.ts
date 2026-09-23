import { readCategory } from '../io/readCategory'
import type { ReadRecord } from '../io/source'
import type { ByteRange } from '../parquet/model'
import type { AccessPlan } from './accessPlan'

/**
 * Expected vs Actual（design.md D39・D40）。1 回の計画について、推定した Range と実際の read を突き合わせる。
 * 比べるのは計画が決める 2 種類の read だけ: Page Index（計画の途中で新たに読む Index）とデータページ。
 * Footer やページヘッダ（Column Chunk を選んだときの読み込み）は計画と関係がないので対象にしない。
 */

export type ReadKind = 'index' | 'data'

/**
 * planned = Expected の Range と範囲が一致した read、unplanned = Expected に無い read、
 * failed = 中断・失敗した read（読めていないので、対応する Expected は未読として残る）
 */
export type ReadMatch = 'planned' | 'unplanned' | 'failed'

export interface ComparedRead {
  read: ReadRecord
  kind: ReadKind
  match: ReadMatch
}

export interface Side {
  requests: number
  bytes: number
}

export interface PlanComparison {
  reads: ComparedRead[]
  /** 読む予定だったが、成功した read が無い Range */
  unread: { kind: ReadKind; range: ByteRange }[]
  expected: Record<ReadKind, Side>
  /** 成功した read だけを数える。ms はその種類の最初の read の開始から最後の read の終了まで */
  actual: Record<ReadKind, Side & { ms?: number }>
  /** データページを突き合わせたか（「実データを読む」が OFF・読まない判定のときは Expected だけを出す） */
  dataCompared: boolean
}

function kindOf(r: ReadRecord): ReadKind | undefined {
  const c = readCategory(r.purpose)
  if (c === 'offset-index' || c === 'column-index') return 'index'
  if (c === 'data-page') return 'data'
  return undefined
}

const side = (ranges: ByteRange[]): Side => ({ requests: ranges.length, bytes: ranges.reduce((a, r) => a + r.end - r.start, 0) })
const rangeKey = (kind: ReadKind, start: number, end: number) => `${kind}:${start}:${end}`

/** reads はこの計画の時間帯に始まった read（呼び出し側で絞る）。順番は問わない */
export function comparePlan(plan: AccessPlan, reads: ReadRecord[], opts: { data: boolean }): PlanComparison {
  const expectedRanges: Record<ReadKind, ByteRange[]> = { index: plan.stages.pageIndex.requests, data: plan.requests }
  const compared: ReadKind[] = opts.data ? ['index', 'data'] : ['index']

  // 同じ範囲を二度読む計画はないが、念のため個数で照合する（二度目の read は予定外として見せる）
  const remaining = new Map<string, number>()
  for (const k of compared) for (const r of expectedRanges[k]) remaining.set(rangeKey(k, r.start, r.end), (remaining.get(rangeKey(k, r.start, r.end)) ?? 0) + 1)

  const out: ComparedRead[] = []
  const ok: Record<ReadKind, ByteRange[]> = { index: [], data: [] }
  const span: Partial<Record<ReadKind, { start: number; end: number }>> = {}
  for (const read of [...reads].sort((a, b) => a.startedAt - b.startedAt)) {
    const kind = kindOf(read)
    if (!kind || !compared.includes(kind)) continue
    const s = (span[kind] ??= { start: read.startedAt, end: read.startedAt })
    s.end = Math.max(s.end, read.startedAt + read.durationMs)
    if (read.error) {
      out.push({ read, kind, match: 'failed' })
      continue
    }
    const k = rangeKey(kind, read.offset, read.offset + read.length)
    const n = remaining.get(k) ?? 0
    if (n > 0) remaining.set(k, n - 1)
    out.push({ read, kind, match: n > 0 ? 'planned' : 'unplanned' })
    ok[kind].push({ start: read.offset, end: read.offset + read.length })
  }

  const unread: PlanComparison['unread'] = []
  for (const k of compared) {
    for (const r of expectedRanges[k]) {
      const key = rangeKey(k, r.start, r.end)
      const n = remaining.get(key) ?? 0
      if (n > 0) {
        remaining.set(key, n - 1)
        unread.push({ kind: k, range: r })
      }
    }
  }

  const actualOf = (k: ReadKind) => ({ ...side(ok[k]), ms: span[k] && span[k].end - span[k].start })
  return {
    reads: out,
    unread,
    expected: { index: side(expectedRanges.index), data: side(expectedRanges.data) },
    actual: { index: actualOf('index'), data: actualOf('data') },
    dataCompared: opts.data,
  }
}

/** decode する予定の行数（geometry 列の読むページが覆う行）。Actual の「decode した行」と比べる */
export function expectedDecodedRows(plan: AccessPlan, geometryCol: number | undefined): number {
  if (geometryCol === undefined) return 0
  let n = 0
  for (const r of plan.rowGroups) for (const c of r.chunkRanges) if (c.col === geometryCol) for (const s of c.rows) n += s.end - s.start
  return n
}
