import type { Bbox } from '../geo/bbox'
import { lonLatToMercator, type MapProjection } from '../geo/crs'

/**
 * 地図の表示範囲（経緯度。世界を横に繰り返して表示すると経度が ±180 を超える）を、データの CRS の bbox にする。
 * 日付変更線をまたぐ範囲は 2 つに分ける（1 つの bbox で表すと、またいだ側の反対の地域まで含んでしまうため）。
 */
export function viewportBoxes(west: number, south: number, east: number, north: number, projection: MapProjection): Bbox[] {
  let boxes: Bbox[]
  if (east - west >= 360) {
    boxes = [[-180, south, 180, north]]
  } else {
    const w = ((((west + 180) % 360) + 360) % 360) - 180
    const e = w + (east - west)
    boxes = e > 180 ? [[w, south, 180, north], [-180, south, e - 360, north]] : [[w, south, e, north]]
  }
  if (projection === 'webmercator') {
    return boxes.map(([x0, y0, x1, y1]) => {
      const [mx0, my0] = lonLatToMercator(x0, y0)
      const [mx1, my1] = lonLatToMercator(x1, y1)
      return [mx0, my0, mx1, my1]
    })
  }
  return boxes
}
