/**
 * RLE / Bit-Packing の混合形式（RLE/Bit-Packing Hybrid）の decoder。design.md D54。
 *
 * hyparquet の readRleBitPackedHybrid は decode した値しか返さないので自作する。
 * 区切り（run）ごとの種類・バイト位置・値の数を残し、「同じ番号が続くと数バイトで済む」ことを見せるため。
 * 形式は parquet-format の Encodings.md に従う:
 *   run の先頭は varint のヘッダ。最下位ビットが 0 なら RLE（ヘッダ >> 1 回、同じ値を繰り返す。値は ceil(bitWidth / 8) バイトのリトルエンディアン）、
 *   1 なら Bit-Packing（ヘッダ >> 1 個の 8 値のかたまり。値は下位ビットから詰める）。
 */

export interface HybridRun {
  kind: 'rle' | 'bit-packed'
  /** run の先頭（ヘッダの位置）。decode したバイト列の中での位置 */
  offset: number
  /** varint のヘッダのバイト数 */
  headerSize: number
  /** ヘッダを含む run 全体のバイト数 */
  byteLength: number
  /** この run から取り出した値の数。Bit-Packing は 8 の倍数で書かれるので、末尾の run は詰め物の分だけ少ない */
  count: number
  /** 書かれている値の数（Bit-Packing は 8 の倍数）。count より多ければ残りは詰め物 */
  encodedCount: number
  /** この run の最初の値が、全体の何番目の値か */
  firstValue: number
  /** RLE の繰り返す値 */
  value?: number
}

export interface HybridResult {
  values: number[]
  runs: HybridRun[]
  /** 最後の run の直後の位置 */
  end: number
}

/**
 * bytes[offset, limit) を bitWidth ビットの値として numValues 個 decode する。
 * numValues に達したら止める（それより後ろのバイトは読まない）。
 */
export function decodeHybrid(bytes: Uint8Array, offset: number, limit: number, bitWidth: number, numValues: number): HybridResult {
  if (bitWidth < 0 || bitWidth > 32) throw new Error(`bit width ${bitWidth} は 0〜32 の範囲外です`)
  const values: number[] = []
  const runs: HybridRun[] = []
  let pos = offset
  while (values.length < numValues) {
    if (pos >= limit) throw new Error(`値が ${values.length} / ${numValues} 件のところでデータが終わりました（位置 ${pos}）`)
    const start = pos
    const { value: header, next } = readVarint(bytes, pos, limit)
    pos = next
    const firstValue = values.length
    if (header % 2 === 0) {
      const encodedCount = Math.floor(header / 2)
      const width = (bitWidth + 7) >> 3
      if (pos + width > limit) throw new Error(`RLE の値が範囲を超えています（位置 ${pos}）`)
      let value = 0
      // 32 ビット目を立てると符号付きになるので、ビット演算ではなく掛け算で組み立てる
      for (let i = 0; i < width; i++) value += bytes[pos + i] * 2 ** (8 * i)
      pos += width
      const count = Math.min(encodedCount, numValues - firstValue)
      for (let i = 0; i < count; i++) values.push(value)
      runs.push({ kind: 'rle', offset: start, headerSize: next - start, byteLength: pos - start, count, encodedCount, firstValue, value })
    } else {
      const encodedCount = Math.floor(header / 2) * 8
      const byteLength = Math.floor(header / 2) * bitWidth
      if (pos + byteLength > limit) throw new Error(`Bit-Packing のかたまりが範囲を超えています（位置 ${pos}、${byteLength} B）`)
      const count = Math.min(encodedCount, numValues - firstValue)
      for (let i = 0; i < count; i++) values.push(readBits(bytes, pos, i * bitWidth, bitWidth))
      pos += byteLength
      runs.push({ kind: 'bit-packed', offset: start, headerSize: next - start, byteLength: pos - start, count, encodedCount, firstValue })
    }
  }
  return { values, runs, end: pos }
}

/** 値を表すのに要るビット数。辞書の件数や level の最大値から bit width を求める */
export function bitWidthOf(maxValue: number): number {
  return maxValue <= 0 ? 0 : Math.floor(Math.log2(maxValue)) + 1
}

function readVarint(bytes: Uint8Array, pos: number, limit: number): { value: number; next: number } {
  let value = 0
  let scale = 1
  for (;;) {
    if (pos >= limit) throw new Error(`run のヘッダ（varint）が途中で切れています（位置 ${pos}）`)
    const b = bytes[pos++]
    value += (b & 0x7f) * scale
    if (!(b & 0x80)) return { value, next: pos }
    scale *= 128
  }
}

/** base から bitOffset ビット目を先頭に、width ビットを下位ビットから読む */
function readBits(bytes: Uint8Array, base: number, bitOffset: number, width: number): number {
  let value = 0
  for (let i = 0; i < width; i++) {
    const bit = bitOffset + i
    if ((bytes[base + (bit >> 3)] >> (bit & 7)) & 1) value += 2 ** i
  }
  return value
}
