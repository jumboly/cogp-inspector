import { MapView } from '../map/MapView'

// Tree / Map / Inspector / ByteMap を 1 画面に同時に置く。
// 地図操作とファイル構造の対応を「見比べながら」理解してもらうのがツールの目的なので、タブ切り替えにはしない。
export function AppLayout() {
  return (
    <div className="app">
      <header className="app-header">
        <strong>COGP Inspector</strong>
        <span className="muted">ファイル未選択</span>
      </header>
      <aside className="pane pane-structure">
        <h2>Structure</h2>
        <p className="muted">ファイルを開くと Footer・Level・Row Group の構造を表示します。</p>
      </aside>
      <main className="pane-map">
        <MapView />
      </main>
      <aside className="pane pane-inspector">
        <h2>Inspector</h2>
        <p className="muted">選択した要素の詳細を表示します。</p>
      </aside>
      <footer className="pane pane-bytemap">
        <h2>Physical File Map</h2>
        <p className="muted">ファイル全体のバイト配置と、読み込んだ範囲を表示します。</p>
      </footer>
    </div>
  )
}
