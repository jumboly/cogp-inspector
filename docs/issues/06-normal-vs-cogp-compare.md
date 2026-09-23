# 通常 GeoParquet と COGP の比較

## なぜ検討が必要か
同じ表示範囲で「候補 Row Group 数」「読むバイト数」を並べると、COGP がなぜ Cloud Optimized なのかが数値で分かる。

## 現在わかっていること
- 数値は必ず実データか計算結果から出し、固定値や都合のよい例を出さない
- 比較には同じデータを COGP 化した版としない版が必要（issue 01）

## 未決事項
- 比較の単位（1 つの viewport か、ズーム操作の履歴全体か）
- 2 ファイルを同時に開く UI

## 結論
Phase 3 段階 E で対応済み（design.md D44）。Access Plan に「ファイルの比較」を追加し、「比較対象」を 1 つ追加で開いて（Footer と Page Index のみ）、同じ表示範囲の funnel を横に並べる。単位は「現在の表示範囲」と「Simulator ON からの累計」の 2 通り。
