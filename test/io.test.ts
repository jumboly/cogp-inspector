import { describe, expect, it } from 'vitest'
import { coalesce } from '../src/io/coalesce'
import { groupBursts, readCategory } from '../src/io/readCategory'

describe('coalesce', () => {
  it('重なり・隣接だけ合体し、隙間は埋めない', () => {
    const runs = coalesce(
      [
        { start: 10, end: 20 },
        { start: 0, end: 10 },
        { start: 21, end: 30 },
        { start: 25, end: 28 },
      ],
      (r) => r,
    )
    expect(runs.map((r) => r.range)).toEqual([
      { start: 0, end: 20 },
      { start: 21, end: 30 },
    ])
  })
})

describe('Range Request の記録', () => {
  const rec = (id: number, startedAt: number, durationMs: number, purpose = 'footer: FileMetaData') => ({ id, offset: 0, length: 1, purpose, startedAt, durationMs })
  it('前のまとまりの終わりから 300ms 以上空いたら別のまとまり', () => {
    const b = groupBursts([rec(1, 0, 50), rec(2, 60, 500), rec(3, 700, 10), rec(4, 1200, 10)])
    expect(b.map((x) => x.reads.map((r) => r.id))).toEqual([[1, 2, 3], [4]])
  })
  it('purpose の先頭で分類する', () => {
    expect(readCategory('OffsetIndex RG2 id ほか 7 件（合体）')).toBe('offset-index')
    expect(readCategory('page-header RG2 id #0')).toBe('page-header')
    expect(readCategory('trailer: footer 長と magic')).toBe('footer')
  })
})
