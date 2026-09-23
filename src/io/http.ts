import { SourceError } from './errors'
import type { RandomAccessSource } from './source'

function compressedError(message: string): SourceError {
  return new SourceError(
    'compressed-transfer',
    message,
    'サーバーがファイルを圧縮して送っているため、Range がファイルの位置ではなく圧縮後のバイト列に掛かります（GitHub Pages が .parquet に対してこうなります）。' +
      '圧縮せずに送る配信先（S3、R2 など）に置くか、ダウンロードして「ローカルファイルを開く」で読んでください。',
  )
}

/**
 * Content-Encoding が付いていたら読めない。ブラウザは Accept-Encoding を自動で付け、identity だけを求めることもできない。
 * クロスオリジンでは公開されていないと読めないので、読めたときだけ確かめる
 */
function checkEncoding(res: Response) {
  const enc = res.headers.get('content-encoding')
  if (enc && enc !== 'identity') {
    void res.body?.cancel()
    throw compressedError(`サーバーが Content-Encoding: ${enc} で応答しました`)
  }
}

/**
 * HTTP Range Request で必要な範囲だけを取得する。
 *
 * 末尾指定の `bytes=-N` は使わない。CORS-safelisted（事前確認なしで送れる）なのは `bytes=N-M` 形式だけで、
 * 末尾指定はプリフライト（OPTIONS）を誘発し、それを拒否するサーバーでは読めなくなるため。
 * そのぶん最初に HEAD でファイルサイズを取る。
 */
export class HttpRangeSource implements RandomAccessSource {
  readonly kind = 'http'
  readonly name: string
  readonly size: number
  private readonly url: string

  private constructor(url: string, size: number) {
    this.url = url
    this.name = url
    this.size = size
  }

  static async open(url: string): Promise<HttpRangeSource> {
    let res: Response
    try {
      res = await fetch(url, { method: 'HEAD' })
    } catch (e) {
      throw new SourceError(
        'network-or-cors',
        `${url} に接続できませんでした（${(e as Error).message}）`,
        'サーバーがこのページのオリジンからの読み込みを CORS で許可していないか、ネットワークに接続できません。' +
          'ブラウザの開発者ツールの Console に CORS のエラーが出ていないか確認してください。' +
          'ファイルをダウンロードして「ローカルファイルを開く」で読む方法もあります。',
      )
    }
    if (!res.ok) {
      throw new SourceError('http-status', `HEAD ${url} が ${res.status} ${res.statusText} を返しました`, 'URL が正しいか確認してください。')
    }
    // 圧縮して送るサーバーでは、Content-Length も Range も圧縮後のバイト列を指し、ファイルの位置と合わなくなる
    checkEncoding(res)
    const length = res.headers.get('content-length')
    const size = length === null ? NaN : Number(length)
    if (!Number.isFinite(size) || size <= 0) {
      throw new SourceError(
        'no-content-length',
        'ファイルサイズ（Content-Length）を取得できませんでした',
        'Footer はファイル末尾にあるため、サイズが分からないと読み始められません。' +
          'サーバーが HEAD に Content-Length を返しているか、CORS の Access-Control-Expose-Headers で公開しているか確認してください。',
      )
    }
    return new HttpRangeSource(url, size)
  }

  async read(offset: number, length: number, _purpose?: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const res = await this.fetchRange(offset, length, signal)
    const buf = await res.arrayBuffer()
    if (buf.byteLength !== length) {
      throw new SourceError(
        'short-read',
        `${offset} から ${length} バイトを要求しましたが ${buf.byteLength} バイトしか返りませんでした`,
        'サーバー上のファイルが読み込み中に変わった可能性があります。',
      )
    }
    return buf
  }

  /** 実際に送る Range ヘッダ。記録に残すため公開する */
  static rangeHeader(offset: number, length: number): string {
    return `bytes=${offset}-${offset + length - 1}`
  }

  private async fetchRange(offset: number, length: number, signal?: AbortSignal): Promise<Response> {
    let res: Response
    try {
      res = await fetch(this.url, { headers: { Range: HttpRangeSource.rangeHeader(offset, length) }, signal })
    } catch (e) {
      // 中断は失敗ではないので、CORS の疑いなどの説明を付けずにそのまま返す
      if (signal?.aborted) throw e
      throw new SourceError('network-or-cors', `Range 取得に失敗しました（${(e as Error).message}）`, 'CORS またはネットワークの問題の可能性があります。')
    }
    if (res.status === 200) {
      // 200 はサーバーが Range を無視してファイル全体を返し始めたことを意味する。巨大ファイルで待ち続けないよう即中断する
      void res.body?.cancel()
      throw new SourceError(
        'range-not-supported',
        'サーバーが HTTP Range Request に対応していません（206 ではなく 200 が返りました）',
        'このツールはファイルの一部だけを読む前提のため、Range に対応したサーバー（S3、GCS、多くの CDN など）に置いてください。',
      )
    }
    if (res.status !== 206) {
      throw new SourceError('http-status', `Range 取得で ${res.status} ${res.statusText} が返りました`, 'URL とサーバーの設定を確認してください。')
    }
    checkEncoding(res)
    // HEAD と Range で全体の長さが食い違うなら、Range が別の表現（圧縮後など）に掛かっている。
    // Content-Range はクロスオリジンでは公開されていないと読めないので、読めたときだけ確かめる
    const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]
    if (total !== undefined && Number(total) !== this.size) {
      void res.body?.cancel()
      throw compressedError(`Range 応答の全体の長さ ${total} が、HEAD で得たサイズ ${this.size} と違います`)
    }
    return res
  }
}
