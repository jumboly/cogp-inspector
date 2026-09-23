# 自作の小さなサンプル（COGP 版と通常 GeoParquet 版）を生成する

## なぜ検討が必要か
公式サンプル（2.2GB）は GitHub Pages に同梱できず（1 ファイル 100MB 上限）、配信サーバーの CORS 設定により公開版から URL で開けない見込み。
公開版ですぐ試せるサンプル、比較機能（通常 GeoParquet vs COGP）の材料、自動テストの fixture（テスト用の固定データ）が必要になる。

## 現在わかっていること
- cogp-rs（参照実装、Rust）で任意の GeoParquet を COGP に変換できる
- 同じデータを COGP 化しない版も用意すれば、同じ表示範囲で読む量を比較できる

## 未決事項
- 元データ（公式サンプルから一部を切り出すか、別のオープンデータか）とライセンス表記
- サイズ（Pages に置けて、かつ Level・Row Group が複数できる規模）
- 生成手順をスクリプト化してリポジトリに置くか

## 結論
Phase 3 段階 E で対応済み（design.md D43・D45、§3.4 の実装メモ（段階 E））。公式サンプルから東京 23 区付近（152,127 行）を切り出し、元の順 / Hilbert 順 / COGP の 3 種類（各約 12MB）を `scripts/make_samples.py` で生成して `samples/` に置いた。公開版は GitHub Pages ではなく Cloudflare R2 から配信する（Pages の gzip 配信で Range が壊れるため。design.md §3.4「公開後の修正」）。ライセンスは元データ（OpenStreetMap、ODbL）の表記を README とサンプルの説明に書いた。
