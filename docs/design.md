# 設計メモ

2026-09-23 時点の調査結果と決定事項。実装はまだ行っていない。
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

## 4. アーキテクチャ案（MVP）

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
