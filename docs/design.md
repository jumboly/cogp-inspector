# 設計メモ

調査結果と決定事項（2026-09-23 時点）。進み具合は §6、未対応の課題は [docs/issues/](issues/)。
推測を含む箇所は【推測】と明記する。決定の番号（D1〜）はコードのコメントから参照しているので、欠番（作業の順番の決定）も含めて番号は変えない。

## 1. 目的と設計の優先順位

このツールの目的は GeoParquet を表示することではなく、次を見て理解できるようにすること。

- なぜ Level があるのか / なぜ Row Group をこの順番に並べるのか / なぜ空間的にまとめるのか
- bbox メタデータがどう使われるのか / Page Index が何を改善するのか
- 列指向（Columnar storage）がなぜ有利なのか
- HTTP Range Request で何が起きるのか / なぜ Footer を先に読むのか

実装量より「何を読んでいるかが明確であること」を優先する。
内部処理は `read footer → choose level → select row groups → prune row groups →
inspect page index → select pages → read byte ranges → decode` の段階が追跡できる形にする。

## 2. 調査結果

### 2.1 COGP v1.0.0

出典: <https://github.com/Kanahiro/cloud-optimized-geoparquet>（SPEC.md @v1.0.0）

- 仕様書の見出しは「[Proposal] Level of Detail (LoD) extension」。v1.0.0 はリポジトリのタグとサンプルの版で、
  仕様内にバージョン欄は無い（SPEC.md:91 で独立した版番号を導入しないと明記）。
- メタデータ: `geo` の中の `lod.levels = [{row_group_end, resolution}, ...]`（粗い → 細かい）。
  - `row_group_end`: 0 始まり・その値を含む prefix 終端の Row Group 番号
  - `resolution`: 正の有限値。単位は主ジオメトリ列 CRS の水平座標単位（度なら度、m なら m）
- MUST（必須）
  - GeoParquet に準拠する
  - 各行はちょうど 1 回だけ格納し、ジオメトリ・属性を変更・簡略化・集約しない
  - 1 つの Row Group が Level 境界をまたがない。Row Group は粗い順から細かい順に並ぶ
  - `0 <= row_group_end < N`、非減少、最終要素 = N-1
  - resolution は狭義単調減少
  - リーダーは使う前に検証し、不正なら prefix 選択に使わない（報告は SHOULD、通常 GeoParquet として読むのは MAY）
  - prefix を完全なクエリ結果として扱わない（集計・空間結合に使えない）
- SHOULD（推奨）
  - 各 Level で新しく入る行を空間的にクラスタリングする（Hilbert、quadtree、STR packing の例示）
  - 粗い Level の地物はデータ範囲全体に散らす
  - 先頭の Row Group は小さくし、空間統計を付ける
- bbox covering や Page Index は必須ではない。「空間での読み飛ばしを支えうる」「さらに絞れる」という位置付け。
  リーダーは保守的に絞り込み、統計が無い Row Group は捨てない。
- Level 選択の例示: resolution >= target を満たす最も細かい Level（範囲外は端に寄せる）。
  zoom → resolution の換算は仕様の範囲外。

### 2.2 参照実装 cogp-rs と cogp-js

- cogp-rs（Rust、生成側）: README に「以下は実装上の選択で仕様要件ではない」と明記。
  - 既定 resolution は Web Mercator z0〜16 の 17 段（`40075016.68557849 / (1024·2^z)` m、地理座標系は 1 度 = 111,320 m で換算）
  - 点はグリッド間引き、線・面は bbox 対角長で Level を決める
  - Level ごとに再帰 STR packing、スネーク順。Row Group 既定 65,536 行、Row Group 内もページ単位（2,048 行）で空間パッキング
  - bbox 列に ColumnIndex、全列に OffsetIndex。ZSTD レベル 3。geometry / bbox は辞書エンコーディング無効
  - 単体のリポジトリ（Kanahiro/cogp-rs）は仕様リポジトリに統合されてアーカイブ済みで、古い `cogp` メタデータ（`gsd`）を書く。サンプルの生成には仕様リポジトリのリリースの CLI（cogp v1.0.0）を使う。
- cogp-js（ブラウザ、npm 未公開）: 依存は hyparquet と hyparquet-compressors のみ（hyparquet の内部モジュールも直接 import）。
  - Level 選択 → covering 列の Row Group 統計で bbox pruning → Page Index でページ pruning → 行単位判定
  - `asyncBufferFromUrl`（HEAD でサイズ取得）、Range の合体と 64MiB キャッシュ
  - 中間結果（候補 RG 数など）は外に出さない作り → 本ツールでは依存せず、ロジックを参照して自前で書く

### 2.3 Parquet の物理構造

出典: <https://github.com/apache/parquet-format>（parquet.thrift、README.md、PageIndex.md、Geospatial.md）

- 並び: `PAR1` → Column Chunk 群 → （Page Index 領域）→ FileMetaData → footer 長（4B LE）→ `PAR1`。
  メタデータは Thrift Compact Protocol。暗号化フッタは末尾 magic が `PARE`。
- 非推奨フィールド: `ColumnChunk.file_offset`（実装ごとに指す先が一貫しない）、`Statistics.min/max`（`min_value/max_value` を使う）。
  UI では「非推奨」と明示する。
- `total_compressed_size` / `total_uncompressed_size` はページヘッダ込み。PageHeader の `compressed_page_size` はヘッダを含まない。
- ページ列挙: OffsetIndex があれば位置が直接分かる（ヘッダ込みサイズ）。OffsetIndex に辞書ページは載らない。
  無ければ `dictionary_page_offset`（無ければ `data_page_offset`）から PageHeader を順にデコードしてたどる。
  【推測】古い writer は `dictionary_page_offset` を省くことがあるので、先頭ヘッダの type で確かめる。
- ColumnIndex: `null_pages`, `min_values`, `max_values`（物理型に応じた PLAIN のバイナリ）, `boundary_order`, `null_counts` ほか。
  ColumnIndex があれば OffsetIndex も必ずある（逆は不成立）。
- OffsetIndex: `page_locations = [{offset, compressed_page_size, first_row_index}]`。

### 2.4 GeoParquet

出典: <https://github.com/opengeospatial/geoparquet>（v1.1.0 / main = 2.0.0）

- v1.1: key-value メタデータ `geo`（JSON）。`version`, `primary_column`, `columns.{encoding, geometry_types, crs, edges, orientation, bbox, epoch, covering.bbox}`。
  `crs` 省略時は OGC:CRS84、`null` は「不明」で意味が違う。
- v2.0 は §3.5 の調査を参照。

### 2.5 公式サンプル（実測）

`https://cogp-demo.spatialty.io/v1.0.0/pois.cogp.parquet`（2,244,348,968 B、parquet-rs 56.2.1 で生成）

