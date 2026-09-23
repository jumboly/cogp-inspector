import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspect } from '../src/inspect'
import { TracedSource } from '../src/io/traced'
import type { ReadRecord } from '../src/io/source'
import { nodeFileSource } from './nodeSource'

// 公式サンプル（2.2GB、Git 管理外）がある環境でだけ走らせる
const SAMPLE = new URL('../data/pois.cogp.parquet', import.meta.url).pathname

describe.skipIf(!existsSync(SAMPLE))('公式サンプル pois.cogp.parquet', () => {
  it('Footer だけを 2 回の read で読み、構造を復元できる', async () => {
    const reads: ReadRecord[] = []
    const src = new TracedSource(nodeFileSource(SAMPLE), (r) => reads.push(r))
    const r = await inspect(src)

    expect(reads.map((x) => x.purpose)).toEqual(['trailer: footer 長と magic', 'footer: FileMetaData'])
    expect(reads[1].length).toBe(493_165 + 8)
    expect(r.file.rowGroups).toHaveLength(468)
    expect(r.file.numRows).toBe(30_052_264)
    expect(r.file.leafColumns.map((c) => c.name)).toEqual([
      'id', 'tags.key_value.key', 'tags.key_value.value', 'geometry', 'bbox.xmin', 'bbox.ymin', 'bbox.xmax', 'bbox.ymax',
    ])
    // Row Group は重ならず、ファイル内で昇順に並ぶ
    for (let i = 1; i < r.file.rowGroups.length; i++) {
      expect(r.file.rowGroups[i].range.start).toBeGreaterThanOrEqual(r.file.rowGroups[i - 1].range.end)
    }
    expect(r.file.pageIndex!.end).toBe(r.file.footer.start)

    expect(r.geo?.primary?.covering?.xmin).toEqual(['bbox', 'xmin'])
    expect(r.geo?.primary?.crs.mapProjection).toBe('lonlat')

    expect(r.lod?.valid).toBe(true)
    expect(r.lod?.levels).toHaveLength(17)
    expect(r.lod?.levels.at(-1)?.rowGroupEnd).toBe(467)
    expect(r.lod?.levels.at(-1)?.prefixRows).toBe(30_052_264)

    expect(r.rowGroupBboxes.every((b) => b.source === 'covering-stats')).toBe(true)
    const [xmin, , xmax] = r.rowGroupBboxes[467].bbox!
    expect(xmin).toBeGreaterThan(100)
    expect(xmax).toBeLessThanOrEqual(180)
  })
})
