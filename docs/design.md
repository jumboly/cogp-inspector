# 設計メモ

2026-09-23 時点の調査結果と決定事項。MVP は実装済み（§3.2 に実装時の判断を記録）。Phase 2 の判断は §3.3。
推測を含む箇所は【推測】と明記する。

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
- v2.0（rc.1、2026-07）: Parquet ネイティブの GEOMETRY / GEOGRAPHY 論理型が必須。
  Parquet 側に `geospatial_statistics.bbox` があり、Row Group 単位の pruning はこれで足りる。ページ単位には covering 列の Page Index が効く。

### 2.5 公式サンプル（実測）

`https://cogp-demo.spatialty.io/v1.0.0/pois.cogp.parquet`（2,244,348,968 B、parquet-rs 56.2.1 で生成）

| 項目 | 値 |
|---|---|
| Footer | 493,165 B。hyparquet の初回 512KiB read 1 回で取得 |
| Row Group | 468 個、30,052,264 行（1 個あたり 660〜65,536 行） |
| 列 | `id`, `tags.key_value.key`, `tags.key_value.value`, `geometry`, `bbox.{xmin,ymin,xmax,ymax}` |
| 圧縮 / エンコーディング | 全列 ZSTD。id・tags は RLE_DICTIONARY、geometry・bbox は PLAIN |
| Level | 17 段、resolution 0.3516°〜5.36e-6° |
| 統計値 | bbox 4 列は全 Row Group に min/max あり。`geospatial_statistics` は無し |
| Page Index | OffsetIndex は全 3,744 chunk、ColumnIndex は bbox 4 列（1,872 chunk）のみ。Footer 直前に約 3.0MB |

配信サーバーの挙動:

- Range Request（`bytes=N-M`）に 206 で応答、`accept-ranges: bytes`
- CORS はオリジン許可制。`localhost:5173` と `kanahiro.github.io` には許可が返り、他のオリジンには返らない
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

## 3. 決定事項（2026-09-23）

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D1 | サンプルデータ | 開発は公式サンプルを `data/` にハードリンクして使う。自作の小サンプルは後日（[issue 01](issues/01-generate-small-samples.md)）。公開版では公式サンプルをダウンロードしてローカルで開く案内を出す | 公式サンプルは GitHub Pages のオリジンから CORS で読めない見込み。ローカルファイルなら CORS の制約を受けない |
| D2 | リポジトリ名 | `cogp-inspector` | 用途が名前で伝わり、デバッガにも教材にも合う |
| D3 | パーサ | hyparquet を主に使い、PageHeader の解析だけ自作 | 必要な物理構造がすべて取れ、読んだ range も追跡できることを実データで確認済み。Rust/WASM でも PageHeader は非公開 API のため得るものがない |
| D4 | Row Group bbox（MVP） | 統計値のみ: covering 列の Row Group 統計 → `geospatial_statistics` の順。無ければ「bbox 不明」 | 初期処理を Footer 読み込みだけに保つ。統計が無いと読み飛ばせない事実もそのまま見せられる |

### 3.1 実装メモ（調査・土台作成で分かったこと）

- hyparquet 1.31 の公開 API: `parquetMetadataAsync`（既定で末尾 512KiB を 1 回 read、足りなければ追加 1 回）、
  `readColumnIndex` / `readOffsetIndex`、`asyncBufferFromUrl`（HEAD でサイズ取得）。AsyncBuffer は `{ byteLength, slice(start, end) }`。
- PageHeader を解析する `parquetHeader`（src/column.js）は非公開。`hyparquet/src/thrift.js` の `deserializeTCompactProtocol` は
  package.json の `exports`（`./src/*.js`）経由で import でき、結果は `field_N` 形式の生オブジェクトになる（非公式 API なのでバージョン固定が必要）。
- 公式サンプル実測: RG2 `bbox.xmin` は DATA_PAGE(v1) 23 枚、各ヘッダ 22B、2,048 値。OffsetIndex の `compressed_page_size` はヘッダ込み。
  id 列先頭は DICTIONARY_PAGE（8,103 件、ヘッダ 19B）。ページ単位の Statistics は無い。
- 背景地図は API キー不要の OSM ラスタタイル（彩度を落として表示）を仮採用。変更可。
- MapLibre v6 + Vite: `optimizeDeps.exclude: ['maplibre-gl']` と、`?worker&url` で worker をバンドルして `setWorkerUrl` に渡す対処が必要（src/ui/map/MapView.tsx）。
- GitHub Pages の公開先は独自ドメイン https://www.jumboly.jp/cogp-inspector/（公式サンプルの CORS は不許可を確認済み）。

