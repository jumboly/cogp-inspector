import type { ByteRange } from '../parquet/model'
import type { RandomAccessSource } from './source'

export interface Run<T> {
  range: ByteRange
  members: T[]
}

/**
 * 重なる・隣接する範囲だけを 1 つにまとめる。隙間は埋めない。
 * cogp-js（src/coalescing-buffer.ts）と同じ方針で、転送量を「要求したバイト」だけに保ったままリクエスト数を減らす。
 */
export function coalesce<T>(items: T[], rangeOf: (t: T) => ByteRange): Run<T>[] {
  const sorted = [...items].sort((a, b) => rangeOf(a).start - rangeOf(b).start)
  const runs: Run<T>[] = []
  for (const it of sorted) {
    const r = rangeOf(it)
    const last = runs.at(-1)
    if (last && r.start <= last.range.end) {
      last.range.end = Math.max(last.range.end, r.end)
      last.members.push(it)
    } else {
      runs.push({ range: { ...r }, members: [it] })
    }
  }
  return runs
}

// ブラウザの同一ホストへの同時接続数（HTTP/1.1 で 6）に合わせる
export const READ_CONCURRENCY = 6

export interface RangeRequest {
  range: ByteRange
  purpose: string
}

/**
 * 複数の範囲を合体して読み、要求ごとのバッファに切り分けて返す（戻り値は requests と同じ順）。
 * 合体した read の purpose は「先頭の要求 ほか N 件」にして、Range 記録で何をまとめたかが分かるようにする。
 */
export async function readCoalesced(source: RandomAccessSource, requests: RangeRequest[]): Promise<ArrayBuffer[]> {
  const runs = coalesce(
    requests.map((r, i) => ({ ...r, i })),
    (r) => r.range,
  )
  const out: ArrayBuffer[] = new Array(requests.length)
  await mapLimit(runs, READ_CONCURRENCY, async (run) => {
    const purpose = run.members.length === 1 ? run.members[0].purpose : `${run.members[0].purpose} ほか ${run.members.length - 1} 件（合体）`
    const buf = await source.read(run.range.start, run.range.end - run.range.start, purpose)
    for (const m of run.members) out[m.i] = buf.slice(m.range.start - run.range.start, m.range.end - run.range.start)
  })
  return out
}

/** 同時に投げる read の数を抑えて順に処理する（HTTP でブラウザの同時接続数を使い切らないため） */
export async function mapLimit<T, R>(items: T[], limit: number, f: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await f(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
