import { openSync, readSync, fstatSync } from 'node:fs'
import type { RandomAccessSource } from '../src/io/source'

/** テスト用: Node の fs で必要範囲だけ読む（2GB の実ファイルを丸ごと読まないため） */
export function nodeFileSource(path: string): RandomAccessSource {
  const fd = openSync(path, 'r')
  const size = fstatSync(fd).size
  return {
    kind: 'local',
    name: path,
    size,
    async read(offset, length) {
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, offset)
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + length)
    },
  }
}
