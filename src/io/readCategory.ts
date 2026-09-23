import type { ReadRecord } from './source'

/** read の目的の分類。purpose の先頭の語で決まる（purpose は読み込み元が付ける：pages.ts・footer.ts） */
export type ReadCategory = 'footer' | 'offset-index' | 'column-index' | 'page-header' | 'data-page' | 'other'

export function readCategory(purpose: string): ReadCategory {
  if (purpose.startsWith('trailer') || purpose.startsWith('footer')) return 'footer'
  if (purpose.startsWith('OffsetIndex')) return 'offset-index'
  if (purpose.startsWith('ColumnIndex')) return 'column-index'
  if (purpose.startsWith('page-header')) return 'page-header'
  if (purpose.startsWith('data ')) return 'data-page'
  return 'other'
}

export const CATEGORY_LABEL: Record<ReadCategory, string> = {
  footer: 'Footer・trailer',
  'offset-index': 'OffsetIndex',
  'column-index': 'ColumnIndex',
  'page-header': 'ページヘッダ',
  'data-page': 'データページ',
  other: 'その他',
}

export interface Burst {
  reads: ReadRecord[]
  startedAt: number
  endedAt: number
}

/**
 * 続けて発生した read を 1 つの「まとまり」にする。前のまとまりが終わってから gapMs 以上空いたら次のまとまり。
 * ファイルを開く・Column Chunk を選ぶ・地図を動かすなど、1 回の操作で起きた read を一緒に見せるため。
 */
export function groupBursts(reads: ReadRecord[], gapMs = 300): Burst[] {
  const bursts: Burst[] = []
  for (const r of [...reads].sort((a, b) => a.startedAt - b.startedAt)) {
    const end = r.startedAt + r.durationMs
    const last = bursts.at(-1)
    if (last && r.startedAt - last.endedAt < gapMs) {
      last.reads.push(r)
      last.endedAt = Math.max(last.endedAt, end)
    } else {
      bursts.push({ reads: [r], startedAt: r.startedAt, endedAt: end })
    }
  }
  return bursts
}
