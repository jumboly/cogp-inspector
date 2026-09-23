import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

// MapLibre v6 は worker の場所を実行時に new URL(変数, import.meta.url) で決めるため、
// Vite が本番ビルドで worker を出力できない。Vite に worker を別途バンドルさせ、その URL を明示的に渡す
maplibregl.setWorkerUrl(maplibreWorkerUrl)

// 背景は API キー不要の OSM ラスタタイル。主役は Row Group の bbox 等の重ね描きなので、背景は控えめで十分
const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.8 } }],
}

export function MapView() {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!container.current) return
    const map = new maplibregl.Map({
      container: container.current,
      style: BASE_STYLE,
      center: [0, 20],
      zoom: 1,
    })
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    // StrictMode の二重マウントや画面遷移で WebGL コンテキストが残らないよう、必ず破棄する
    return () => map.remove()
  }, [])

  return <div ref={container} className="map" />
}
