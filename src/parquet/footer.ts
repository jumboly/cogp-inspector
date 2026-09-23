import { parquetMetadata, type FileMetaData } from 'hyparquet'
import { SourceError } from '../io/errors'
import type { RandomAccessSource } from '../io/source'

/** Parquet ファイル末尾の 8 バイト = footer 長（4B, little endian）+ magic "PAR1" */
const TRAILER_LENGTH = 8
const MAGIC_PAR1 = 0x31524150
const MAGIC_PARE = 0x45524150

export interface FooterRead {
  metadata: FileMetaData
  /** FileMetaData（Thrift）の開始位置 */
  metadataOffset: number
  metadataLength: number
  trailerOffset: number
}

/**
 * Footer を 2 段階で読む。
 *
 * hyparquet の parquetMetadataAsync は「末尾 512KiB をまとめて読む」ことで往復を減らすが、
 * このツールでは「まず末尾 8 バイトで Footer の長さを知り、次にちょうど Footer だけを読む」という
 * Parquet の読み方そのものを見せたいので、往復が 1 回増えても自前で分けて読む。
 */
export async function readFooter(source: RandomAccessSource): Promise<FooterRead> {
  if (source.size < 12) {
    throw new SourceError('not-parquet', `ファイルが小さすぎます（${source.size} バイト）`, 'Parquet ファイルは最低でも先頭と末尾の magic で 12 バイト必要です。')
  }
  const trailerOffset = source.size - TRAILER_LENGTH
  const trailer = new DataView(await source.read(trailerOffset, TRAILER_LENGTH, 'trailer: footer 長と magic'))
  const magic = trailer.getUint32(4, true)
  if (magic === MAGIC_PARE) {
    throw new SourceError('not-parquet', 'Footer が暗号化されています（magic が PARE）', '暗号化された Parquet は未対応です。')
  }
  if (magic !== MAGIC_PAR1) {
    throw new SourceError('not-parquet', '末尾の magic が PAR1 ではありません', 'Parquet ファイルではないか、ファイルが途中で切れています。')
  }
  const metadataLength = trailer.getUint32(0, true)
  const metadataOffset = trailerOffset - metadataLength
  if (metadataOffset < 4) {
    throw new SourceError('not-parquet', `Footer 長 ${metadataLength} がファイルサイズを超えています`, 'ファイルが壊れている可能性があります。')
  }

  // hyparquet の parquetMetadata は「Footer + trailer」で終わるバッファを受け取るので、trailer ごと読む（8 バイトの重複読みは許容）
  const buf = await source.read(metadataOffset, metadataLength + TRAILER_LENGTH, 'footer: FileMetaData')
  // geoparquet: false にするのは、hyparquet が geo メタデータから logical_type を補完するのを止め、
  // ファイルに実際に書かれている Parquet の型だけを見せるため
  const metadata = parquetMetadata(buf, { geoparquet: false })
  return { metadata, metadataOffset, metadataLength, trailerOffset }
}
