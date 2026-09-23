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
（未定）
