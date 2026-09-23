import { parseLod, type LodModel } from './cogp/lod'
import { rowGroupBboxes, type RowGroupBbox } from './geo/bbox'
import { parseGeoMetadata, type GeoModel } from './geo/geoMetadata'
import type { RandomAccessSource } from './io/source'
import { readFooter } from './parquet/footer'
import { buildFileModel, type FileModel } from './parquet/model'

export interface Inspection {
  file: FileModel
  geo?: GeoModel
  lod?: LodModel
  rowGroupBboxes: RowGroupBbox[]
}

/**
 * ファイルを開いたときの初期処理。読むのは Footer（と末尾 8 バイト）だけで、データ本体には触れない。
 * 以降の段階（Level 選択、Row Group の絞り込み…）は、ここで得たメタデータだけから計算できる。
 */
export async function inspect(source: RandomAccessSource): Promise<Inspection> {
  const footer = await readFooter(source)
  const file = buildFileModel(source.size, footer)
  const geo = parseGeoMetadata(file.keyValue)
  const lod = parseLod(geo, file)
  return { file, geo, lod, rowGroupBboxes: rowGroupBboxes(file, geo) }
}
