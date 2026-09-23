import { describe, expect, it } from 'vitest'
import { levelOfRowGroup, parseLod } from '../src/cogp/lod'
import type { GeoModel } from '../src/geo/geoMetadata'
import type { FileModel } from '../src/parquet/model'

function file(rowsPerRg: number[]): FileModel {
  return {
    rowGroups: rowsPerRg.map((numRows, index) => ({ index, numRows, compressedSize: numRows * 10, columns: [] })),
  } as unknown as FileModel
}
const geo = (lod: unknown) => ({ raw: { lod } }) as unknown as GeoModel

describe('parseLod', () => {
  it('prefix 構造と、各 Level で新しく加わる Row Group を求める', () => {
    const lod = parseLod(
      geo({ levels: [{ row_group_end: 0, resolution: 1000 }, { row_group_end: 2, resolution: 100 }, { row_group_end: 5, resolution: 10 }] }),
      file([1, 2, 3, 4, 5, 6]),
    )!
    expect(lod.valid).toBe(true)
    expect(lod.levels.map((l) => [l.newFrom, l.rowGroupEnd])).toEqual([[0, 0], [1, 2], [3, 5]])
    expect(lod.levels.map((l) => l.prefixRows)).toEqual([1, 6, 21])
    expect(lod.levels.map((l) => l.newRows)).toEqual([1, 5, 15])
    expect(levelOfRowGroup(lod, 4)).toBe(2)
  })

  it('lod が無ければ COGP ではない', () => {
    expect(parseLod(geo(undefined), file([1]))).toBeUndefined()
  })

  it.each([
    ['最後の Level が全 Row Group を含まない', [{ row_group_end: 0, resolution: 10 }], '最後の Level'],
    ['row_group_end が範囲外', [{ row_group_end: 5, resolution: 10 }], '0 <= row_group_end'],
    ['row_group_end が減る', [{ row_group_end: 1, resolution: 10 }, { row_group_end: 0, resolution: 1 }, { row_group_end: 1, resolution: 0.1 }], '非減少'],
    ['resolution が減らない', [{ row_group_end: 0, resolution: 10 }, { row_group_end: 1, resolution: 10 }], '狭義単調減少'],
    ['resolution が負', [{ row_group_end: 1, resolution: -1 }], '正の有限値'],
  ])('MUST 違反を検出する: %s', (_, levels, rule) => {
    const lod = parseLod(geo({ levels }), file([1, 1]))!
    expect(lod.valid).toBe(false)
    expect(lod.violations.some((v) => v.rule.includes(rule))).toBe(true)
  })
})