| 項目 | 値 |
|---|---|
| Footer | 493,165 B |
| Row Group | 468 個、30,052,264 行（1 個あたり 660〜65,536 行） |
| 列 | `id`, `tags.key_value.key`, `tags.key_value.value`, `geometry`, `bbox.{xmin,ymin,xmax,ymax}` |
| 圧縮 / エンコーディング | 全列 ZSTD。id・tags は RLE_DICTIONARY、geometry・bbox は PLAIN |
| Level | 17 段、resolution 0.3516°〜5.36e-6° |
| 統計値 | bbox 4 列は全 Row Group に min/max あり。`geospatial_statistics` は無し |
| Page Index | OffsetIndex は全 3,744 chunk、ColumnIndex は bbox 4 列（1,872 chunk）のみ。Footer 直前に約 3.0MB |
| ページ | RG2 `bbox.xmin` は DATA_PAGE(v1) 23 枚、各ヘッダ 22B、2,048 値。ページ単位の Statistics は無い |
| 辞書ページ | id 列の辞書ページヘッダは RG0 で 19B（8,103 件）、RG2 で 20B（46,751 件）。ヘッダ長は varint の桁数で変わる |

配信サーバーの挙動:

- Range Request（`bytes=N-M`）に 206 で応答、`accept-ranges: bytes`
- CORS はオリジン許可制。`localhost:5173` と `kanahiro.github.io` には許可が返り、公開先（`https://www.jumboly.jp`）を含む他のオリジンには返らない（確認済み）
- OPTIONS プリフライトは 403。`bytes=N-M` 形式の Range は CORS-safelisted なのでプリフライトが飛ばず読める【推測】
- したがって末尾指定の `bytes=-N` は使わない（safelisted ではなくプリフライトが発生する）。サイズは HEAD で取る

### 2.6 ブラウザ向け Parquet ライブラリ比較

| 観点 | hyparquet 1.31 | parquet-wasm 0.8 | duckdb-wasm 1.33 | Rust parquet + WASM |
|---|---|---|---|---|
| Footer・統計値 | ◎ | ×（統計値なし） | ◎（SQL） | ◎ |
| ColumnIndex / OffsetIndex | ◎ 公開 API | × | × | ◎ |
| PageHeader | ○ 内部の thrift デコーダを利用 | × | × | △ 非公開 |
| 読んだ range の追跡 | ◎ `slice` をラップ | × | △ | ◎ |
| サイズ（gzip） | 4〜20KB（+ compressors 76KB） | 1.6MB | 5MB 以上 | 数 MB【推測】 |

## 3. 決定事項

### 3.1 土台

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D1 | サンプルデータ | 開発は公式サンプルを `data/` にハードリンクして使う。公開版では公式サンプルをダウンロードしてローカルで開く案内を出し、すぐ試せる入口は同梱サンプル（D43）にする | 公式サンプルは公開先のオリジンから CORS で読めない（§2.5）。ローカルファイルなら CORS の制約を受けない |
| D2 | リポジトリ名 | `cogp-inspector` | 用途が名前で伝わり、デバッガにも教材にも合う |
| D3 | パーサ | hyparquet を主に使い、PageHeader の解析だけ自作 | 必要な物理構造がすべて取れ、読んだ range も追跡できることを実データで確認済み。Rust/WASM でも PageHeader は非公開 API のため得るものがない |
| D4 | Row Group bbox | 統計値のみ: covering 列の Row Group 統計 → `geospatial_statistics` の順。無ければ「bbox 不明」 | 初期処理を Footer 読み込みだけに保つ。統計が無いと読み飛ばせない事実もそのまま見せられる |

ライブラリの癖と環境:

- hyparquet 1.31 の公開 API: `parquetMetadataAsync`（既定で末尾 512KiB を 1 回 read、足りなければ追加 1 回）、
  `readColumnIndex` / `readOffsetIndex`、`asyncBufferFromUrl`（HEAD でサイズ取得）。AsyncBuffer は `{ byteLength, slice(start, end) }`。
- PageHeader を解析する `parquetHeader`（src/column.js）は非公開。`hyparquet/src/thrift.js` の `deserializeTCompactProtocol` は
  package.json の `exports`（`./src/*.js`）経由で import でき、結果は `field_N` 形式の生オブジェクトになる。
  内部モジュールに依存するので、hyparquet は `1.31.1` に固定する。
- 背景地図は API キー不要の OSM ラスタタイル（彩度を落として表示）。
- MapLibre v6 + Vite: `optimizeDeps.exclude: ['maplibre-gl']` と、`?worker&url` で worker をバンドルして `setWorkerUrl` に渡す対処が必要（src/ui/map/MapView.tsx）。
- 公開先は GitHub Pages の独自ドメイン <https://www.jumboly.jp/cogp-inspector/>。

### 3.2 MVP

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D5 | Footer の読み方 | hyparquet の `parquetMetadataAsync`（末尾 512KiB を一括）を使わず、末尾 8 バイト → Footer ちょうどの 2 回に分けて読み、`parquetMetadata` に渡す | Parquet の読み方そのものを Range 記録で見せるため。往復 1 回の増加は許容 |
| D6 | メタデータの型 | `parquetMetadata(..., { geoparquet: false })` | hyparquet が geo から logical_type を補完するのを止め、ファイルに実際に書かれた Parquet の型を見せる |
| D7 | 状態管理 | zustand。選択（Selection）を 1 つ持ち全ペインが購読する。選択の発生元（map / tree / bytemap / inspector）も持ち、地図以外で選んだときだけ地図を移動する | ペイン間の同期を 1 か所にまとめる |
| D8 | Structure ツリーの並び | ファイルの物理順（先頭 magic → Row Group → Page Index → Footer → trailer）。Schema・geo・lod は Footer の子 | 「メタデータはすべて末尾の Footer にある」ことを階層で見せる |
| D9 | 地図の重なり | 細かい Level ほど上に描く。クリック時は重なった bbox のうち面積最小の Row Group を選ぶ | 粗い Level の Row Group はほぼ全球を覆うため |
| D10 | 表示 Level | 選んだ Level の prefix だけを表示し、その Level で増えた Row Group を太線、引き継いだ Row Group を細線にする。lod が仕様違反なら警告を出す | prefix 構造（前の Level を含んだまま増える）を地図上で見せる |
| D11 | Physical File Map | canvas。構造・Column Chunk（列の役割で色分け）・読み込みの段。最小描画幅 2px、Level 選択時は prefix の連続範囲を枠で示す | 2.2GB 中の Footer（0.02%）も見えるようにする |
| D12 | バイナリ列の統計 | BYTE_ARRAY で文字列系の論理型でない列（WKB など）は min/max を `<バイナリ N bytes>` と表示 | hyparquet は文字列化して返すため文字化けする |
| D13 | 開発サーバー | `data/` と `samples/` を Range 付きで配信する Vite プラグイン。Range なしは 416 | URL で開く経路を手元で再現する。public/ に置くとビルドにコピーされるため |

