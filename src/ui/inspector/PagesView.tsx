import type { Inspection } from '../../inspect'
import type { ColumnChunkModel } from '../../parquet/model'
import type { ColumnIndexModel } from '../../parquet/pageIndex'
import type { ChunkPages, PageModel } from '../../parquet/pages'
import { chunkKey, useStore } from '../../state/store'
import { formatBytes, formatNumber, formatPercent, formatRange, formatValue } from '../../util/format'
import { KV } from '../common/KV'

const size = (r: { start: number; end: number }) => r.end - r.start

/** 選択中の Column Chunk のページ一覧（読み込み状態も含めて返す） */
export function useChunkPages(rg: number, col: number) {
  return useStore((s) => s.chunkPages[chunkKey(rg, col)])
}

const LOCATED_BY = {
  'offset-index': 'OffsetIndex から（各ページの位置が直接分かる。ヘッダは種類・値の数を見るために読んだ）',
  'header-walk': 'ページヘッダを先頭から順にたどって（OffsetIndex が無いため、1 つ読まないと次の位置が分からない）',
} as const

function pageLabel(p: PageModel) {
  return p.kind === 'dictionary' ? '辞書' : (p.header?.type ?? 'DATA')
}

/** Column Chunk の中身をページ単位で並べる。ColumnIndex があれば各ページの最小・最大も並べる */
export function ChunkPagesSection({ ins, chunk }: { ins: Inspection; chunk: ColumnChunkModel }) {
  const state = useChunkPages(chunk.rowGroup, chunk.column.index)
  const select = useStore((s) => s.select)
  const ci = useStore((s) => s.pageCache?.columnIndex(chunk))
  if (!state || state.status === 'loading') return <p className="muted">ページを読み込み中…（Page Index とページヘッダだけを読みます）</p>
  if (state.status === 'error') return <p className="warn">ページを読めませんでした: {state.error}</p>
  const { pages, dictionary, locatedBy } = state.data
  const data = pages.filter((p) => p.kind === 'data')
  const headerBytes = pages.reduce((a, p) => a + (p.header?.headerSize ?? 0), 0)
  const encodings = [...new Set(data.map((p) => p.header?.encoding).filter(Boolean))]
  return (
    <>
      <h4>Page</h4>
      <KV
        rows={[
          ['ページ数', `${formatNumber(data.length)}${dictionary ? ' + 辞書ページ 1' : ''}`],
          ['位置の求め方', locatedBy === 'offset-index' ? 'OffsetIndex' : 'ヘッダを順にたどる', LOCATED_BY[locatedBy]],
          ['ページヘッダの合計', `${formatBytes(headerBytes)}（Column Chunk の ${formatPercent(headerBytes, chunk.compressedSize)}）`],
          ['データページの符号化', encodings.join(', ') || '-', encodings.includes('RLE_DICTIONARY') || encodings.includes('PLAIN_DICTIONARY') ? '辞書の番号（index）を並べている' : undefined],
          ['ColumnIndex', ci ? `あり（boundary_order ${ci.boundaryOrder}）` : 'なし', ci ? 'ページごとの最小・最大。ページ単位の読み飛ばしに使える' : 'ページ単位の読み飛ばしには使えない列'],
        ]}
      />
      {dictionary && <DictionarySummary page={dictionary} chunk={chunk} />}
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>種類</th>
            <th>先頭行</th>
            <th>行数</th>
            <th>値の数</th>
            <th>サイズ</th>
            {ci && <th>min / max（ColumnIndex）</th>}
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => {
            const li = p.locationIndex
            return (
              <tr key={p.index} className="clickable" onClick={() => select({ kind: 'page', rg: chunk.rowGroup, col: chunk.column.index, page: p.index }, 'inspector')}>
                <td>{p.index}</td>
                <td>{pageLabel(p)}</td>
                <td>{p.firstRow !== undefined ? formatNumber(p.firstRow) : '-'}</td>
                <td>{p.rowCount !== undefined ? formatNumber(p.rowCount) : '-'}</td>
                <td>{p.header?.numValues !== undefined ? formatNumber(p.header.numValues) : '-'}</td>
                <td>{formatBytes(size(p.range))}</td>
                {ci && <td className="mono">{li === undefined ? '-' : ci.nullPages[li] ? 'すべて null' : `${formatValue(ci.min[li])} / ${formatValue(ci.max[li])}`}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
      {ins.file.rowGroups[chunk.rowGroup].numRows !== chunk.numValues && <p className="muted">値の数と行数が違うのは、繰り返し（リスト）列で 1 行に複数の値があるためです。</p>}
    </>
  )
}

function DictionarySummary({ page, chunk }: { page: PageModel; chunk: ColumnChunkModel }) {
  const h = page.header
  return (
    <div className="dict-box">
      <strong>辞書ページ（Dictionary Page）</strong>
      <div>
        {h?.numValues !== undefined ? `${formatNumber(h.numValues)} 種類の値` : '件数不明'} / {formatBytes(size(page.range))}（Column Chunk の {formatPercent(size(page.range), chunk.compressedSize)}）
      </div>
      <div className="muted">
        Column Chunk に出てくる値を 1 回ずつ並べた表です。データページには値そのものではなく、この表の番号（index）が入ります。
        データページを 1 つでも読むなら、この辞書ページも読む必要があります。
      </div>
    </div>
  )
}

export function PageView({ ins, rg, col, page }: { ins: Inspection; rg: number; col: number; page: number }) {
  const state = useChunkPages(rg, col)
  const chunk = ins.file.rowGroups[rg].columns[col]
  const ci = useStore((s) => s.pageCache?.columnIndex(chunk))
  if (!state || state.status !== 'ready') return <p className="muted">読み込み中…</p>
  const p = state.data.pages[page]
  if (!p) return null
  return <PageDetail chunk={chunk} pages={state.data} p={p} ci={ci} />
}

function PageDetail({ chunk, pages, p, ci }: { chunk: ColumnChunkModel; pages: ChunkPages; p: PageModel; ci?: ColumnIndexModel }) {
  const h = p.header
  const li = p.locationIndex
  return (
    <>
      <h3>
        Page #{p.index} <span className="muted">{pageLabel(p)}</span>
      </h3>
      <p className="muted">
        Row Group {chunk.rowGroup} / <span className="mono">{chunk.column.name}</span>（全 {pages.pages.length} ページ）
      </p>
      <KV
        rows={[
          ['ファイル内の範囲', formatRange(p.range), 'ヘッダを含む'],
          ['ページヘッダ', h ? `${h.headerSize} B` : '-', 'Thrift Compact Protocol。種類・サイズ・値の数・符号化が書かれている'],
          ['本体（圧縮後）compressed_page_size', h ? formatBytes(h.compressedSize) : '-', 'ヘッダを含まない'],
          ['本体（非圧縮）uncompressed_page_size', h ? `${formatBytes(h.uncompressedSize)}（圧縮率 ${formatPercent(h.compressedSize, h.uncompressedSize)}）` : '-'],
          ['値の数 num_values', h?.numValues !== undefined ? formatNumber(h.numValues) : '-', p.kind === 'dictionary' ? '辞書に入っている値の種類数' : undefined],
          ['符号化 encoding', h?.encoding ?? '-'],
          ['先頭行 / 行数', p.firstRow !== undefined ? `${formatNumber(p.firstRow)} / ${formatNumber(p.rowCount ?? NaN)}` : '-', p.firstRow !== undefined ? 'Row Group 内の行番号（OffsetIndex の first_row_index）' : '辞書ページや、OffsetIndex が無い v1 ページでは分からない'],
          ...(h?.type === 'DATA_PAGE_V2' ? ([['null の数 / 行数（v2）', `${formatNumber(h.numNulls ?? NaN)} / ${formatNumber(h.numRows ?? NaN)}`], ['is_compressed', String(h.isCompressed)]] as [string, string, string?][]) : []),
          ...(h?.type === 'DICTIONARY_PAGE' ? ([['is_sorted', h.isSorted === undefined ? '-' : String(h.isSorted), '辞書の値が並べ替え済みか']] as [string, string, string?][]) : []),
          ['ページ単位の Statistics', h?.hasStatistics ? 'あり' : 'なし', 'ヘッダ内の統計値。読み飛ばしの判断には、ページを読む前に分かる ColumnIndex を使う'],
          ['ColumnIndex の min / max', li !== undefined && ci ? (ci.nullPages[li] ? 'すべて null' : `${formatValue(ci.min[li])} / ${formatValue(ci.max[li])}`) : '-'],
          ['CRC', h?.crc !== undefined ? String(h.crc) : 'なし'],
        ]}
      />
    </>
  )
}
