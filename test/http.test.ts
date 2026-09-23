import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceError } from '../src/io/errors'
import { HttpRangeSource } from '../src/io/http'

afterEach(() => vi.unstubAllGlobals())

const head = (headers: Record<string, string>, status = 200) => new Response(null, { status, headers })

describe('HttpRangeSource', () => {
  it('fetch 自体が失敗したら CORS/ネットワークの可能性として報告する', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(HttpRangeSource.open('https://example.com/a.parquet')).rejects.toMatchObject({ kind: 'network-or-cors' })
  })

  it('Content-Length が読めなければ理由を報告する', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(head({})))
    await expect(HttpRangeSource.open('https://example.com/a.parquet')).rejects.toMatchObject({ kind: 'no-content-length' })
  })

  it('Range に 200 が返ったら Range 非対応として報告する', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(head({ 'content-length': '100' })).mockResolvedValueOnce(new Response('x'.repeat(100), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const src = await HttpRangeSource.open('https://example.com/a.parquet')
    const err = await src.read(0, 10).catch((e) => e)
    expect(err).toBeInstanceOf(SourceError)
    expect(err.kind).toBe('range-not-supported')
  })

  it('bytes=N-M 形式の Range を送る（末尾指定はプリフライトを誘発するため使わない）', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(head({ 'content-length': '100' })).mockResolvedValueOnce(new Response(new Uint8Array(8), { status: 206 }))
    vi.stubGlobal('fetch', fetchMock)
    const src = await HttpRangeSource.open('https://example.com/a.parquet')
    await src.read(92, 8)
    expect(fetchMock.mock.calls[1][1].headers.Range).toBe('bytes=92-99')
  })

  it('圧縮して送るサーバー（GitHub Pages の .parquet）は、HEAD の Content-Encoding で見分ける', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(head({ 'content-length': '90', 'content-encoding': 'gzip' })))
    await expect(HttpRangeSource.open('https://example.com/a.parquet')).rejects.toMatchObject({ kind: 'compressed-transfer' })
  })

  it('Range 応答の全体の長さが HEAD のサイズと違えば、圧縮後のバイト列に掛かっているとみなす', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(head({ 'content-length': '100' }))
      .mockResolvedValueOnce(new Response(new Uint8Array(8), { status: 206, headers: { 'content-range': 'bytes 82-89/90' } }))
    vi.stubGlobal('fetch', fetchMock)
    const src = await HttpRangeSource.open('https://example.com/a.parquet')
    await expect(src.read(82, 8)).rejects.toMatchObject({ kind: 'compressed-transfer' })
  })
})
