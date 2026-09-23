import { readRleBitPackedHybrid } from 'hyparquet/src/encoding.js'
import { describe, expect, it } from 'vitest'
import { bitWidthOf, decodeHybrid } from '../src/parquet/hybrid'

/** テスト用の encoder。run の区切りを自分で決められるように、[種類, 値] の並びから組み立てる */
function encode(bitWidth: number, runs: ({ rle: number; count: number } | { packed: number[] })[]): Uint8Array {
  const out: number[] = []
  const varint = (v: number) => {
    while (v >= 0x80) {
      out.push((v % 128) | 0x80)
      v = Math.floor(v / 128)
    }
    out.push(v)
  }
  for (const r of runs) {
    if ('rle' in r) {
      varint(r.count * 2)
      for (let i = 0; i < (bitWidth + 7) >> 3; i++) out.push(Math.floor(r.rle / 2 ** (8 * i)) & 0xff)
    } else {
      const groups = Math.ceil(r.packed.length / 8)
      varint(groups * 2 + 1)
      const bytes = new Array<number>(groups * bitWidth).fill(0)
      r.packed.forEach((v, i) => {
        for (let b = 0; b < bitWidth; b++) {
          const bit = i * bitWidth + b
          if (Math.floor(v / 2 ** b) % 2) bytes[bit >> 3] |= 1 << (bit & 7)
        }
      })
      out.push(...bytes)
    }
  }
  return Uint8Array.from(out)
}

function hyparquet(bytes: Uint8Array, bitWidth: number, n: number): number[] {
  const out = new Array<number>(n)
  readRleBitPackedHybrid({ view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 }, bitWidth, out, bytes.length)
  return out
}

describe('RLE / Bit-Packing hybrid decoder（D54）', () => {
  it('RLE と Bit-Packing の区切りを、位置・バイト数・値の数と一緒に返す', () => {
    // 3 を 100 回（ヘッダ 200 = 2 バイトの varint + 値 1 バイト）→ 8 値のかたまり 1 つ（ヘッダ 1 + 3 ビット × 8 = 3 バイト）
    const bytes = encode(3, [{ rle: 3, count: 100 }, { packed: [0, 1, 2, 3, 4, 5, 6, 7] }])
    const r = decodeHybrid(bytes, 0, bytes.length, 3, 108)
    expect(r.values).toEqual([...new Array(100).fill(3), 0, 1, 2, 3, 4, 5, 6, 7])
    expect(r.runs).toEqual([
      { kind: 'rle', offset: 0, headerSize: 2, byteLength: 3, count: 100, encodedCount: 100, firstValue: 0, value: 3 },
      { kind: 'bit-packed', offset: 3, headerSize: 1, byteLength: 4, count: 8, encodedCount: 8, firstValue: 100 },
    ])
    expect(r.end).toBe(bytes.length)
  })

  it('末尾の Bit-Packing の詰め物は値に含めない', () => {
    const bytes = encode(5, [{ packed: [1, 2, 3] }])
    const r = decodeHybrid(bytes, 0, bytes.length, 5, 3)
    expect(r.values).toEqual([1, 2, 3])
    expect(r.runs[0]).toMatchObject({ count: 3, encodedCount: 8 })
  })

  it('32 ビットの値も符号なしで読む', () => {
    const bytes = encode(32, [{ rle: 0xfffffffe, count: 2 }, { packed: [0xffffffff, 1] }])
    expect(decodeHybrid(bytes, 0, bytes.length, 32, 4).values).toEqual([0xfffffffe, 0xfffffffe, 0xffffffff, 1])
  })

  it('データが足りなければ理由付きで止まる', () => {
    const bytes = encode(4, [{ rle: 1, count: 5 }])
    expect(() => decodeHybrid(bytes, 0, bytes.length, 4, 6)).toThrow(/5 \/ 6/)
  })

  it('ランダムな並びで hyparquet の readRleBitPackedHybrid と値が一致する', () => {
    // 乱数の種を固定して、失敗したときに同じ入力で再現できるようにする
    let seed = 1
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (const bitWidth of [1, 2, 7, 8, 9, 13, 16, 17, 24]) {
      for (let t = 0; t < 20; t++) {
        const runs: Parameters<typeof encode>[1] = []
        const expected: number[] = []
        const max = 2 ** bitWidth
        for (let k = 0; k < 1 + rand(10); k++) {
          if (rand(2)) {
            const count = 1 + rand(300)
            const v = rand(max)
            runs.push({ rle: v, count })
            expected.push(...new Array(count).fill(v))
          } else {
            // 途中の Bit-Packing は 8 の倍数でないと詰め物が値に混ざるので、8 の倍数にそろえる
            const packed = Array.from({ length: 8 * (1 + rand(10)) }, () => rand(max))
            runs.push({ packed })
            expected.push(...packed)
          }
        }
        const bytes = encode(bitWidth, runs)
        const mine = decodeHybrid(bytes, 0, bytes.length, bitWidth, expected.length)
        expect(mine.values).toEqual(expected)
        expect(mine.values).toEqual(hyparquet(bytes, bitWidth, expected.length))
        expect(mine.runs.length).toBe(runs.length)
        expect(mine.runs.reduce((a, r) => a + r.byteLength, 0)).toBe(bytes.length)
      }
    }
  })

  it('bit width は最大値を表すのに要るビット数', () => {
    expect([0, 1, 2, 3, 4, 255, 256, 46750].map(bitWidthOf)).toEqual([0, 1, 2, 2, 3, 8, 9, 16])
  })
})
