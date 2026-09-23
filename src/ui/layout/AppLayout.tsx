import { ByteMap } from '../bytemap/ByteMap'
import { ErrorBanner, OpenBar } from '../header/OpenBar'
import { Inspector } from '../inspector/Inspector'
import { MapView } from '../map/MapView'
import { StructureTree } from '../tree/StructureTree'

// Tree / Map / Inspector / ByteMap を 1 画面に同時に置く。
// 地図操作とファイル構造の対応を「見比べながら」理解してもらうのがツールの目的なので、タブ切り替えにはしない。
export function AppLayout() {
  return (
    <div className="app">
      <OpenBar />
      <aside className="pane pane-structure">
        <h2>Structure</h2>
        <StructureTree />
      </aside>
      <main className="pane-map">
        <ErrorBanner />
        <MapView />
      </main>
      <aside className="pane pane-inspector">
        <h2>Inspector</h2>
        <Inspector />
      </aside>
      <footer className="pane pane-bytemap">
        <h2>Physical File Map</h2>
        <ByteMap />
      </footer>
    </div>
  )
}
