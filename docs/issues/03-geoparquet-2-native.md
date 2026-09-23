# GeoParquet 2.0 / Parquet ネイティブ GEOMETRY 型への対応

## なぜ検討が必要か
GeoParquet 2.0（rc.1、2026-07）では Parquet ネイティブの GEOMETRY / GEOGRAPHY 論理型が必須になり、CRS の正は論理型の `crs` プロパティになる。
今後この形式のファイルが増える。

## 現在わかっていること
- `ColumnMetaData.geospatial_statistics.bbox` があれば Row Group bbox に使える（MVP でも covering 列の次に参照する：design.md D4）
- CRS の表記は PROJJSON / `EPSG:4326` / `srid:0` / `projjson:<key>` があり、`geo` 側と両方を見る必要がある
- 日付変更線をまたぐと xmin > xmax になり得る
- hyparquet は geo メタデータから GEOMETRY / GEOGRAPHY の logical_type を付ける機能を持つ

## 未決事項
- 2.0 のサンプルファイルの入手
- `geo` と論理型の CRS が食い違うときの表示

## 結論
design.md §3.5（D46〜D52）で対応済み。geo の無いファイルは論理型から組み立て、CRS は論理型を正として geo と並べて表示し、食い違いは診断で MUST 違反にする。日付変更線をまたぐ bbox は 2 つに分けて判定する。テスト用に apache/parquet-testing ほかの小さなファイルを `test/fixtures/geo2/` に置き、東京の COGP を論理型で書き直した `tokyo.cogp-v2.parquet` をサンプルに加えた。
残り: 日付変更線をまたぐ実ファイルでの確認。
