import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages はプロジェクトサイトを /<repo>/ 配下で配信するため、本番ビルドだけ base を合わせる
  base: process.env.GITHUB_PAGES ? '/cogp-inspector/' : '/',
  plugins: [react()],
  optimizeDeps: {
    // MapLibre v6 は worker を別ファイル（maplibre-gl-worker.mjs）として同梱しており、
    // 依存の事前バンドルに通すと worker が出力されず「Worker failed to load」で地図が起動しない
    exclude: ['maplibre-gl'],
  },
})