### 3.3 Phase 2（Page・Page Index・Access Simulator・Range Request 可視化）

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D15 | Page Index を読む時機 | 必要になったときに、その分だけ読む（Row Group・Column Chunk の選択時、Simulator の候補 Row Group）。読んだものはキャッシュ | 開くときは Footer だけに保てる。「候補に残った分だけ Index を読む」本物のリーダーの読み方が Range 記録に現れる |
| D16 | PageHeader を読む範囲 | Column Chunk を選んだときに、その Chunk のヘッダだけ読む。OffsetIndex があれば位置は OffsetIndex から、無ければ先頭から順にたどる | 1 回の操作の read 数を数十回に抑えつつ、Chunk 内のページを並べて比べられる |
| D17 | Page bbox の組み立て | covering 4 列のページ境界（first_row_index）を合わせた「行範囲」を単位にし、各範囲に重なる各列のページの min/max で bbox を作る。境界がそろっているかを表示 | 列ごとにページの切れ目は独立。どのファイルでも保守的に正しく pruning でき、cogp-js の行範囲の考え方とも合う |
| D18 | 表示縮尺 → 目標 resolution | cogp-js デモと同じ。地図の縦中央で横 100 CSS px の経度差 / 100（3857 のファイルは同じ方法で m / px） | 参照実装と同じ Level が選ばれる。resolution の単位（CRS の座標単位）とそのまま合う |
| D19 | Simulator の起動 | 「Simulator モード」の ON/OFF。ON の間は地図の移動が止まるたびに自動実行し、Level セレクタは自動選択の結果を表示（手動変更不可） | 手動 Level と自動 Level の混同を防ぎ、「動かすと読む範囲が変わる」を体験できる |
| D20 | 結果の見せ方 | Inspector の「Access Plan」に段階ごとの funnel（候補数とバイト数）。段階をクリックすると地図と Physical File Map が連動 | 既存の Selection の同期（D7）に乗せられ、新しいペインが要らない |
| D21 | 読む列 | 列を選べる（既定は geometry + bbox covering 列）。全列を読んだ場合との差も表示 | 列指向の利点がバイト数の差として直接見える |
| D22 | Range の合体 | cogp-js と同じく、重なり・隣接だけ合体し隙間は埋めない。合体前後の数を表示。Index の実際の読み込みも同じ方針で合体する | 参照実装と同じ数値になり、空間順の並びがリクエスト数を減らす効果が見える |
| D23 | 推定と実測を分ける | Access Plan はデータページを読まずに範囲を推定する（Expected）。実際に読むのは D32 の「実データを読む」を ON にしたときだけ | 推定と実測を分けておくと、両者を突き合わせられる（D39） |
| D24 | 全列との比較の求め方 | 候補 Row Group の全列の OffsetIndex を読み、全列でもページ単位で求める | Row Group 単位の概算だと、選んだ列とページ単位で比べられない。parquet-rs では 1 Row Group 分の OffsetIndex が隣接し、1 回の read で済む |
| D25 | Page Index を読む上限 | 候補 Row Group が 100 個を超えたら Page Index を読まず、ページ単位の絞り込みを省く（その旨を funnel に表示） | lod の無いファイルを全体表示すると数百回の Range Request になるため。COGP なら Level 選択で候補が抑えられる |
| D26 | 表示範囲の扱い | 世界を横に繰り返した経度を -180〜180 に戻し、日付変更線をまたぐときは bbox を 2 つに分ける。3857 のファイルは表示範囲をメートルに変換して比べる | 1 つの bbox で表すと、またいだ側の反対の地域まで含んでしまう |
| D27 | Simulator の地図表示 | Row Group は「残った = 太線、読み飛ばし = 細線」、ページは「読む = 青の枠、読み飛ばし = 薄い枠」。地図の移動が止まって 250ms 後に計算する | 粗い Level の Row Group・ページはほぼ全球を覆って重なるので、塗りはごく薄くし線で見分ける |
| D28 | Physical File Map の「読む予定」 | 新しい段「読む予定」を追加。funnel で選んだ段に応じ、Level・Row Group の段では Column Chunk 単位、ページ以降はページ（合体後の Range）単位で描く | 同じファイル上で、段を進めるごとに読む範囲が細かくなる様子を見せる |
| D29 | Range Request の見せ方 | Inspector の一覧で、目的別（Footer・OffsetIndex・ColumnIndex・ページヘッダ・データページ・ページの中身）に集計し、300ms 以上空いたら別の「操作のまとまり」として時系列の横棒（ウォーターフォール）で並べる。行を選ぶと Physical File Map にその範囲の枠を出す | 1 回の操作でどんな read が何回・並列に起きたかが見える。新しいペインは作らず D7 の Selection に乗せる |

実装メモ:

- ページヘッダは最初 64 バイト読み、途中で切れていたら 4KiB → 64KiB → 1MiB と広げて読み直す（ページ単位の Statistics があるとヘッダが長くなるため）。
- parquet-rs は同じ Row Group の OffsetIndex を列順に隙間なく書くため、1 Row Group 8 列分の OffsetIndex は合体して 1 回の read になる。
  covering 4 列の ColumnIndex・OffsetIndex もそれぞれ隣接するので、Page bbox は計 2 回の read で求まる。
- ページ一覧と Page bbox が同じ Index を同時に要求することがあるため、PageCache は読み込み中の Index も共有して二重に読まない。
- 公式サンプルの RG300 は 32 の行範囲（2,048 行ずつ）で、covering 4 列のページ境界はそろっている。
- 値がすべて null のページや、min/max が数値でないページは bbox 不明として扱い、読み飛ばさない。
- 地図を続けて動かしたときは通し番号で古い計算結果を捨てる。列を変えたら最後の表示範囲で計算し直す。
- 公式サンプルで東京周辺（139.6〜139.9°E, 35.6〜35.8°N、目標 0.0003°/px）を計算すると、
  Level 10 → prefix 188 RG → bbox で 11 RG → 292 範囲中 32 範囲 → 選んだ 5 列で約 2.7MB（Row Group 単位なら 25MB）、
  160 ページ範囲が合体して 95 回の Range Request。Page Index の読み込みは 16 回（132 件を合体）。

