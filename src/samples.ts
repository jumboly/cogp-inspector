/**
 * 同梱の比較用サンプル（design.md D43・D45）。scripts/make_samples.py で公式サンプルから東京 23 区付近を切り出したもの。
 * 3 つは行・列・圧縮・Row Group とページの大きさがそろっていて、並び順（と COGP の Level）だけが違う。
 */
export interface Sample {
  id: 'id' | 'hilbert' | 'cogp'
  label: string
  file: string
  description: string
}

export const SAMPLES: Sample[] = [
  { id: 'id', label: '元の順', file: 'tokyo-id.parquet', description: '通常の GeoParquet。行は id 順（OSM の登録順）で、場所とはほぼ無関係に並ぶ' },
  { id: 'hilbert', label: 'Hilbert 順', file: 'tokyo-hilbert.parquet', description: '通常の GeoParquet。行を Hilbert 曲線の順に並べ、近い地物が同じ Row Group・ページに入る' },
  { id: 'cogp', label: 'COGP', file: 'tokyo.cogp.parquet', description: 'cogp v1.0.0 で変換した COGP。粗い Level から細かい Level の順に Row Group を並べる' },
]

export const SAMPLE_ATTRIBUTION = '© OpenStreetMap contributors（ODbL）。COGP 公式サンプル pois.cogp.parquet から切り出し'

/**
 * サンプルの置き場所。開発サーバーは samples/ を Range 付きで配信する（vite.config.ts）。
 * 公開版は GitHub Pages に置かず、VITE_SAMPLES_BASE（ビルド時に指定）の配信先から読む。
 * Pages は .parquet を gzip で送り、Range を圧縮後のバイト列に掛けるので、Parquet として読めなくなるため
 */
const SAMPLES_BASE = (import.meta.env.VITE_SAMPLES_BASE as string | undefined) || (import.meta.env.DEV ? '/samples/' : undefined)

/** 配信先を指定せずにビルドした公開版では、開けないボタンを出さない */
export const SAMPLES_AVAILABLE = SAMPLES_BASE !== undefined

export const sampleUrl = (s: Sample) => {
  const base = SAMPLES_BASE ?? '/samples/'
  return new URL(s.file, new URL(base.endsWith('/') ? base : `${base}/`, location.href)).href
}

/** 開いているファイルが同梱サンプルなら、そのサンプル（比較対象の候補を出すため） */
export function sampleOf(sourceName: string | undefined): Sample | undefined {
  if (!sourceName) return undefined
  // 配信先（開発サーバー・R2）によってディレクトリが違うので、ファイル名だけで見分ける
  return SAMPLES.find((s) => sourceName === s.file || sourceName.endsWith(`/${s.file}`))
}
