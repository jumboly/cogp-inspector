# GeoParquet 2.0 / Parquet ネイティブ GEOMETRY 型のテスト用ファイル

design.md D49 (a)。論理型の crs の表記のばらつき、geo の有無、GEOGRAPHY を小さなファイルで確かめるために置く。

| ファイル | 出典 | 内容 |
|---|---|---|
| `crs-default.parquet` ほか `crs-*.parquet`、`geography-polygons.parquet`、`geospatial.parquet` | [apache/parquet-testing](https://github.com/apache/parquet-testing/tree/master/data/geospatial)（Apache License 2.0） | geo なし。crs は省略・`srid:5070`・`projjson:<key>`・PROJJSON 埋め込み。GEOGRAPHY（SPHERICAL・50 Row Group）、ZM 付き |
| `geoparquet-example.parquet` | [opengeospatial/geoparquet](https://github.com/opengeospatial/geoparquet/tree/main/examples) の `example.parquet`（Apache License 2.0） | geo 2.0.0 と GEOMETRY 論理型の両方を持つ |

`PARQUET-TESTING-README.md` は parquet-testing の説明をそのまま写したもの。