### 3.2 MVP 実装時の判断（2026-09-23、「最後まで走る」指示のもとおすすめ案で決定）

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D5 | Footer の読み方 | hyparquet の `parquetMetadataAsync`（末尾 512KiB を一括）を使わず、末尾 8 バイト → Footer ちょうどの 2 回に分けて読み、`parquetMetadata` に渡す | Parquet の読み方そのものを Range 記録で見せるため。往復 1 回の増加は許容 |
| D6 | メタデータの型 | `parquetMetadata(..., { geoparquet: false })` | hyparquet が geo から logical_type を補完するのを止め、ファイルに実際に書かれた Parquet の型を見せる |
| D7 | 状態管理 | zustand。選択（Selection）を 1 つ持ち全ペインが購読する。選択の発生元（map / tree / bytemap / inspector）も持ち、地図以外で選んだときだけ地図を移動する | ペイン間の同期を 1 か所にまとめる |
| D8 | Structure ツリーの並び | ファイルの物理順（先頭 magic → Row Group → Page Index → Footer → trailer）。Schema・geo・lod は Footer の子 | 「メタデータはすべて末尾の Footer にある」ことを階層で見せる |
| D9 | 地図の重なり | 細かい Level ほど上に描く。クリック時は重なった bbox のうち面積最小の Row Group を選ぶ | 粗い Level の Row Group はほぼ全球を覆うため |
| D10 | 表示 Level | 選んだ Level の prefix だけを表示し、その Level で増えた Row Group を太線、引き継いだ Row Group を細線にする。lod が仕様違反なら警告を出す | prefix 構造（前の Level を含んだまま増える）を地図上で見せる |
| D11 | Physical File Map | canvas。構造・Column Chunk（列の役割で色分け）・読み込みの 3 段。最小描画幅 2px、Level 選択時は prefix の連続範囲を枠で示す | 2.2GB 中の Footer（0.02%）も見えるようにする |
| D12 | バイナリ列の統計 | BYTE_ARRAY で文字列系の論理型でない列（WKB など）は min/max を `<バイナリ N bytes>` と表示 | hyparquet は文字列化して返すため文字化けする |
| D13 | 開発サーバー | `data/` を Range 付きで配信する Vite プラグイン。Range なしは 416 | URL で開く経路を手元で再現する。2.2GB を public/ に置くとビルドにコピーされるため |

### 3.3 Phase 2 の判断（2026-09-23）

D14〜D22 はユーザーと 1 問ずつ議論して決定。D23 以降は「以降はおすすめで進めて」の指示のもとおすすめ案で決定。

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| D14 | 作る順番 | 下から 4 段階: A. Column Chunk 詳細・Page 一覧・辞書 → B. Page Index・Page bbox → C. Access Simulator → D. Range Request 可視化。段階ごとに commit + push | 後の段階が前の段階の上に乗るので手戻りがない |
| D15 | Page Index を読む時機 | 必要になったときに、その分だけ読む（Row Group・Column Chunk の選択時、Simulator の候補 Row Group）。読んだものはキャッシュ | 開くときは Footer だけに保てる。「候補に残った分だけ Index を読む」本物のリーダーの読み方が Range 記録に現れる |
| D16 | PageHeader を読む範囲 | Column Chunk を選んだときに、その Chunk のヘッダだけ読む。OffsetIndex があれば位置は OffsetIndex から、無ければ先頭から順にたどる | 1 回の操作の read 数を数十回に抑えつつ、Chunk 内のページを並べて比べられる |
| D17 | Page bbox の組み立て | covering 4 列のページ境界（first_row_index）を合わせた「行範囲」を単位にし、各範囲に重なる各列のページの min/max で bbox を作る。境界がそろっているかを表示 | 列ごとにページの切れ目は独立。どのファイルでも保守的に正しく pruning でき、cogp-js の行範囲の考え方とも合う |
| D18 | 表示縮尺 → 目標 resolution | cogp-js デモと同じ。地図の縦中央で横 100 CSS px の経度差 / 100（3857 のファイルは同じ方法で m / px） | 参照実装と同じ Level が選ばれる。resolution の単位（CRS の座標単位）とそのまま合う |
| D19 | Simulator の起動 | 「Simulator モード」の ON/OFF。ON の間は地図の移動が止まるたびに自動実行し、Level セレクタは自動選択の結果を表示（手動変更不可） | 手動 Level と自動 Level の混同を防ぎ、「動かすと読む範囲が変わる」を体験できる |
| D20 | 結果の見せ方 | Inspector の「Access Plan」に段階ごとの funnel（候補数とバイト数）。段階をクリックすると地図と Physical File Map が連動 | 既存の Selection の同期（D7）に乗せられ、新しいペインが要らない |
| D21 | 読む列 | 列を選べる（既定は geometry + bbox covering 列）。全列を読んだ場合との差も表示 | 列指向の利点がバイト数の差として直接見える |
| D22 | Range の合体 | cogp-js と同じく、重なり・隣接だけ合体し隙間は埋めない。合体前後の数を表示。Index の実際の読み込みも同じ方針で合体する | 参照実装と同じ数値になり、空間順の並びがリクエスト数を減らす効果が見える |

実装メモ（段階 A）:

