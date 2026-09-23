# EPSG:4326 / 3857 以外の CRS を地図に表示する

## なぜ検討が必要か
MVP では CRS84 / EPSG:4326 / EPSG:3857 以外は構造解析のみで地図表示しない。日本の平面直角座標系など、他の CRS のファイルも扱いたい。

## 現在わかっていること
- proj4js で PROJJSON / EPSG 定義から座標変換できる
- COGP の resolution は CRS の座標単位（m など）なので、zoom との対応の計算も CRS ごとに変わる

## 未決事項
- PROJJSON を proj4js 形式に変換する方法
- 定義が手元に無い EPSG コードの扱い

## 結論
（未定）
