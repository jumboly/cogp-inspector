# cogp-inspector

COGP（Cloud Optimized GeoParquet）が Parquet / GeoParquet の仕組みをどう使って
「クラウド最適化」を実現しているのかを、視覚的・対話的に理解するための Inspector（検査ツール）です。

単なる GeoParquet ビューアではありません。

```text
Parquet → GeoParquet → COGP
```

の各層の構造と、それが地図表示・空間検索・HTTP Range Request（ファイルの一部だけを取得する通信）に
どうつながるのかを見せることを目的にしています。

> 最終目標: MapLibre で地図をズーム・パンすると、COGP ファイルのどの Level・Row Group・Page・Column・
> byte range が必要になるのかが見て分かる。

## COGP とは

COGP は GeoParquet の上に「Level of Detail（詳細度の段階）」を足す拡張です
（仕様: [Kanahiro/cloud-optimized-geoparquet](https://github.com/Kanahiro/cloud-optimized-geoparquet) v1.0.0）。

- `geo` メタデータの `lod.levels` に、粗い順から細かい順の Level を並べる
- 各 Level は `row_group_end` までの **Row Group の先頭からの連続範囲（prefix）** を読む
  - Level 0 → RG0、Level 1 → RG0〜RG2、Level 2 → RG0〜RG5 …のように、後の Level は前の Level に行を足していく
- `resolution` はその Level が想定する解像度（主ジオメトリ列の CRS の座標単位）
- 各 Level で新しく入る行は、Row Group 単位で空間的にまとめて並べる（推奨）

これにより、広域表示では先頭の小さな Row Group だけを、拡大表示では必要な範囲の Row Group だけを
HTTP Range Request で読めます。

## このツールで可視化するもの

| 層 | 見せるもの |
|---|---|
| Parquet | Footer（末尾のメタデータ）、Schema（列定義）、Row Group（行のまとまり）、Column Chunk（列ごとのデータ塊）、Page、圧縮形式、エンコーディング、統計値、Page Index（ページ単位の索引）、byte offset |
| GeoParquet | `geo` メタデータ、geometry 列、CRS（座標参照系）、bbox covering（外接矩形の列）、Raw JSON |
| COGP | Level と resolution、Level と Row Group の prefix 構造、Row Group の空間的なまとまり |
| アクセス | 地図の表示範囲から読むべき byte range の推定（Expected）と、実際の読み込み記録（Actual） |

詳しい設計は [docs/design.md](docs/design.md) を参照してください。

## 開発ステータス

MVP・Phase 2・Phase 3・GeoParquet 2.0・辞書の値と index の表示まで実装済みです（内容は [docs/design.md §6](docs/design.md#6-スコープ)）。
公開版: <https://www.jumboly.jp/cogp-inspector/>

未対応の課題は [docs/issues/](docs/issues/) に下書きしています。

## 使い方

| 画面 | できること |
|---|---|
| ヘッダー | ローカルファイル / URL（HTTP Range Request）/ 同梱サンプルで開く。診断の要約と、実際に読んだ回数とバイト数を表示（クリックで一覧） |
| Structure（左） | ファイルの先頭 → 末尾の並びで構造をたどる。Schema・GeoParquet・COGP の情報が末尾の Footer の中にあることが階層で分かる。Column Chunk を開くとページが並ぶ |
| 地図（中央） | Row Group の bbox を Level の色で描画。表示 Level を選ぶと、その Level で読む prefix（RG 0〜row_group_end）だけを表示し、その Level で増えた Row Group を太線で強調。クリックで Row Group を選択。Row Group を選ぶとページ単位の bbox（Page bbox）も青で描く |
| Access Simulator（地図の左上） | ON にすると、地図を動かすたびに「Level 選択 → Row Group の絞り込み → Page Index → ページの絞り込み → Range の合体」の順に読む範囲を推定し、Inspector に段階ごとの候補数とバイト数を表示。読む列も選べる。「実データを読む」を ON にすると推定どおりに読んで geometry を描き、推定（Expected）と実測（Actual）を並べる。「比較対象」を開くと、同じ表示範囲での読む量を 2 ファイルで比べる |
| Inspector（右） | 選んだ要素の詳細と、Parquet / GeoParquet / COGP のどの層の何なのかの解説。Column Chunk ではページ一覧・辞書ページ・ColumnIndex の min/max、Row Group では Page bbox の一覧。辞書で符号化されたページでは「中身を読む」で辞書の値・level・index の対応と PLAIN との差を表示 |
| Physical File Map（下） | ファイル全体のバイト配置（Row Group・Column Chunk・Page・Page Index・Footer）、Simulator が推定した読む予定の範囲、実際に読んだ範囲。ホイールで拡大、ドラッグで移動、クリックで選択 |
| 診断（ヘッダーの「診断」） | Footer だけから、COGP 仕様の MUST・SHOULD と仕様外の目安を判定。クリックで該当する Row Group などを選ぶ |
| Range Request 一覧（ヘッダーの「読み込み N 回」） | 実際に読んだ範囲を目的別に集計し、操作ごとのまとまりで時系列（ウォーターフォール）に表示。クリックで Physical File Map にその範囲を示す |

初期処理で読むのは末尾 8 バイトと Footer だけです（公式サンプルでは 2 回・482KB、ファイルの 0.022%）。
Page Index とページヘッダは、Column Chunk・Row Group を選んだときや Simulator の候補に残ったときに、その分だけ読みます。
データページ（Row Group の中身）は、Access Simulator で「実データを読む」を ON にしたときだけ読みます。

## 起動方法

Node.js 20 以上が必要です。

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # 単体テスト（data/ に公式サンプルがあれば実データのテストも走る）
npm run build   # 静的ファイルを dist/ に出力（main への push で GitHub Pages に自動公開）
```

### サンプルデータ

ヘッダーの「サンプル」から、同梱の比較用サンプル 4 種類を開けます（`samples/`、各 11MB 前後）。
COGP 公式サンプルから東京 23 区付近の POI（152,127 行）を切り出し、並び順だけを変えたものです。

| ボタン | ファイル | 並び順 |
|---|---|---|
| 元の順 | `tokyo-id.parquet` | 通常の GeoParquet。id 順（場所とはほぼ無関係） |
| Hilbert 順 | `tokyo-hilbert.parquet` | 通常の GeoParquet。Hilbert 曲線の順（近い地物が同じ Row Group に入る） |
| COGP | `tokyo.cogp.parquet` | cogp v1.0.0 で変換した COGP（16 Level） |
| COGP（2.0） | `tokyo.cogp-v2.parquet` | COGP の geometry 列を GEOMETRY 論理型にした GeoParquet 2.0 版（並びと Level は COGP と同じ） |

行・列・圧縮・Row Group（8,192 行）とページ（1,024 行）の大きさはそろえてあります。
COGP を開いて Access Simulator を ON にし、「比較対象」に残りのサンプルを選ぶと、同じ表示範囲で読む量を比べられます。
データは © OpenStreetMap contributors で、[ODbL](https://opendatacommons.org/licenses/odbl/) のもとで提供されています。

開発サーバーは `samples/` を Range 付きで配信します。公開版は Cloudflare R2 から読みます（GitHub Pages では Range が壊れるため。design.md D43）。
配信先はリポジトリ変数 `SAMPLES_BASE` で指定し、ビルド時に `VITE_SAMPLES_BASE` として渡します。未設定ならサンプルのボタンは出ません。

作り直すときは、公式サンプルを `data/` に置き、[cogp v1.0.0](https://github.com/Kanahiro/cloud-optimized-geoparquet/releases/tag/v1.0.0) の CLI を用意して実行します（[uv](https://docs.astral.sh/uv/) が必要）。

```sh
uv run scripts/make_samples.py --source data/pois.cogp.parquet --cogp /path/to/cogp
uv run scripts/make_samples.py   # --cogp を省くと、既存の COGP から 2.0 版だけを作り直す
```

作り直したファイルは R2 のバケット `cogp-inspector-samples` に上書きします（`npx wrangler login` のあと）。

```sh
npx wrangler r2 object put cogp-inspector-samples/tokyo-id.parquet --file samples/tokyo-id.parquet --remote
```

テスト用の小さなファイルは `test/fixtures/` にあります。GeoParquet 2.0 のファイル（`geo2/`、apache/parquet-testing ほか、Apache License 2.0）は公開されているものを写し、
辞書のファイル（`dictionary/`）は `uv run test/fixtures/make_dictionary.py` で作ります。

開発では COGP 公式サンプル（OSM 由来の POI、約 2.2GB）を `data/` に置いて使います。
`data/` は Git 管理外です。

```sh
mkdir -p data
# 既に手元にある場合はハードリンク（ディスクを消費しない）
ln /path/to/pois.cogp.parquet data/pois.cogp.parquet
# 無い場合はダウンロード
curl -o data/pois.cogp.parquet https://cogp-demo.spatialty.io/v1.0.0/pois.cogp.parquet
```

開発サーバーでは、ヘッダーの「dev サンプル」ボタンで `data/pois.cogp.parquet` を URL（HTTP Range Request）として開けます。
開発サーバーが `data/` を Range 付きで配信します（`vite.config.ts`）。

公開版（GitHub Pages）からは、公式サンプルの配信サーバーの CORS 設定により URL で直接開けません。
ダウンロードしたファイルを「ローカルファイルを開く」で読み込んでください（ファイル全体をメモリには読みません）。

## ライセンス

コードのライセンスは未定です。同梱サンプル（`samples/`）のデータは © OpenStreetMap contributors（ODbL）です。
