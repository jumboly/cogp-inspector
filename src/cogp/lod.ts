import type { FileModel } from '../parquet/model'
import type { GeoModel } from '../geo/geoMetadata'

export interface LevelModel {
  level: number
  resolution: number
  /** この Level で読む prefix の終端（含む）。Level N は RG 0..rowGroupEnd をすべて読む */
  rowGroupEnd: number
  /** この Level で新しく加わる Row Group の先頭（前の Level の終端 + 1） */
  newFrom: number
  /** prefix 全体（RG 0..rowGroupEnd）の行数とバイト数 */
  prefixRows: number
  prefixCompressedBytes: number
  /** この Level で新しく加わる行数とバイト数 */
  newRows: number
  newCompressedBytes: number
}

export interface Violation {
  /** COGP 仕様（SPEC.md @v1.0.0）の該当箇所の要約 */
  rule: string
  detail: string
}

export interface LodModel {
  levels: LevelModel[]
  /** 仕様の MUST 違反。1 件でもあれば prefix 選択に使ってはならない（SPEC.md:89） */
  violations: Violation[]
  valid: boolean
  raw: unknown
}

/**
 * geo.lod を解析し、COGP 仕様の境界条件を検証する。
 * lod が無ければ undefined（＝ COGP ではない通常の GeoParquet）。
 */
export function parseLod(geo: GeoModel | undefined, file: FileModel): LodModel | undefined {
  const raw = geo?.raw.lod
  if (raw === undefined) return undefined
  const n = file.rowGroups.length
  const violations: Violation[] = []
  const levelsRaw = (raw as { levels?: unknown })?.levels

  if (!Array.isArray(levelsRaw) || levelsRaw.length === 0) {
    violations.push({ rule: 'levels は空でない配列（必須）', detail: 'levels がありません' })
    return { levels: [], violations, valid: false, raw }
  }

  const levels: LevelModel[] = []
  let prevEnd = -1
  let prevRes = Infinity
  levelsRaw.forEach((l, i) => {
    const end = (l as { row_group_end?: unknown }).row_group_end
    const res = (l as { resolution?: unknown }).resolution
    if (typeof end !== 'number' || !Number.isInteger(end)) {
      violations.push({ rule: 'row_group_end は整数（必須）', detail: `Level ${i}: row_group_end = ${JSON.stringify(end)}` })
      return
    }
    if (typeof res !== 'number' || !Number.isFinite(res) || res <= 0) {
      violations.push({ rule: 'resolution は正の有限値（必須）', detail: `Level ${i}: resolution = ${JSON.stringify(res)}` })
    }
    if (end < 0 || end >= n) {
      violations.push({ rule: '0 <= row_group_end < Row Group 数', detail: `Level ${i}: row_group_end = ${end}（Row Group 数 ${n}）` })
    }
    if (end < prevEnd) {
      violations.push({ rule: 'row_group_end は非減少', detail: `Level ${i}: ${end} < 前の Level の ${prevEnd}` })
    }
    if (typeof res === 'number' && res >= prevRes) {
      violations.push({ rule: 'resolution は狭義単調減少', detail: `Level ${i}: ${res} >= 前の Level の ${prevRes}` })
    }
    const clampedEnd = Math.min(Math.max(end, -1), n - 1)
    const newFrom = prevEnd + 1
    const sum = (from: number, to: number, f: (i: number) => number) => {
      let s = 0
      for (let k = Math.max(from, 0); k <= to; k++) s += f(k)
      return s
    }
    levels.push({
      level: i,
      resolution: typeof res === 'number' ? res : NaN,
      rowGroupEnd: end,
      newFrom,
      prefixRows: sum(0, clampedEnd, (k) => file.rowGroups[k].numRows),
      prefixCompressedBytes: sum(0, clampedEnd, (k) => file.rowGroups[k].compressedSize),
      newRows: sum(newFrom, clampedEnd, (k) => file.rowGroups[k].numRows),
      newCompressedBytes: sum(newFrom, clampedEnd, (k) => file.rowGroups[k].compressedSize),
    })
    prevEnd = Math.max(prevEnd, end)
    if (typeof res === 'number') prevRes = res
  })

  const last = levels[levels.length - 1]
  if (last && last.rowGroupEnd !== n - 1) {
    violations.push({ rule: '最後の Level の row_group_end = Row Group 数 - 1（全行を含む）', detail: `最後の row_group_end = ${last.rowGroupEnd}、Row Group 数 ${n}` })
  }
  return { levels, violations, valid: violations.length === 0, raw }
}

/** Row Group が初めて含まれる Level（＝その Row Group が属する Level） */
export function levelOfRowGroup(lod: LodModel | undefined, rg: number): number | undefined {
  return lod?.levels.find((l) => l.newFrom <= rg && rg <= l.rowGroupEnd)?.level
}
