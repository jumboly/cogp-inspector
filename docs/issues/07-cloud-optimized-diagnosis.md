# 「Cloud Optimized と言える構造か」の診断

## なぜ検討が必要か
ファイルを開いたときに、COGP として正しいか、読みやすい配置かを一覧で示せるとデバッガとして役立つ。

## 現在わかっていること
- 仕様上の必須要件（MUST）と性能上の推奨（SHOULD）を必ず分けて表示する
  - MUST 例: row_group_end の境界条件、resolution の狭義減少、Row Group が Level 境界をまたがない
  - SHOULD 例: Level 内の空間クラスタリング、先頭 Row Group が小さい、空間統計がある
  - 仕様外の目安: bbox covering・Page Index の有無、Row Group の大きさ
- 詳細は design.md 2.1

## 未決事項
- 「空間的なまとまり」の評価指標（Row Group bbox の重なり率など）

## 結論
（未定）Phase 3。