- ページヘッダは最初 64 バイト読み、途中で切れていたら 4KiB → 64KiB → 1MiB と広げて読み直す（ページ単位の Statistics があるとヘッダが長くなるため）。
- 公式サンプルの辞書ページヘッダは RG0 で 19B（8,103 件）、RG2 で 20B（46,751 件）。ヘッダ長は varint の桁数で変わる。
- parquet-rs は同じ Row Group の OffsetIndex を列順に隙間なく書くため、1 Row Group 8 列分の OffsetIndex は合体して 1 回の read になる。
- PageHeader の解析は hyparquet の内部モジュール（`src/thrift.js`, `src/constants.js`）に依存するため、hyparquet を `1.31.1` に固定した。
- ページ一覧と Page bbox が同じ Index を同時に要求することがあるため、PageCache は読み込み中の Index も共有して二重に読まない。

実装メモ（段階 B）:

- Page bbox は Row Group（またはその中の Column Chunk・Page）を選んだときに、covering 4 列の OffsetIndex と ColumnIndex を読んで求める。
  公式サンプルでは 4 列の ColumnIndex、4 列の OffsetIndex がそれぞれ隣接しているので、合体して計 2 回の read で済む。
- 公式サンプルの RG300 は 32 の行範囲（2,048 行ずつ）で、4 列のページ境界はそろっている（D17 の【推測】どおり）。
- 値がすべて null のページや、min/max が数値でないページは bbox 不明として扱い、読み飛ばさない。

## 4. アーキテクチャ（MVP で実装済み）

```text
UI (React)   Tree / Map / Inspector / ByteMap が「選択状態」を 1 つ共有して同期
   ↑
Model 層（純粋関数・UI 非依存）
   parquet/  footer 解析 → FileModel（RG, ColumnChunk, byte 範囲）
   geo/      geo メタデータ → GeoModel（CRS, covering, bbox）
   cogp/     lod の検証・Level → RG の prefix
   plan/     viewport → AccessPlan（Phase 2 の Access Simulator = Expected）
   ↑
IO 層
   RandomAccessSource { size(), read(offset, length, purpose) }
    ├ LocalBlobSource   File.slice（全体は読まない）
    └ HttpRangeSource   HEAD でサイズ → Range GET、206 を検証、失敗理由を分類
   TracedSource: すべての read を {offset, length, purpose, 所要時間} で記録 = Actual
```

- `read` に purpose（読む目的のラベル。例: `footer`, `offset-index RG2 bbox.xmin`）を渡す。
  Range Request 可視化と Expected vs Actual の比較を後から作り直さずに済ませるため。
- hyparquet には IO 層を包んだ AsyncBuffer を渡し、hyparquet 経由の read もすべて記録する。
- cogp-js には依存しない。Level 選択や pruning の中間結果を画面に出すため。ロジックは cogp-js と合わせる。
- HTTP エラーの分類: `fetch` の TypeError → CORS の可能性、200 応答 → Range 非対応、Content-Length 不明 → 公開ヘッダー不足。
- Physical File Map は canvas 描画でズーム可能にする。2.2GB 中の Footer（0.5MB）は 0.02% なので、最小描画幅とズームが必須。
- 地図表示は CRS84 / EPSG:4326 と EPSG:3857 のみ（3857 は式で変換）。他の CRS は構造解析のみ。

## 5. ディレクトリ構成案

```text
cogp-inspector/
├ src/
│ ├ io/        source.ts, local.ts, http.ts, traced.ts, errors.ts
│ ├ parquet/   footer.ts, model.ts, pageIndex.ts, pageHeader.ts (Phase 2)
│ ├ geo/       geoMetadata.ts, crs.ts, bbox.ts
│ ├ cogp/      lod.ts（検証）, levels.ts（prefix・選択）
│ ├ plan/      accessPlan.ts (Phase 2)
│ ├ state/     store.ts（ファイル・選択・trace の共有状態。zustand を想定）
│ ├ ui/        layout/, tree/, map/, inspector/, bytemap/, help/
│ └ main.tsx
├ test/fixtures/   小さな COGP / 通常 GeoParquet（issue 01 で生成）
├ data/            大容量サンプル（Git 管理外、ハードリンク）
├ docs/            設計メモ・Issue 下書き
└ .github/workflows/pages.yml
```

テストは vitest で Model 層を中心に書く。

## 6. スコープ

- MVP: プロジェクト作成、GitHub Pages 構成、ローカル / URL で開く、Footer 解析、Schema、Row Group 一覧、
  GeoParquet メタデータ、`geo.lod` 解析、Level 一覧、Level と Row Group の対応、Row Group bbox の地図描画、
  Row Group Inspector、Physical File Map 基本版
- Phase 2: Column Chunk 詳細、Page、Dictionary、Page Index、Page bbox、Page pruning、Access Simulator、Range Request 可視化
- Phase 3: 実データ描画、progressive rendering、Expected vs Actual 比較、通常 GeoParquet との比較、診断
