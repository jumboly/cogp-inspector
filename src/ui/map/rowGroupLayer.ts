import type { FeatureCollection, Polygon } from 'geojson'
import { levelOfRowGroup } from '../../cogp/lod'
import { toLonLatBbox, type Bbox } from '../../geo/bbox'
import type { Inspection } from '../../inspect'
import { levelColor, NEUTRAL } from '../../util/color'

export interface RowGroupFeatureProps {
  rg: number
  /** 属する Level。COGP でなければ -1 */
  level: number
  color: string
  /** 経緯度での面積（重なった bbox をクリックしたとき、より小さい＝具体的な方を選ぶため） */
  area: number
}

// Web メルカトルは緯度 ±85.05° までしか表せないので、それを超える bbox は描画用に丸める
const MAX_LAT = 85.0511

export function lonLatBboxes(ins: Inspection): (Bbox | undefined)[] {
  const proj = ins.geo?.primary?.crs.mapProjection ?? null
  return ins.rowGroupBboxes.map((b) => (b.bbox ? toLonLatBbox(b.bbox, proj) : undefined))
}

export function rowGroupFeatures(ins: Inspection): FeatureCollection<Polygon, RowGroupFeatureProps> {
  const n = ins.lod?.levels.length ?? 0
  const boxes = lonLatBboxes(ins)
  return {
    type: 'FeatureCollection',
    features: boxes.flatMap((b, rg) => {
      if (!b) return []
      const [x0, y0raw, x1, y1raw] = b
      const y0 = Math.max(y0raw, -MAX_LAT)
      const y1 = Math.min(y1raw, MAX_LAT)
      const level = levelOfRowGroup(ins.lod, rg) ?? -1
      return [
        {
          type: 'Feature' as const,
          id: rg,
          properties: { rg, level, color: level < 0 ? NEUTRAL : levelColor(level, n), area: Math.abs((x1 - x0) * (y1 - y0)) },
          geometry: { type: 'Polygon' as const, coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
        },
      ]
    }),
  }
}

/** 全 Row Group の bbox を合わせた範囲（地図を合わせるため） */
export function unionBbox(boxes: (Bbox | undefined)[]): Bbox | undefined {
  const bs = boxes.filter((b): b is Bbox => !!b)
  if (!bs.length) return undefined
  return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))]
}
