import type { FeatureCollection, Geometry } from 'geojson'
import type { DecodedFeature } from '../../data/readData'
import type { Inspection } from '../../inspect'
import { levelColor, NEUTRAL } from '../../util/color'

export interface DataFeatureProps {
  rg: number
  row: number
  /** 行が属する Level の色（design.md D37）。COGP でなければ中立色 */
  color: string
  inView: boolean
}

/** decode した行を地図用の GeoJSON にする。色は Row Group の bbox と同じ Level の配色にそろえる */
export function dataFeatures(ins: Inspection, rows: DecodedFeature[]): FeatureCollection<Geometry, DataFeatureProps> {
  const n = ins.lod?.levels.length ?? 0
  return {
    type: 'FeatureCollection',
    features: rows.map((f) => ({
      type: 'Feature' as const,
      properties: { rg: f.rg, row: f.row, color: f.level === undefined ? NEUTRAL : levelColor(f.level, n), inView: f.inView },
      geometry: f.geometry,
    })),
  }
}
