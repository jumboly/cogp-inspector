import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { viewportBoxes } from '../../plan/viewport'
import { useStore } from '../../state/store'
import { SELECT_COLOR } from '../../util/color'
import { LevelControl } from './LevelControl'
import { spanFeatures } from './pageLayer'
import { lonLatBboxes, rowGroupFeatures, unionBbox, type RowGroupFeatureProps } from './rowGroupLayer'

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

const SRC = 'row-groups'
const SPAN_SRC = 'page-spans'
// Page bbox は bbox covering 列の ColumnIndex から求めるので、covering 列と同じ色で描く
const SPAN_COLOR = '#0072b2'
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * 表示の縮尺を「1 CSS ピクセルあたりのデータの座標単位」で求める。
 * cogp-js デモと同じく、地図の縦中央で横 100 CSS px 離れた 2 点の座標差を使う（design.md D18）。
 */
function targetResolution(map: maplibregl.Map, proj: 'lonlat' | 'webmercator' | null): number {
  const y = map.getContainer().clientHeight / 2
  const a = map.unproject([0, y])
  const b = map.unproject([100, y])
  const dx = proj === 'webmercator' ? ((b.lng - a.lng) * Math.PI * 6378137) / 180 : b.lng - a.lng
  return Math.abs(dx) / 100
}

