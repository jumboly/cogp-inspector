import { createReadStream, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 開発時だけ data/ と samples/ を HTTP Range 付きで配信する。
 * data/ の公式サンプルは 2.2GB あり public/ に置くとビルドでコピーされてしまうため別経路にする。
 * samples/ は GitHub Pages に載せない（Pages は .parquet を gzip で送り、Range を圧縮後のバイト列に掛けるため
 * ファイルとして読めなくなる）。公開版は別の配信先（Cloudflare R2）から読む。
 * また、URL で開いたときの Range Request の様子を手元で再現するため、Range なしの要求には全体を返さず 416 にする。
 */
function serveData(): Plugin {
  return {
    name: 'serve-data-with-range',
    configureServer(server) {
      for (const dir of ['data', 'samples']) server.middlewares.use(`/${dir}/`, (req, res) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        if (!/^[\w.-]+$/.test(name)) {
          res.statusCode = 400
          res.end()
          return
        }
        const file = resolve(import.meta.dirname, dir, name)
        let size: number
        try {
          size = statSync(file).size
        } catch {
          res.statusCode = 404
          res.end(`${dir}/${name} がありません（README の「サンプルデータ」を参照）`)
          return
        }
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Content-Type', 'application/vnd.apache.parquet')
        if (req.method === 'HEAD') {
          res.setHeader('Content-Length', String(size))
          res.end()
          return
        }
        const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
        const start = m ? Number(m[1]) : NaN
        const end = m ? Math.min(Number(m[2]), size - 1) : NaN
        if (!m || start > end || start >= size) {
          res.statusCode = 416
          res.setHeader('Content-Range', `bytes */${size}`)
          res.end()
          return
        }
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
        res.setHeader('Content-Length', String(end - start + 1))
        createReadStream(file, { start, end }).pipe(res)
      })
    },
  }
}

export default defineConfig({
  // GitHub Pages はプロジェクトサイトを /<repo>/ 配下で配信するため、本番ビルドだけ base を合わせる
  base: process.env.GITHUB_PAGES ? '/cogp-inspector/' : '/',
  plugins: [react(), serveData()],
  optimizeDeps: {
    // MapLibre v6 は worker を別ファイル（maplibre-gl-worker.mjs）として同梱しており、
    // 依存の事前バンドルに通すと worker が出力されず「Worker failed to load」で地図が起動しない
    exclude: ['maplibre-gl'],
  },
})
