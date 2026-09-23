# 公式サンプルを公開版から URL で開けない（CORS）

## なぜ検討が必要か
公式サンプルの配信サーバー（cogp-demo.spatialty.io）は CORS をオリジン許可制にしており、GitHub Pages（公開先は独自ドメインの https://www.jumboly.jp/cogp-inspector/）からは読めない。

## 現在わかっていること（2026-09-23 に curl で確認）
- `Origin: http://localhost:5173` と `https://kanahiro.github.io` には `access-control-allow-origin` が返る
- 他のオリジンには返らない。公開先と同じ `Origin: https://www.jumboly.jp` でも返らないことを確認済み。OPTIONS プリフライトは 403
- 当面は「ダウンロードしてローカルファイルで開く」案内で回避する（design.md D1）

## 未決事項
- 仕様の作者に許可オリジンの追加を相談するか

## 結論
（未定）
