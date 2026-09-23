import type { RandomAccessSource } from './source'

/**
 * File API の Blob.slice で必要な範囲だけを読む。
 * 2GB を超えるファイルでもメモリに載せるのは読んだ範囲だけになる。
 */
export class LocalBlobSource implements RandomAccessSource {
  readonly kind = 'local'
  readonly name: string
  readonly size: number
  private readonly blob: Blob

  constructor(blob: Blob, name: string) {
    this.blob = blob
    this.name = name
    this.size = blob.size
  }

  async read(offset: number, length: number, _purpose?: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    // Blob の読み込みは途中で止められないので、始める前にだけ確かめる
    signal?.throwIfAborted()
    return this.blob.slice(offset, offset + length).arrayBuffer()
  }
}