### 3.4 Phase 3（実データ描画・Expected vs Actual・診断・比較）

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D31 | decode の方法 | Access Plan で決めたページを自前の read で読み、展開・decode だけ hyparquet の関数（`decompressPage`・`readColumn`・`wkbToGeojson` など）を使う。`parquetRead` の filter / `usePageIndex` は使わない | 処理の流れが Access Plan の続きになり、Page Index のキャッシュも共有できる。hyparquet は Level を知らず Index を読み直し合体方針も違うため、差の原因が混ざる |
| D32 | 読み始める時機 | Simulator に「実データを読む」の ON/OFF（既定 OFF）。ON の間は移動が止まるたびに計画 → 読み込み → decode → 描画まで自動で進む | D19 の「動かすと読む範囲が変わる」を実データでも体験させつつ、Simulator を ON にしただけで大量の通信が起きないようにする |
| D33 | 読む量の上限 | 推定バイト数（選んだ列）が 20MB を超えたら読まず、funnel にその旨を出す。読み込み中に地図を動かしたら古い読み込みを `AbortSignal` で中断する | 読む前に Expected で量が分かるのでそこで止められる。20MB は東京の例（約 2.7MB）の 7 倍の余裕 |
| D34 | 展開ライブラリ | `hyparquet-compressors`（fzstd + hysnappy）を追加し、初めて必要になったときに dynamic import する | cogp-js と同じ構成。ZSTD 以外の codec のファイルも開ける。初期表示のバンドル（約 76KB gzip）を増やさない |
| D35 | 描画に使う列 | geometry 列（WKB）を decode して描く。読む列から geometry を外したときは描かず「geometry を読んでいないので描けない」と表示する（bbox 列から代わりに描くことはしない） | 「描くには geometry 列が要る・要らない列は読まない」という列指向の関係をそのまま見せる |
| D36 | 行単位の判定 | decode 後に各行の geometry の bbox を表示範囲と比べ、範囲内の行は濃く、範囲外の行（読んだが捨てる行）は薄い灰色で描く。行数も「読んだ行 / 範囲内の行」で出す | ページ単位の pruning は保守的で範囲外の行も読むことが見える。cogp-js の「行単位判定」に当たる段を funnel に 1 段足す |
| D37 | 地図への描き方 | MapLibre の GeoJSON source に点・線・面の layer を 1 組。色は行が属する Level（その Row Group が加わった Level）で塗り分ける。decode はメインスレッドで、ページごとに処理を区切って描画を止めない | 追加の描画ライブラリが要らない。Level の色分けで prefix 構造が実データで見える。数万行ならメインスレッドの decode で足りる（実測は下の表） |
| D38 | progressive rendering | 合体後の Range をファイル順（= 粗い Level → 細かい Level の順）に同時 6 本（`READ_CONCURRENCY`）で発行し、読み終わった Range から decode して描き足す。新しい計画の最初の描画まで前回の描画を残す。進み具合（読んだ Range 数 / 全体）を funnel に出す | COGP ではファイル順が粗い順なので、先に粗い全体像が出て細部が後から埋まる様子がそのまま現れる。D29 のウォーターフォールで並列の様子も見える |
| D39 | Expected vs Actual の単位 | 1 回の計画（地図の移動 1 回分）ごとに、Access Plan に Expected・Actual・差の 3 列を出す。比べる項目: Range Request 数、バイト数（目的別）、行数（読んだ行 / 範囲内の行）、所要時間 | D23 で分けておいた推定と実測を、同じ funnel の上で突き合わせる |
| D40 | 差の分類 | Actual の各 read を Expected の Range と照合し「予定どおり / 予定外（Expected に無い read）/ 未読（中断などで読まなかった予定）」に分ける。Physical File Map の「読む予定」の段の下に「実際に読んだ」の段を並べる | 自前で読むので通常はほぼ一致する。一致しないときに理由（中断・Index の追加読み込みなど）がすぐ分かるようにする |
| D41 | 診断の置き場所と判定の材料 | Inspector に「診断」を追加し、ファイルを開いた時点で Footer だけから判定する。MUST・SHOULD・仕様外の目安の 3 群に分け、各項目に根拠の値を出し、クリックで該当する Row Group などを選ぶ。Page Index が要る項目（ページ境界がそろっているか等）は、Index を読んだ Row Group の分だけ判定する | 「開くときは Footer だけ」（D15）を守る。MUST と SHOULD を混ぜない。D7 の Selection に乗せ、新しいペインは作らない |
| D42 | 空間的なまとまりの指標 | Level ごとに「その Level で加わった Row Group の bbox 面積の合計 ÷ それらの bbox を合わせた範囲の面積」を重なり係数として出す。合否は付けない。1 を超えた分が重なり、1 未満は Row Group の間の隙間（データの無い範囲）を表す | Footer の統計値だけで計算できる。閾値には根拠が無いので決めず、サンプルの比較で元の順・Hilbert 順・COGP の値を並べて意味を読ませる |
| D43 | 比較用サンプル | 公式サンプルから東京 23 区付近を切り出し、同じ行・同じ列・同じ圧縮・同じ Row Group の大きさ・Page Index ありで作る: (1) 元の順（id 順）、(2) Hilbert 順、(3) cogp v1.0.0 の CLI で作った COGP、(4) (3) の GeoParquet 2.0 版（D49）。生成スクリプトは `scripts/make_samples.py`、出力は `samples/` にコミットし、公開版は Cloudflare R2 から配信する | (1)と(2)の差で「空間的にまとめる」効果、(2)と(3)の差で「Level がある」効果が分かれて見える（§1 の問いに対応）。各 11MB 前後で Git に置いても重くなく、CI のテストにも使える。GitHub Pages は Range を正しく扱えない（下の実装メモ） |
| D44 | 比較の UI | 開いているファイルとは別に「比較対象」を 1 つ開く（Footer と Page Index だけ読む）。同じ表示範囲で両方に Access Plan を計算し、funnel を横に並べる。値は「現在の表示範囲」と「Simulator を ON にしてからの累計」の 2 通り。実データを読むのは主ファイルだけ | 地図・ツリー・Physical File Map は主ファイルのまま変えず、変更を funnel に閉じ込める。比較対象の実データまで読むと通信量が倍になるため |
| D45 | 公開版の入口 | ヘッダーに「サンプル」ボタン（元の順 / Hilbert 順 / COGP / COGP（2.0））を置き、サンプルを開いているときは残りのサンプルを比較対象に選べるようにする | 公開版ですぐ試せる入口にする |

実装メモ:

- decode は hyparquet の内部関数 `readColumn`（`src/column.js`）に「辞書ページ + 読んだデータページ」をつないだバイト列を渡す。
  readColumn はヘッダを順にたどるので、読み飛ばしたページを抜いてつないでも値はページ順に出る。値の数を読んだページの行数と突き合わせ、合わなければエラーにする。
