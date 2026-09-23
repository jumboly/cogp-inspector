import { describe, expect, it } from 'vitest'
import { chooseLevel } from '../src/plan/accessPlan'
import { viewportBoxes } from '../src/plan/viewport'
import type { LodModel } from '../src/cogp/lod'
import { coalesce } from '../src/io/coalesce'

const lod = (res: number[]): LodModel => ({
  levels: res.map((r, i) => ({ level: i, resolution: r, rowGroupEnd: i, newFrom: i, prefixRows: 0, prefixCompressedBytes: 0, newRows: 0, newCompressedBytes: 0 })),
  violations: [],
  valid: true,
  raw: {},
})

describe('chooseLevel（cogp-js src/level.ts と同じ規則）', () => {
  const l = lod([1, 0.1, 0.01])
  it('resolution >= 目標 を満たす最も細かい Level', () => {
    expect(chooseLevel(l, 0.05).level?.level).toBe(1)
    expect(chooseLevel(l, 0.01).level?.level).toBe(2)
    expect(chooseLevel(l, 0.0001).level?.level).toBe(2)
  })
  it('最も粗い Level より粗い表示なら最も粗い Level', () => {
    expect(chooseLevel(l, 5).level?.level).toBe(0)
  })
  it('仕様違反の lod は使わない', () => {
    expect(chooseLevel({ ...l, valid: false }, 0.05).used).toBe(false)
  })
})

describe('viewportBoxes', () => {
  it('世界を繰り返した経度を -180〜180 に戻し、日付変更線をまたげば 2 つに分ける', () => {
    expect(viewportBoxes(170, 0, 190, 10, 'lonlat')).toEqual([
      [170, 0, 180, 10],
      [-180, 0, -170, 10],
    ])
    expect(viewportBoxes(370, 0, 380, 10, 'lonlat')).toEqual([[10, 0, 20, 10]])
    expect(viewportBoxes(-500, -80, 500, 80, 'lonlat')).toEqual([[-180, -80, 180, 80]])
  })
})

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

import { groupBursts, readCategory } from '../src/io/readCategory'

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
