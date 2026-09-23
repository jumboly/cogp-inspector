# Dictionary の値と Data Page の index の対応表示

## なぜ検討が必要か
辞書エンコーディング（Dictionary Encoding）で「値の一覧＋番号の列」に分けて格納している様子を見せると、列指向形式が小さくなる理由が伝わる。

## 現在わかっていること
- 公式サンプルでは id・tags 列が RLE_DICTIONARY（例: id の辞書ページは 8,103 件）
- hyparquet には辞書値を単独で返す公開 API がない（内部の readPage / decompressPage を使う必要がある）

## 未決事項
- 大量の辞書値の表示方法（サンプル表示・ページング）
- RLE / Bit-Packing でエンコードされた index 列のデコードを自作するか

## 結論
design.md §3.6（D53〜D60）で対応済み。ページの Inspector のボタンでそのページと辞書ページだけを読み、RLE / Bit-Packing の hybrid decoder を自作して区切り・level・index・辞書の値の対応を見せる。
