import { describe, expect, it } from 'vitest'
import { pageBboxes } from '../src/geo/pageBbox'
import type { ColumnIndexModel, OffsetIndexModel } from '../src/parquet/pageIndex'

const oi = (firstRows: number[], numRows: number): OffsetIndexModel => ({
  pages: firstRows.map((r, i) => ({ offset: i * 100, compressedSize: 100, firstRow: r, rowCount: (firstRows[i + 1] ?? numRows) - r })),
})
const ci = (min: number[], max: number[], nullPages = min.map(() => false)): ColumnIndexModel => ({ nullPages, min, max, boundaryOrder: 'UNORDERED' })

describe('pageBboxes', () => {
  it('4 列のページ境界がそろっていれば 1 ページ = 1 bbox', () => {
    const o = oi([0, 10], 20)
    const r = pageBboxes(20, [o, o, o, o], [ci([0, 5], [1, 6]), ci([10, 15], [11, 16]), ci([0, 5], [2, 7]), ci([10, 15], [12, 17])])
    expect(r).toEqual({
      available: true,
      aligned: true,
      spans: [
        { rows: { start: 0, end: 10 }, pages: [0, 0, 0, 0], bbox: [0, 10, 2, 12] },
        { rows: { start: 10, end: 20 }, pages: [1, 1, 1, 1], bbox: [5, 15, 7, 17] },
      ],
    })
  })

  it('境界がずれていれば、すべての境界で区切った行範囲ごとに、重なるページの値を使う', () => {
    // xmin 列だけ 0/10、他の 3 列は 0/5 で切れている
    const a = oi([0, 10], 20)
    const b = oi([0, 5], 20)
    const r = pageBboxes(20, [a, b, b, b], [ci([0, 5], [1, 6]), ci([10, 15], [11, 16]), ci([0, 5], [2, 7]), ci([10, 15], [12, 17])])
    if (!r.available) throw new Error()
    expect(r.aligned).toBe(false)
    expect(r.spans.map((s) => [s.rows, s.pages, s.bbox])).toEqual([
      [{ start: 0, end: 5 }, [0, 0, 0, 0], [0, 10, 2, 12]],
      [{ start: 5, end: 10 }, [0, 1, 1, 1], [0, 15, 7, 17]],
      [{ start: 10, end: 20 }, [1, 1, 1, 1], [5, 15, 7, 17]],
    ])
  })

  it('すべて null のページや ColumnIndex が無い列があれば bbox は求めない（読み飛ばさない）', () => {
    const o = oi([0], 10)
    const r = pageBboxes(10, [o, o, o, o], [ci([0], [1], [true]), ci([0], [1]), ci([0], [1]), ci([0], [1])])
    expect(r.available && r.spans[0].bbox).toBeUndefined()
    expect(pageBboxes(10, [o, o, o, o], [ci([0], [1]), undefined, ci([0], [1]), ci([0], [1])]).available).toBe(false)
  })
})
