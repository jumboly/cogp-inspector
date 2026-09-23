/**
 * 開けなかった理由を利用者が判断できるよう、失敗を種類ごとに分ける。
 * ブラウザの fetch は CORS 拒否とネットワーク断を同じ TypeError にしてしまうため、原因の候補も文面に含める。
 */
export type SourceErrorKind =
  | 'network-or-cors'
  | 'http-status'
  | 'no-content-length'
  | 'range-not-supported'
  | 'short-read'
  | 'not-parquet'

export class SourceError extends Error {
  readonly kind: SourceErrorKind
  readonly hint: string

  constructor(kind: SourceErrorKind, message: string, hint: string) {
    super(message)
    this.name = 'SourceError'
    this.kind = kind
    this.hint = hint
  }
}
