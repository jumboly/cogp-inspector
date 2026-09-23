import { HttpRangeSource } from './http'
import type { RandomAccessSource, ReadRecord } from './source'

/**
 * すべての read を記録するラッパー。
 * ここで記録したものが「実測（Actual）」で、Physical File Map のハイライトや Range Request 一覧の元になる。
 */
export class TracedSource implements RandomAccessSource {
  readonly kind: RandomAccessSource['kind']
  readonly name: string
  readonly size: number
  private readonly inner: RandomAccessSource
  private readonly onRecord: (record: ReadRecord) => void
  private nextId = 1

  constructor(inner: RandomAccessSource, onRecord: (record: ReadRecord) => void) {
    this.inner = inner
    this.kind = inner.kind
    this.name = inner.name
    this.size = inner.size
    this.onRecord = onRecord
  }

  async read(offset: number, length: number, purpose: string): Promise<ArrayBuffer> {
    const record: ReadRecord = {
      id: this.nextId++,
      offset,
      length,
      purpose,
      startedAt: performance.now(),
      durationMs: 0,
      rangeHeader: this.kind === 'http' ? HttpRangeSource.rangeHeader(offset, length) : undefined,
    }
    try {
      return await this.inner.read(offset, length, purpose)
    } catch (e) {
      record.error = (e as Error).message
      throw e
    } finally {
      record.durationMs = performance.now() - record.startedAt
      this.onRecord(record)
    }
  }
}
