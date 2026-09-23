import type { FeatureCollection, Polygon } from 'geojson'
import { toLonLatBbox } from '../../geo/bbox'
import type { SpanBbox } from '../../geo/pageBbox'
import type { Inspection } from '../../inspect'

export interface SpanFeatureProps {
  rg: number
  span: number
  /** Access Simulator で読む対象に残ったか（Row Group の詳細表示では常に true） */
  kept: boolean
}

// Web メルカトルで描けない高緯度は丸める（rowGroupLayer と同じ理由）
const MAX_LAT = 85.0511

/** ページ単位の行範囲の bbox を地図用の矩形にする。bbox が求められない行範囲は描かない */
export function spanFeatures(ins: Inspection, items: { rg: number; spans: SpanBbox[]; kept?: (i: number) => boolean }[]): FeatureCollection<Polygon, SpanFeatureProps> {
  const proj = ins.geo?.primary?.crs.mapProjection ?? null
  return {
    type: 'FeatureCollection',
    features: items.flatMap(({ rg, spans, kept }) =>
      spans.flatMap((s, i) => {
        const b = s.bbox && toLonLatBbox(s.bbox, proj)
        if (!b) return []
        const y0 = Math.max(b[1], -MAX_LAT)
        const y1 = Math.min(b[3], MAX_LAT)
        return [
          {
            type: 'Feature' as const,
            properties: { rg, span: i, kept: kept ? kept(i) : true },
            geometry: { type: 'Polygon' as const, coordinates: [[[b[0], y0], [b[2], y0], [b[2], y1], [b[0], y1], [b[0], y0]]] },
          },
        ]
      }),
    ),
  }
}
