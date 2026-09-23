# Footer 内部をフィールド単位で色分けする（Thrift デコーダ自作）

## なぜ検討が必要か
「Footer のこのバイトが Row Group 2 の num_rows を表す」まで見せられると、教材として Footer の中身が具体的になる。
hyparquet はデコード結果だけを返し、各フィールドのバイト位置を返さない。

## 現在わかっていること
- Thrift Compact Protocol の汎用デコーダは 200〜300 行程度【推測】
- デコード中に各フィールドの開始・終了オフセットを記録すればよい
- PageHeader の長さも同じ仕組みで得られる

## 未決事項
- hyparquet のデコーダを置き換えるか、表示用にだけ並行して使うか
- 数百 KB の Footer をどう描画するか（仮想スクロール等）

## 結論
（未定）MVP では hyparquet を使い（design.md D3）、MVP 後に検討する。
