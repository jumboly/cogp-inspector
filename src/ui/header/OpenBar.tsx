import { useRef, useState } from 'react'
import { HttpRangeSource } from '../../io/http'
import { LocalBlobSource } from '../../io/local'
import { SAMPLE_ATTRIBUTION, SAMPLES, sampleUrl } from '../../samples'
import { useDiagnosis } from '../../state/diagnosis'
import { useStore } from '../../state/store'
import { formatBytes, formatNumber, formatPercent } from '../../util/format'

const OFFICIAL_SAMPLE = 'https://cogp-demo.spatialty.io/v1.0.0/pois.cogp.parquet'
// 開発サーバーは data/ を Range 付きで配信する（vite.config.ts）。URL で開く経路を手元で試すための入口
const DEV_SAMPLE = '/data/pois.cogp.parquet'

export function OpenBar() {
  const open = useStore((s) => s.open)
  const status = useStore((s) => s.status)
  const sourceName = useStore((s) => s.sourceName)
  const inspection = useStore((s) => s.inspection)
  const reads = useStore((s) => s.reads)
  const select = useStore((s) => s.select)
  const fileInput = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')

  const openUrl = (u: string) => open(() => HttpRangeSource.open(new URL(u, location.href).href))
  const readBytes = reads.reduce((a, r) => a + r.length, 0)
  const kind = !inspection ? undefined : inspection.lod ? (inspection.lod.valid ? 'COGP' : 'COGP（不正な lod）') : inspection.geo ? 'GeoParquet' : 'Parquet'

  return (
    <header className="app-header">
      <strong className="brand">COGP Inspector</strong>
      <button onClick={() => fileInput.current?.click()} disabled={status === 'loading'}>
        ローカルファイルを開く
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".parquet"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void open(async () => new LocalBlobSource(f, f.name))
          e.target.value = ''
        }}
      />
      <form
        className="url-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (url) void openUrl(url)
        }}
      >
        <input type="url" placeholder="https://…/file.parquet（Range 対応サーバー）" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button type="submit" disabled={!url || status === 'loading'}>
          URL を開く
        </button>
      </form>
      <span className="sample-buttons" title={`東京 23 区付近の POI（約 15 万行）。並び順だけが違う 3 つのファイルを同梱しています。${SAMPLE_ATTRIBUTION}`}>
        サンプル:
        {SAMPLES.map((s) => (
          <button key={s.id} onClick={() => void openUrl(sampleUrl(s))} disabled={status === 'loading'} title={s.description}>
            {s.label}
          </button>
        ))}
      </span>
      {import.meta.env.DEV && (
        <button onClick={() => void openUrl(DEV_SAMPLE)} disabled={status === 'loading'} title="開発サーバーが data/ から Range 付きで配信します">
          dev サンプル
        </button>
      )}
      <span className="header-status">
        {status === 'loading' && '読み込み中…'}
        {status === 'ready' && inspection && (
          <>
            <span className={`badge badge-${kind === 'COGP' ? 'cogp' : 'plain'}`}>{kind}</span>
            <span className="muted ellipsis" title={sourceName}>
              {sourceName}
            </span>
            <span className="muted">{formatBytes(inspection.file.size)}</span>
            <DiagnosisLink />
            <button className="link" onClick={() => select({ kind: 'reads' }, 'tree')} title="実際に読んだ範囲の一覧">
              読み込み {formatNumber(reads.length)} 回 / {formatBytes(readBytes)}（{formatPercent(readBytes, inspection.file.size)}）
            </button>
          </>
        )}
        {status === 'idle' && (
          <span className="muted">
            まずは「サンプル」の COGP を開き、Access Simulator で元の順・Hilbert 順と比べてみてください。公式サンプル（2.2GB）は{' '}
            <a href={OFFICIAL_SAMPLE} target="_blank" rel="noreferrer">
              ダウンロード
            </a>{' '}
            して「ローカルファイルを開く」で読めます（全体はメモリに載せません）
          </span>
        )}
      </span>
    </header>
  )
}

export function ErrorBanner() {
  const error = useStore((s) => s.error)
  if (!error) return null
  return (
    <div className="error-banner" role="alert">
      <strong>開けませんでした：</strong> {error.message}
      {error.hint && <div className="muted">{error.hint}</div>}
    </div>
  )
}

/** 診断の要約（design.md D41）。ファイルを開いた時点で Footer だけから決まるので、ヘッダに常に出しておく */
function DiagnosisLink() {
  const d = useDiagnosis()
  const select = useStore((s) => s.select)
  if (!d) return null
  const { mustNg, warn } = d.summary
  return (
    <button className="link" onClick={() => select({ kind: 'diagnosis' }, 'tree')} title="Cloud Optimized と言える構造かの診断">
      診断: {mustNg ? <span className="verdict-ng">MUST 違反 {mustNg}</span> : 'MUST OK'}
      {warn > 0 && <span className="verdict-warn">・注意 {warn}</span>}
    </button>
  )
}