export function MapView() {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [loaded, setLoaded] = useState(false)
  const inspection = useStore((s) => s.inspection)
  const viewLevel = useStore((s) => s.viewLevel)
  const selection = useStore((s) => s.selection)
  const selectOrigin = useStore((s) => s.selectOrigin)
  const hover = useStore((s) => s.hoverRowGroup)
  const pageBboxes = useStore((s) => s.pageBboxes)
  const hoverSpan = useStore((s) => s.hoverSpan)
  const simEnabled = useStore((s) => s.simulator.enabled)
  const plan = useStore((s) => s.simulator.plan)
  const focus = useStore((s) => s.simulator.focus)

  useEffect(() => {
    if (!container.current) return
    const map = new maplibregl.Map({ container: container.current, style: BASE_STYLE, center: [0, 20], zoom: 1 })
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    map.on('load', () => {
      map.addSource(SRC, { type: 'geojson', data: EMPTY })
      // 粗い Level の Row Group は広い範囲を覆うので、細かい Level ほど上に描いて見分けられるようにする
      map.addLayer({ id: 'rg-fill', type: 'fill', source: SRC, layout: { 'fill-sort-key': ['get', 'level'] }, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.03 } })
      map.addLayer({ id: 'rg-line', type: 'line', source: SRC, layout: { 'line-sort-key': ['get', 'level'] }, paint: { 'line-color': ['get', 'color'], 'line-width': 1 } })
      map.addLayer({ id: 'rg-hover', type: 'line', source: SRC, filter: ['==', ['get', 'rg'], -1], paint: { 'line-color': SELECT_COLOR, 'line-width': 2, 'line-dasharray': [2, 1] } })
      map.addLayer({ id: 'rg-selected', type: 'line', source: SRC, filter: ['==', ['get', 'rg'], -1], paint: { 'line-color': SELECT_COLOR, 'line-width': 3 } })
      map.addSource(SPAN_SRC, { type: 'geojson', data: EMPTY })
      map.addLayer({ id: 'span-fill', type: 'fill', source: SPAN_SRC, paint: { 'fill-color': SPAN_COLOR, 'fill-opacity': ['case', ['get', 'kept'], 0.03, 0] } })
      map.addLayer({ id: 'span-line', type: 'line', source: SPAN_SRC, paint: { 'line-color': SPAN_COLOR, 'line-width': 1, 'line-opacity': ['case', ['get', 'kept'], 0.9, 0.25] } })
      map.addLayer({ id: 'span-hover', type: 'line', source: SPAN_SRC, filter: ['==', ['get', 'span'], -1], paint: { 'line-color': SELECT_COLOR, 'line-width': 2.5 } })
      setLoaded(true)
    })

    const pick = (e: maplibregl.MapMouseEvent) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['rg-fill'] })
      if (!hits.length) return undefined
      // 重なった bbox のうち最も小さいもの＝その場所を最も具体的に表す Row Group を選ぶ
      return hits.map((h) => h.properties as RowGroupFeatureProps).sort((a, b) => a.area - b.area)[0].rg
    }
    map.on('click', (e) => {
      const rg = pick(e)
      if (rg !== undefined) useStore.getState().select({ kind: 'rowGroup', rg }, 'map')
    })
    map.on('mousemove', (e) => {
      const rg = pick(e) ?? null
      map.getCanvas().style.cursor = rg === null ? '' : 'pointer'
      if (useStore.getState().hoverRowGroup !== rg) useStore.getState().setHoverRowGroup(rg)
    })
    mapRef.current = map
    // StrictMode の二重マウントや画面遷移で WebGL コンテキストが残らないよう、必ず破棄する
    return () => {
      map.remove()
      mapRef.current = null
      setLoaded(false)
    }
  }, [])

  // ファイルが変わったら Row Group の bbox を描き直し、全体が見える位置へ移動する
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    const src = map.getSource(SRC) as maplibregl.GeoJSONSource
    if (!inspection) {
      src.setData(EMPTY)
      return
    }
    src.setData(rowGroupFeatures(inspection))
    const u = unionBbox(lonLatBboxes(inspection))
    if (u) map.fitBounds([[u[0], Math.max(u[1], -80)], [u[2], Math.min(u[3], 80)]], { padding: 40, duration: 0 })
  }, [inspection, loaded])

  // 表示 Level: その Level で読む prefix（RG 0..row_group_end）だけを表示し、この Level で増えた Row Group を強調する。
  // Simulator の間（Level の段階を見ているとき以外）は、Row Group の bbox で残したものを濃く、読み飛ばしたものを薄く描く
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    const end = viewLevel === null ? undefined : inspection?.lod?.levels[viewLevel]?.rowGroupEnd
    const filter: maplibregl.FilterSpecification | null = end === undefined ? null : ['<=', ['get', 'rg'], end]
    map.setFilter('rg-fill', filter)
    map.setFilter('rg-line', filter)
    if (simEnabled && plan && focus !== 'prefix') {
      const kept: maplibregl.ExpressionSpecification = ['in', ['get', 'rg'], ['literal', plan.rowGroups.map((r) => r.rg)]]
      map.setPaintProperty('rg-line', 'line-width', ['case', kept, 2, 0.5])
      map.setPaintProperty('rg-line', 'line-opacity', ['case', kept, 1, 0.2])
      // 粗い Level の Row Group はほぼ全球を覆って重なるので、塗りはごく薄くする
      map.setPaintProperty('rg-fill', 'fill-opacity', ['case', kept, focus === 'rowGroupPruned' ? 0.06 : 0.02, 0])
      return
    }
    const isNew: maplibregl.ExpressionSpecification = ['==', ['get', 'level'], viewLevel ?? -2]
    map.setPaintProperty('rg-line', 'line-width', viewLevel === null ? 1 : ['case', isNew, 2, 0.7])
    map.setPaintProperty('rg-line', 'line-opacity', viewLevel === null ? 1 : ['case', isNew, 1, 0.35])
    map.setPaintProperty('rg-fill', 'fill-opacity', viewLevel === null ? 0.03 : ['case', isNew, 0.18, 0.03])
  }, [viewLevel, inspection, loaded, simEnabled, plan, focus])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    map.setFilter('rg-hover', ['==', ['get', 'rg'], hover ?? -1])
  }, [hover, loaded])

  // 選択中の Row Group を強調し、地図以外（ツリーや Byte Map）で選ばれたときはその範囲へ移動する
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    const rg = selection?.kind === 'rowGroup' || selection?.kind === 'column' ? selection.rg : -1
    map.setFilter('rg-selected', ['==', ['get', 'rg'], rg])
    if (rg >= 0 && selectOrigin !== 'map' && inspection) {
      const b = lonLatBboxes(inspection)[rg]
      if (b) map.fitBounds([[b[0], Math.max(b[1], -80)], [b[2], Math.min(b[3], 80)]], { padding: 60, maxZoom: 14, duration: 500 })
    }
  }, [selection, selectOrigin, inspection, loaded])

  // 選択中の Row Group のページ単位の bbox（Page Index から求めたもの）
  const selRg = selection?.kind === 'rowGroup' || selection?.kind === 'column' || selection?.kind === 'page' ? selection.rg : undefined
  const selSpans = selRg === undefined ? undefined : pageBboxes[selRg]
  // Simulator の間は、候補に残った Row Group のページを「読む / 読み飛ばす」で塗り分ける
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    const src = map.getSource(SPAN_SRC) as maplibregl.GeoJSONSource
    if (!inspection) {
      src.setData(EMPTY)
      return
    }
    if (simEnabled) {
      const show = plan && (focus === 'pages' || focus === 'requests')
      src.setData(
        show
          ? spanFeatures(
              inspection,
              plan.rowGroups.flatMap((r) => (r.pageBboxes?.available ? [{ rg: r.rg, spans: r.pageBboxes.spans, kept: (i: number) => r.spanKept?.[i] ?? true }] : [])),
            )
          : EMPTY,
      )
      return
    }
    const ready = selRg !== undefined && selSpans?.status === 'ready' && selSpans.data.available ? selSpans.data : undefined
    src.setData(ready ? spanFeatures(inspection, [{ rg: selRg!, spans: ready.spans }]) : EMPTY)
  }, [inspection, selRg, selSpans, loaded, simEnabled, plan, focus])

  // Simulator: 地図の移動が止まるたびに、表示範囲と縮尺から Access Plan を計算し直す（design.md D19）
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded || !simEnabled || !inspection) return
    const proj = inspection.geo?.primary?.crs.mapProjection ?? null
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => {
      const b = map.getBounds()
      useStore.getState().runSimulation({ viewport: viewportBoxes(b.getWest(), b.getSouth(), b.getEast(), b.getNorth(), proj), targetResolution: targetResolution(map, proj) })
    }
    // 続けて動かしている間は計算しない（止まってから 250ms 後に 1 回）
    const onMove = () => {
      clearTimeout(timer)
      timer = setTimeout(run, 250)
    }
    run()
    map.on('moveend', onMove)
    return () => {
      clearTimeout(timer)
      map.off('moveend', onMove)
    }
  }, [loaded, simEnabled, inspection])


  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    map.setFilter('span-hover', hoverSpan ? ['all', ['==', ['get', 'rg'], hoverSpan.rg], ['==', ['get', 'span'], hoverSpan.span]] : ['==', ['get', 'span'], -1])
  }, [hoverSpan, loaded])

  const unmappable = inspection && !inspection.geo?.primary?.crs.mapProjection
  const noBbox = inspection && inspection.rowGroupBboxes.every((b) => b.source === 'none')

  return (
    <>
      <div ref={container} className="map" />
      {inspection?.geo?.primary?.crs.mapProjection && <LevelControl />}
      {(unmappable || noBbox) && (
        <div className="map-notice">
          {!inspection.geo
            ? 'geo メタデータが無いため、地図に表示できません（GeoParquet ではありません）。'
            : unmappable
              ? `CRS「${inspection.geo.primary?.crs.label ?? '-'}」は地図表示に未対応です。構造の解析結果は左右のペインで確認できます。`
              : 'Row Group の bbox を求める統計値（bbox covering 列の統計・geospatial_statistics）がありません。Row Group 単位では空間の絞り込みができないファイルです。'}
        </div>
      )}
    </>
  )
}