- geometry 列は `utf8: false` で decode する（D6 で geo から論理型を補わないため、既定では WKB が文字列になる）。
- 読むのは選んだ列すべてだが、decode するのは geometry 列だけ（描画に使うのは geometry だけのため）。bbox 列などは読んだバイト数だけが Actual に入る。
- ローカルファイルの read は途中で止められないので、読む前と読み終えた直後に `AbortSignal` を確かめて、古い計画の decode を省く。
- store は decode した行と進み具合を `requestAnimationFrame` で 1 フレーム分ずつまとめて入れる。Column Chunk ごとに入れると、数万行の GeoJSON を地図に渡し直す回数が Range 数だけ増えるため。
- Expected vs Actual で突き合わせるのは計画が決める 2 種類の read だけ。Page Index の Expected は「計画時にキャッシュに無く、新たに読むと決めた Index」を合体した範囲、データページの Expected は `plan.requests`。Footer・ページヘッダ・ページの中身（§3.6）は対象にしない。
- 「その計画の Actual」は、その計画の計算を始めた時刻から次の計算を始めた時刻までに始まった read。read に計画の番号を付けず開始時刻で分けるので、地図を続けて動かしたときの前の計画の Index の読み込みの続きは「予定外」に出る。
- 照合は範囲の完全一致で行う。中断・失敗した read は Actual に数えず、その範囲は「未読」になる。read が 1 つ失敗したら残りの read を止める（`mapLimit` は 1 つが失敗しても他の worker が読み続けるため）。
- Physical File Map の「実際に読んだ」の段は、予定どおりを緑、予定外を黄（geometry 列の橙と区別するため）、中断・失敗を灰で塗り、未読は破線の枠で示す。
- 診断（`src/diagnose/diagnose.ts`）は項目ごとに ok・ng・warn・info（参考値）・unknown（未確認）・na（対象外）を付ける。ng は MUST だけに使い、SHOULD と目安には warn を使う。
  - MUST: geo メタデータの形、lod の境界条件、Row Group が Level 境界をまたがない（row_group_end が Row Group 番号なので境界条件を満たせば構造上満たす）、各行を 1 回だけ格納（ファイルだけでは確かめられないので常に未確認）、GeoParquet 2.0 の項目（D51）。
  - SHOULD: 空間統計の有無、先頭 Row Group の小ささ（中央値より小さいか）、Level ごとの重なり係数、Level 0 がデータ全体の範囲の何 % を覆うか。
  - 目安: bbox covering、Page Index、covering 4 列のページ境界、Row Group の大きさ、lod の無いファイルでは全 Row Group の重なり係数。
  - ページ境界は PageCache に Index がある Row Group の分だけ判定する。PageCache は変更を通知しないので、read の数が増えたことを合図に判定し直す。
- 比較対象は主ファイルとは別の `TracedSource`・`PageCache` で読む。主ファイルの Range 記録・Physical File Map・Expected vs Actual に比較対象の read を混ぜないため。主ファイルを開き直すと比較対象も閉じる。
  地図投影が違えば計算せず理由を出す。読む列は名前で対応づける（cogp は bbox 列を作り直すので、並びがファイルごとに違いうる）。
  累計は、同じ表示範囲について両方の計画がそろった回だけ足す。
- サンプル（D43）: 東京 23 区付近（139.56〜139.92°E、35.52〜35.82°N、152,127 行）。Hilbert 順は bbox 中心を 2^16 格子に置いた Hilbert 番号（同じ番号は id 順）。
  - そろえた条件: Row Group 8,192 行・ページ 1,024 行・ZSTD レベル 3・geometry と bbox は辞書なし・id と tags は辞書あり・Page Index あり。Row Group を公式サンプルより小さくしたのは、15 万行では通常 GeoParquet が 3 個の Row Group にしかならず、Row Group 単位の読み飛ばしの差が見えないため。
  - そろえられなかった点: pyarrow は ColumnIndex を全列に書く（cogp は bbox 列だけ）。`store_schema=False` で ARROW:schema を省き、Footer の大きさを近づけた。
  - pyarrow は入れ子の列を葉のパスで指定しないと辞書を使わない（`use_dictionary=["tags"]` は効かない）。
  - 結果: 元の順 11.0MB・19 RG、Hilbert 順 10.8MB・19 RG、COGP 11.8MB・28 RG・16 Level（z0〜z16 のうち空の Level が 1 つ落ちた）、COGP（2.0）11.5MB。Level 0 は 1 行だけ（範囲が狭く、最も粗い間引きの格子に 1 点しか入らない）。
  - 重なり係数: 元の順は全体で 18.91（19 個の Row Group がどれもほぼデータ全体を覆う）、Hilbert 順は 1.31、COGP は Level ごとに 0.96〜1.00。
