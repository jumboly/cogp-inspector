/**
 * Parquet 解析層から見た「ランダムアクセスできるバイト列」。
 * ローカルファイルと HTTP を同じ解析ロジックで扱い、どちらでも「何バイト目を何のために読んだか」を記録するための抽象。
 */
export interface RandomAccessSource {
  readonly kind: 'local' | 'http'
  /** 表示用の名前（ファイル名や URL） */
  readonly name: string
  /** ファイル全体のバイト数 */
  readonly size: number
  /**
   * offset から length バイトを読む。
   * purpose は「なぜ読んだか」のラベルで、Range Request の記録と「推定 vs 実測」の比較に使う。
   * signal は地図を動かしたときに古い実データの読み込みを止めるため（design.md D33）。
   */
  read(offset: number, length: number, purpose: string, signal?: AbortSignal): Promise<ArrayBuffer>
}

export interface ReadRecord {
  id: number
  offset: number
  length: number
  purpose: string
  /** performance.now() 基準の開始時刻 */
  startedAt: number
  durationMs: number
  /** HTTP の場合に実際に送った Range ヘッダ（ローカルでは undefined） */
  rangeHeader?: string
  error?: string
  /** 中断された read（error にも理由が入る） */
  aborted?: boolean
}