- GitHub Pages は `.parquet` を gzip で送り、Content-Length も Range も圧縮後のバイト列を指すため、サンプルを Pages に置くと読めない。ブラウザは Accept-Encoding を自動で付け、fetch の側では避けられない
  （[community #178318](https://github.com/orgs/community/discussions/178318)、[PMTiles #584](https://github.com/protomaps/PMTiles/issues/584)）。
  そこで `HttpRangeSource` は、応答に Content-Encoding が付いている、または Range 応答の全体の長さが HEAD のサイズと違うときに `compressed-transfer` として止める（どちらのヘッダもクロスオリジンでは公開されているときだけ読める）。
- R2 は r2.dev の公開 URL から配信し、URL はビルド時の `VITE_SAMPLES_BASE`（リポジトリ変数 `SAMPLES_BASE`）で渡す。未設定ならサンプルのボタンを出さない。
  バケットの CORS ポリシーは、許可オリジン `https://www.jumboly.jp` と `http://localhost:5173`、GET / HEAD、許可ヘッダ `range`、公開ヘッダ content-length・content-range など。
- 公式サンプルの実測（Node、ローカルファイル、既定の 5 列）:

  | 表示範囲 | Level | 読む量 | Range Request | decode した行 | 範囲内の行 | 所要時間 |
  |---|---|---|---|---|---|---|
  | 東京周辺（0.0003°/px） | 10 | 2.69MB | 95 回 | 65,447 | 17,804（27%） | 52ms |
  | 関東（0.003°/px） | 6 | 1.14MB | 45 回 | 26,535 | 4,265（16%） | 15ms |
  | 世界全体（0.35°/px） | 0 | 0.36MB | 1 回 | 8,103 | 8,093 | 4ms |

  ページ単位の pruning は保守的なので、読んだ行の 7〜8 割は表示範囲外（D36 の「読んだが捨てる行」）。
  診断は MUST をすべて満たす（「各行を 1 回だけ」は未確認）。重なり係数は Level 0〜2 で 1.00、細かい Level ほど下がり 0.74〜0.78（1 未満は海などの隙間による）。
- 同梱サンプルでの推定（既定の 5 列、`test/samples.test.ts` で CI でも確かめる）:

  | 表示範囲 | 元の順 | Hilbert 順 | COGP | COGP（2.0） |
  |---|---|---|---|---|
  | 23 区全体（0.0005°/px） | 5.97MB・19 回 | 5.42MB・19 回 | 0.41MB・9 回（Level 8） | 0.40MB・9 回（Level 8） |
  | 新宿区くらい（0.00008°/px） | 5.97MB・19 回 | 0.72MB・17 回 | 0.83MB・76 回（Level 11） | 0.81MB・76 回（Level 11） |
  | 渋谷駅付近（0.00002°/px） | 5.97MB・19 回 | 0.25MB・15 回 | 0.51MB・60 回（Level 13） | 0.49MB・60 回（Level 13） |

  元の順は拡大しても何も読み飛ばせない。Hilbert 順は拡大すると Row Group・ページで絞れるが、全体表示では全行を読む。COGP は全体表示で Level による prefix が効き、拡大すると粗い Level から続く prefix の分だけ Hilbert 順より多く読む。§1 の「なぜ空間的にまとめるのか」「なぜ Level があるのか」がこの 3 列で分かれて見える。

### 3.5 GeoParquet 2.0

調査で分かったこと:

- v2.0.0-rc.1 は 2026-07-19 に公開。geometry 列は Parquet ネイティブの GEOMETRY / GEOGRAPHY 論理型（WKB）が MUST で、`encoding` は `"WKB"` だけになった。
- `geo` は MUST だが、writer は論理型だけを書いてもよい（その場合は 2.0 に準拠しないが、2.0 の reader は読めるべき）。GDAL の `USE_PARQUET_GEO_TYPES=ONLY` などが `geo` の無いファイルを書く。
- CRS の正は論理型の `crs`。`geo` 側は PROJJSON か null だけ。両者は同じ CRS を表す MUST があるが、食い違ったときの reader の振る舞いは決まっていない。
  論理型の表記は PROJJSON・`authority:code`・`srid:<n>`・`projjson:<key>`（key-value メタデータを参照）の 4 通りで、省略は OGC:CRS84。
- `geospatial_statistics`（ColumnMetaData の field 17）は Row Group 単位だけ。ColumnIndex に地理の統計は無い。geometry 列の通常の min/max は reader が無視する MUST。
- bbox は日付変更線をまたぐときだけ X が xmin > xmax になり得る（x >= xmin または x <= xmax と読む）。
- bbox covering は rc.1 で消え、2026-09-07（opengeospatial/geoparquet #302）に任意の機能として戻った。ページ単位の絞り込みには covering が要る。
- COGP の `lod` は `geo` の中に置くので、`geo` の無いファイルは COGP になり得ない。
- 出典: [geoparquet.md](https://github.com/opengeospatial/geoparquet/blob/main/format-specs/geoparquet.md)、[parquet-format Geospatial.md](https://github.com/apache/parquet-format/blob/master/Geospatial.md)

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D46 | `geo` が無く論理型だけのファイル | 論理型から GeoModel を組み立てる。主ジオメトリ列はスキーマ上で最初の geometry 列。地図・Row Group bbox・Simulator・実データ描画はそのまま動かす。Level 関連は対象外 | 2.0 の reader に求められる振る舞い。GDAL の ONLY 出力などで空間の絞り込みが見えるようにする |
| D47 | CRS の決め方と食い違い | 地図の投影と resolution の単位は論理型の crs で決める。Inspector に論理型と geo の両方を並べ、識別子で比べて食い違えば診断で MUST 違反にする。4 通りの表記をすべて解釈し、`srid:0` は CRS 不明、`srid:4326`・`srid:3857` はその EPSG として扱う | 仕様が論理型を正と定めている。食い違いは隠さず見せるのがデバッガの役目 |
| D48 | 日付変更線と GEOGRAPHY | xmin > xmax の bbox を「日付変更線をまたぐ」と読み、描画にも絞り込みにも使う（どちらかの側に重なれば重なる）。GEOGRAPHY の bbox は統計の値をそのまま使い、実データの線と面は平面のまま描いて注記を出す | 太平洋をまたぐデータでも絞り込みを効かせる。GEOGRAPHY の bbox は書き手が辺を考えて求める |
| D49 | サンプル | (a) テスト用に apache/parquet-testing の geospatial のサンプル（geo なし・srid・projjson・GEOGRAPHY）と geoparquet の example.parquet を `test/fixtures/geo2/` に置く。(b) `make_samples.py` で東京の COGP を論理型で書き直した版（geo 2.0.0・lod・covering を残し、行の順と Row Group は同じ）を作り、4 つ目のサンプルにする | (a) は小さく、表記のばらつきを網羅できる。(b) で「2.0 の COGP」を実際に試せ、1.1 版と同じ条件で比べられる |
| D50 | geometry 列の統計 | 通常の min/max と ColumnIndex の値は表示するが判定に使わない。`geospatial_statistics` の bbox と `geospatial_types`（ISO WKB の番号を名前にする）を Column Chunk の Inspector に出す | 仕様が reader に無視を求めている。表示は残して「書かれているが使わない」ことを見せる |
| D51 | 診断に足す項目 | MUST: 論理型と geo の CRS が一致、`geometry_types` と `geospatial_types` が一致、version 2.x なら geometry 列が論理型。geo が無いファイルは「GeoParquet に準拠する」の MUST 違反にし、2.0 の reader は読めること・COGP になり得ないことを注記する | 2.0 で増えた MUST をそのまま確かめる。geo も 2.0 の MUST なので、注意にするとヘッダの要約が「MUST OK」になり実際と合わない |

実装メモ:

- `buildGeoModel(file)`（`src/geo/geoMetadata.ts`）が geo と論理型をまとめる。`crs` は論理型があれば論理型の CRS にするので、表示・計画・描画は `geo.primary.crs` を見るだけで済む。geo の有無は `GeoModel.hasGeo` で見分ける。
- 論理型の crs は `describeLogicalCrs`（`src/geo/crs.ts`）で解釈し、識別子 `id` を `sameCrs` で比べる（OGC:CRS84 と EPSG:4326 は同じとみなす。PROJJSON に id が無ければ比べられないので未確認）。
- hyparquet は GEOMETRY / GEOGRAPHY 論理型の列を decode するときに GeoJSON に変える。`decodeChunk` では parser を差し替えて WKB のバイト列のまま返し、1.x と同じ `parseWkb` の経路で描く。
- 日付変更線（D48）: `Bbox` の型はそのままにし、xmin > xmax を `wrapsX` で見分ける。`intersects` は、またぐ bbox を端が ±Infinity の 2 つに分けて比べる。±180 で切らないのは、CRS の座標の範囲（経緯度か 3857 のメートルか）に依らないため。
  地図に描くときは `toLonLatBbox` で xmax に 360 を足して 1 つの矩形にする（MapLibre は ±180 を超える経度を隣の世界として続けて描く）。
  診断の面積は、またぐ bbox の xmax に一周分（360° または 2 × 20,037,508 m）を足して計算し、一周の幅が分からない CRS では計算から外す。
- 診断の型の比較は、全 Row Group の `geospatial_types` を合わせて `geometry_types` と集合として比べる。`geometry_types` が空のときや、型の統計が無い Row Group があるときは未確認にする。
- 2.0 版サンプル（`write_native_cogp`）は、geometry 列を geoarrow-pyarrow の WKB 拡張型にすると pyarrow 25 が GEOMETRY 論理型と `geospatial_statistics` を書く（拡張型のメタデータをフィールドに付けるだけでは論理型にならない）。
  crs を持たせないので論理型の crs は省略（＝ OGC:CRS84）。Row Group の bbox・選ばれる Level・絞り込みは 1.1 版の COGP と同じになる（`test/samples.test.ts`）。
- 未確認: 日付変更線をまたぐ bbox を実ファイルでは確かめていない。pyarrow は GEOMETRY では平面の bbox を書き、xmin > xmax のファイルを作れないため。

### 3.6 辞書の値と index の表示

調査で分かったこと:

- サンプル 4 種類で辞書を使う列は `id`・`tags.key_value.key`・`tags.key_value.value`。`id` はほぼ一意なので辞書が効かず、`tags.key` は同じ値が何度も出るので最もよく効く。
- tags は入れ子（Map）なので、データページには index の前に repetition / definition level が入る。level も index も RLE / Bit-Packing の混合形式（hybrid）。
- hyparquet の `readRleBitPackedHybrid` は decode した値だけを返し、RLE と Bit-Packing の区切りは返さない。

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D53 | 読む時機と範囲 | データページの Inspector の「中身を読む」ボタンで、そのページと Column Chunk の辞書ページだけを読む。辞書ページは Column Chunk ごとにキャッシュ | 開くときは Footer だけ、選ぶときは Index とヘッダだけ、という方針を崩さない。読んだ量は Range 記録に残る |
| D54 | index の decode | RLE / Bit-Packing の hybrid decoder を自作し、区切りごとに種類・ページ内のバイト位置・値の数を記録する。値は hyparquet の結果と突き合わせてテストする | 「同じ番号が続くと数バイトで済む」ことを区切りの単位で見せられる。自作部分は 100 行ほどで小さい |
| D55 | 入れ子の列 | level も同じ decoder で読み、ページ本体を「rep level / def level / index」に分けてバイト数を出す。値ごとに行・null・index・辞書の値を並べる（rep level が 0 のところで行が変わる） | 1 行に複数の値が入る仕組みも一緒に見える。辞書が最も効く tags.key を対象から外さずに済む |
| D56 | 効果の数値 | 読んだページの値を PLAIN で書いた場合のバイト数（BYTE_ARRAY は 4 + 長さ、INT64 は 8 など）と、index 部分のバイト数、index にこのページで使った辞書の値の PLAIN サイズを足した合計を、どれも圧縮前で比べる。1 つの値が平均 2 回未満しか使われないページには辞書が効いていないと注記する。値ごとの出現回数を多い順に出す | id では index が PLAIN の 16% になるが、値そのものは辞書ページにすべて書かれており小さくなっていない。index だけを比べるとこの違いが見えない（合計では PLAIN の 116%）。圧縮後の比較は ZSTD の圧縮器が要るので行わない |
| D57 | 一覧の見せ方 | 値の表（順番・行・level・index・値）と辞書の表（index・値・このページでの回数）を並べ、どちらも 100 件ずつページ送り。辞書は既定で「このページで使った値だけ」、切り替えで全件。index をクリックすると辞書の行を、辞書の値をクリックするとその index の値を強調する | 4 万件を超える辞書でも追加のライブラリなしで扱える。対応がクリック 1 回で分かる |
| D58 | 対象にするページ | ボタンは辞書で符号化されたデータページ（RLE_DICTIONARY / PLAIN_DICTIONARY）と辞書ページに出す。辞書ページでは辞書の一覧だけを出す。途中から PLAIN に切り替わった（fallback）ページには「辞書を使っていない」と理由を添える。DATA_PAGE_V2 は level が圧縮されずにページ本体の先頭に置かれるので、その形に合わせて読む | 辞書が大きくなりすぎると writer は PLAIN に切り替える。それも Chunk の中の事実として見せる |
| D59 | ページ本体の内訳 | ページの Inspector に、展開後の本体を「rep level / def level / index」に分けた帯を出す。区切り（RLE / Bit-Packing）をクリックすると、その区切りに当たる値を表で強調する | バイト列と値の対応が 1 画面で見える。Physical File Map は圧縮後のファイルの位置を表すので、展開後の内訳はそこに混ぜない |

実装メモ:

- hybrid decoder は `decodeHybrid`（`src/parquet/hybrid.ts`）。区切りごとに種類・位置・ヘッダ長・取り出した値の数・書かれている値の数（Bit-Packing は 8 の倍数なので、末尾は詰め物を含む）を返す。
  32 ビットの値で符号が付かないよう、ビット演算ではなく掛け算で組み立てる。テストは、自前の encoder で作ったランダムな並びを hyparquet の `readRleBitPackedHybrid` と突き合わせる。
- ページの分解は `readPageContent`（`src/data/pageContent.ts`）。展開と PLAIN の decode・型の変換は hyparquet の内部関数（`decompressPage`・`readPlain`・`convert`）を使う。
  v1 は本体全体を展開してから「4 バイトの長さ + level」を rep → def の順に読む。v2 は level が圧縮されないので、level と展開した値をつないで 1 つの「展開後の本体」として扱う（level の長さは PageHeader の `repLevelsByteLength`・`defLevelsByteLength`）。
- 辞書ページの decode 結果は、PageCache ごとの WeakMap に Column Chunk 単位で残す。ファイルを開き直すと PageCache が作り直されるので、辞書も一緒に捨てられる。ボタンに出すバイト数は、辞書を読み済みならデータページの分だけにする。
- read の purpose は `page-content …` で、Range 記録では「ページの中身（辞書と index）」に分類する。
- 公開サンプルはすべて DATA_PAGE（v1）で fallback も起きないので、`test/fixtures/dictionary/`（`test/fixtures/make_dictionary.py` で作る）で v2 と fallback を確かめる。
  fallback は pyarrow の `dictionary_pagesize_limit` を小さくして起こす。
- hyparquet は Map 列を「key_value の繰り返し」の 1 段を残した入れ子の配列に組み立てる。テストでは平らにしてから比べる。
- bit width はページごとに書かれる。id 列（`tokyo-id.parquet` の RG0）では #1〜#8 が 10・11・12・12・13・13・13・13 ビットで、どのページもそこまでに出てきた辞書の件数（= そのページの index の最大値 + 1）をちょうど表せる幅だった。
- 実測（`tokyo-id.parquet` の RG0・ページ #1。どれも圧縮前）:

  | 列 | 辞書の件数 | bit width | PLAIN | index | index の区切り（うち RLE） |
  |---|---|---|---|---|---|
  | id | 8,192 | 10 | 8.0KB | 1.25KB | 3（0） |
  | tags.key | 396 | 8 | 105KB | 8.4KB | 17（0） |
  | tags.value | 14,784 | 12 | 141KB | 12.5KB | 19（1） |

  pyarrow の index はほぼすべて Bit-Packing で、RLE は level（tags の def level は 8,538 値が RLE 1 つ）に現れる。

## 4. アーキテクチャ

```text
UI (React)   Tree / Map / Inspector / ByteMap が「選択状態」を 1 つ共有して同期
   ↑
state/     zustand の store（ファイル・選択・Page Index のキャッシュ・Simulator・実データ・比較対象）
   ↑
Model 層（純粋関数・UI 非依存）
   parquet/   footer 解析 → FileModel、Page Index・ページヘッダの読み込みとキャッシュ、hybrid decoder
   geo/       geo メタデータと論理型 → GeoModel（CRS, covering, bbox）、Page bbox
   cogp/      lod の検証・Level → RG の prefix
   plan/      viewport → AccessPlan（Expected。段階ごとの中間結果を返す）、Expected vs Actual、2 ファイルの比較
   data/      計画どおりに読んで decode、WKB、ページの中身（辞書・level・index）
   diagnose/  COGP / GeoParquet の MUST・SHOULD・目安の判定
   ↑
IO 層
   RandomAccessSource { kind, name, size, read(offset, length, purpose, signal?) }
    ├ LocalBlobSource   File.slice（全体は読まない）
    └ HttpRangeSource   HEAD でサイズ → Range GET、206 を検証、失敗理由を分類
   TracedSource: すべての read を {offset, length, purpose, 所要時間} で記録 = Actual
```

- `read` に purpose（読む目的のラベル。例: `footer`, `offset-index RG2 bbox.xmin`）を渡す。
  Range Request 可視化と Expected vs Actual の比較を後から作り直さずに済ませるため。
- hyparquet には IO 層を包んだ AsyncBuffer を渡し、hyparquet 経由の read もすべて記録する。
- cogp-js には依存しない。Level 選択や pruning の中間結果を画面に出すため。ロジックは cogp-js と合わせる。
- HTTP エラーの分類（`src/io/errors.ts`）: `fetch` の TypeError → 通信か CORS、200 応答 → Range 非対応、Content-Length 不明 → 公開ヘッダー不足、gzip などの転送 → `compressed-transfer`、ほかに HTTP ステータス・短い応答・Parquet でない。
- Physical File Map は canvas 描画でズーム可能にする。2.2GB 中の Footer（0.5MB）は 0.02% なので、最小描画幅とズームが必須。
- 地図表示は CRS84 / EPSG:4326 と EPSG:3857 のみ（3857 は式で変換）。他の CRS は構造解析のみ。

ディレクトリ構成:

```text
cogp-inspector/
├ src/
│ ├ io/        source.ts, local.ts, http.ts, traced.ts, errors.ts, coalesce.ts（Range の合体）, readCategory.ts（read の分類）
│ ├ parquet/   footer.ts, model.ts, pageIndex.ts, pageHeader.ts, pages.ts（Index・ヘッダの読み込みとキャッシュ）, hybrid.ts
│ ├ geo/       geoMetadata.ts, crs.ts, bbox.ts, pageBbox.ts, geometryTypes.ts
│ ├ cogp/      lod.ts（検証・prefix）
│ ├ plan/      accessPlan.ts, viewport.ts, compare.ts（Expected vs Actual）, compareFiles.ts（2 ファイルの比較）
│ ├ data/      readData.ts（計画どおりに読む）, decodeChunk.ts, geometry.ts（WKB）, pageContent.ts（辞書・level・index）
│ ├ diagnose/  diagnose.ts
│ ├ state/     store.ts, diagnosis.ts, planComparison.ts
│ ├ ui/        layout/, header/, tree/, map/, inspector/, bytemap/, common/
│ ├ util/      color.ts, format.ts
│ ├ inspect.ts ファイルを開く入口（Footer を読み、FileModel・GeoModel・lod・Row Group bbox を作る）
│ ├ samples.ts 同梱サンプルの一覧と配信先
│ └ main.tsx
├ test/            vitest。*.real.test.ts は data/ の公式サンプルがあるときだけ走る
│ └ fixtures/      geo2/（GeoParquet 2.0 の公開ファイル）, dictionary/（make_dictionary.py で作る）
├ samples/         比較用サンプル 4 種類（テストでも使う。公開版は R2 から配信）
├ scripts/         make_samples.py（サンプルの生成）
├ data/            公式サンプル（Git 管理外、ハードリンク）
├ docs/            設計メモ・未対応の課題
└ .github/workflows/pages.yml
```

## 5. 確認の方法

linter は置いていない。確認は `tsc -b`・vitest・`vite build`（`npm run build` で両方）で行う。
CI（`.github/workflows/pages.yml`）は main への push でテストとビルドを行い、GitHub Pages に公開する。

## 6. スコープ

- MVP（実装済み・§3.2）: ローカル / URL で開く、Footer 解析、Schema、Row Group 一覧、GeoParquet メタデータ、`geo.lod` 解析、
  Level 一覧、Level と Row Group の対応、Row Group bbox の地図描画、Row Group Inspector、Physical File Map
- Phase 2（実装済み・§3.3）: Column Chunk 詳細、Page、Dictionary、Page Index、Page bbox、Page pruning、Access Simulator、Range Request 可視化
- Phase 3（実装済み・§3.4）: 実データ描画、progressive rendering、Expected vs Actual 比較、診断、比較用サンプルと通常 GeoParquet との比較
- GeoParquet 2.0（実装済み・§3.5）: 論理型の GEOMETRY / GEOGRAPHY、論理型の crs、geo の無いファイル、日付変更線をまたぐ bbox、2.0 の MUST の診断、2.0 版のサンプル
- 辞書の値と index の表示（実装済み・§3.6）: 辞書ページとデータページの本体を読み、RLE / Bit-Packing の区切り・level・index・辞書の値の対応と、PLAIN で書いた場合との差を見せる
- 未対応: Footer のフィールド単位の色分け、EPSG:4326 / 3857 以外の CRS の地図表示、統計値の無い Row Group の bbox をジオメトリから計算する（[docs/issues/](issues/)）
