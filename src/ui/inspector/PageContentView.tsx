import { useMemo, useState } from 'react'
import { hasDictionary, isDictionaryEncoded, type BodySection, type DataPageContent, type DictionaryContent, type PageContent } from '../../data/pageContent'
import type { HybridRun } from '../../parquet/hybrid'
import type { ChunkPages, PageModel } from '../../parquet/pages'
import { pageKey, useStore } from '../../state/store'
import { formatBytes, formatNumber, formatPercent } from '../../util/format'
import { KV } from '../common/KV'

// 4 万件を超える辞書もあるので、表は一度に 100 行だけ描く（design.md D57）
const PAGE_SIZE = 100

const size = (r: { start: number; end: number }) => r.end - r.start

/** ページの Inspector に置く「中身を読む」と、その結果（辞書の値・level・index の対応）。design.md D53〜D59 */
export function PageContentSection({ rg, col, pages, p }: { rg: number; col: number; pages: ChunkPages; p: PageModel }) {
  const state = useStore((s) => s.pageContents[pageKey(rg, col, p.index)])
  const load = useStore((s) => s.loadPageContent)
  const cache = useStore((s) => s.pageCache)
  const dict = pages.dictionary
  if (!isDictionaryEncoded(p)) {
    // fallback は読まなくてもヘッダの符号化で分かる（D58）
    if (!dict) return null
    return (
      <div className="dict-box">
        <strong>このページは辞書を使っていません（{p.header?.encoding ?? '?'}）</strong>
        <div className="muted">
          この Column Chunk には辞書ページがありますが、このページは値をそのまま並べています。
          辞書が大きくなりすぎると、writer は途中のページから辞書をやめて PLAIN などに切り替えます（fallback）。
        </div>
      </div>
    )
  }
  // 辞書ページを読み済みなら、次のページからはデータページの分だけ読む（D53）
  const bytes = size(p.range) + (dict && dict !== p && !(cache && hasDictionary(cache, rg, col)) ? size(dict.range) : 0)
  if (!state) {
    return (
      <div className="content-load">
        <button onClick={() => load(rg, col, p.index)}>中身を読む（{formatBytes(bytes)}）</button>
        <span className="muted">
          {p.kind === 'dictionary' ? '辞書ページを読んで、値の一覧を出します。' : 'このページと辞書ページだけを読み、index と辞書の値の対応を出します。'}
          読んだ範囲は Range 記録に残ります。
        </span>
      </div>
    )
  }
  if (state.status === 'loading') return <p className="muted">ページの中身を読み込み中…</p>
  if (state.status === 'error') return <p className="warn">ページの中身を読めませんでした: {state.error}</p>
  return <ContentView content={state.data} />
}

function ContentView({ content }: { content: PageContent }) {
  if (content.kind === 'not-dictionary') return null
  if (content.kind === 'dictionary') {
    return (
      <>
        <h4>辞書の値</h4>
        <KV rows={[['件数', formatNumber(content.dictionary.values.length)], ['展開後のサイズ', formatBytes(content.dictionary.bodySize), '値を PLAIN で並べたもの（BYTE_ARRAY は長さ 4 バイト + 中身）']]} />
        <DictionaryTable dict={content.dictionary} />
      </>
    )
  }
  return <DataContentView dict={content.dictionary} data={content.data} />
}

/** 値の表・辞書の表で強調しているもの。辞書の番号か、区切り（run）が覆う値の範囲 */
type Focus = { kind: 'index'; index: number } | { kind: 'run'; section: BodySection['kind']; run: HybridRun } | null

function DataContentView({ dict, data }: { dict: DictionaryContent; data: DataPageContent }) {
  const [focus, setFocus] = useState<Focus>(null)
  const nonNull = data.entries.filter((e) => e.index !== undefined).length
  const counts = useMemo(() => {
    const m = new Map<number, number>()
    for (const e of data.entries) if (e.index !== undefined) m.set(e.index, (m.get(e.index) ?? 0) + 1)
    return m
  }, [data])
  // index の区切りは「null でない値の何番目か」で数えるので、値の表の位置（pos）に戻す対応表
  const posOfNonNull = useMemo(() => data.entries.filter((e) => e.index !== undefined).map((e) => e.pos), [data])
  const rows = new Set(data.entries.map((e) => e.row)).size
  const dictShare = formatPercent(dict.bodySize, dict.bodySize + data.bodySize)
  return (
    <>
      <h4>ページの中身</h4>
      <KV
        rows={[
          ['値の数', `${formatNumber(data.entries.length)}（null でない値 ${formatNumber(nonNull)}・${formatNumber(rows)} 行）`, data.maxRep > 0 ? '入れ子の列なので、1 行に複数の値が入る' : undefined],
          ['辞書の件数', formatNumber(dict.values.length), `このページで使った値は ${formatNumber(counts.size)} 種類`],
          ['index の bit width', `${data.bitWidth} ビット`, `1 つの index を ${data.bitWidth} ビットで表す。ページ本体の先頭 1 バイトに書かれている（多くの writer は、そのページを書いた時点の辞書の件数から決める）`],
          ['level の最大値', `rep ${data.maxRep} / def ${data.maxDef}`, data.maxDef > 0 ? 'def level が最大値より小さい値は null（または空のリスト）で、index を持たない' : undefined],
        ]}
      />
      <h4>辞書で小さくなったか</h4>
      <p className="muted">どちらも圧縮する前のバイト数で比べます。</p>
      <table className="table compare">
        <tbody>
          <tr>
            <td>同じ値を PLAIN で書いた場合</td>
            <td className="mono">{formatBytes(data.plainBytes)}</td>
          </tr>
          <tr>
            <td>辞書の index（このページ）</td>
            <td className="mono">
              {formatBytes(data.indexBytes)}（PLAIN の {formatPercent(data.indexBytes, data.plainBytes)}）
            </td>
          </tr>
          <tr>
            <td>辞書ページ（Column Chunk の全ページで共有）</td>
            <td className="mono">{formatBytes(dict.bodySize)}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        辞書ページはこの Column Chunk のどのページを読むときにも必要です。このページだけを読むなら、読む量の {dictShare} が辞書ページです。
        {data.indexBytes >= data.plainBytes / 2 && ' このページでは同じ値がほとんど繰り返されないので、辞書があまり効いていません。'}
      </p>
      <h4>ページ本体の内訳（展開後 {formatBytes(data.bodySize)}）</h4>
      <BodyStrip data={data} focus={focus} setFocus={setFocus} />
      <ValueTable dict={dict} data={data} focus={focus} setFocus={setFocus} posOfNonNull={posOfNonNull} />
      <h4>辞書</h4>
      <DictionaryTable dict={dict} counts={counts} focus={focus} setFocus={setFocus} />
    </>
  )
}

const SECTION_LABEL: Record<BodySection['kind'], string> = {
  length: '長さ（4 B）',
  rep: 'rep level',
  def: 'def level',
  'bit-width': 'bit width（1 B）',
  index: 'index',
}

/** ページ本体を区切りごとに並べた帯（D59）。RLE と Bit-Packing を色で分け、クリックでその区切りの値を強調する */
function BodyStrip({ data, focus, setFocus }: { data: DataPageContent; focus: Focus; setFocus: (f: Focus) => void }) {
  const total = data.bodySize || 1
  const pct = (n: number) => `${(n / total) * 100}%`
  return (
    <>
      <div className="body-strip">
        {data.sections.map((s, i) => (
          <div key={i} className={`body-sec body-sec-${s.kind}`} style={{ left: pct(s.start), width: pct(size(s)) }} title={`${SECTION_LABEL[s.kind]} ${formatBytes(size(s))}`}>
            {s.runs?.map((r, j) => (
              <span
                key={j}
                className={`body-run body-run-${r.kind}${focus?.kind === 'run' && focus.run === r ? ' active' : ''}`}
                style={{ left: `${((r.offset - s.start) / (size(s) || 1)) * 100}%`, width: `${(r.byteLength / (size(s) || 1)) * 100}%` }}
                title={`${SECTION_LABEL[s.kind]}: ${runLabel(r)}`}
                onClick={() => setFocus({ kind: 'run', section: s.kind, run: r })}
              />
            ))}
          </div>
        ))}
      </div>
      <table className="table compare">
        <tbody>
          {(['rep', 'def', 'index'] as const).map((k) => {
            const secs = data.sections.filter((s) => s.kind === k)
            if (!secs.length) return null
            const runs = secs.flatMap((s) => s.runs ?? [])
            const rle = runs.filter((r) => r.kind === 'rle')
            return (
              <tr key={k}>
                <td>
                  <span className={`legend-box body-sec-${k}`} /> {SECTION_LABEL[k]}
                </td>
                <td className="mono">{formatBytes(secs.reduce((a, s) => a + size(s), 0))}</td>
                <td>
                  区切り {formatNumber(runs.length)}（RLE {formatNumber(rle.length)}・{formatNumber(rle.reduce((a, r) => a + r.count, 0))} 値 / Bit-Packing {formatNumber(runs.length - rle.length)}）
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="muted">
        濃い色は RLE（同じ値の繰り返しを「回数 + 値」の数バイトで書く）、薄い色は Bit-Packing（8 値ずつ bit width ビットに詰める）。区切りをクリックすると、その区切りの値を下の表で強調します。
        {data.sections.some((s) => s.kind === 'length') && ' v1 のページでは、level の前に長さ 4 バイトが付きます。'}
      </p>
      {focus?.kind === 'run' && (
        <p>
          選択中: {SECTION_LABEL[focus.section]} の {runLabel(focus.run)}{' '}
          <button onClick={() => setFocus(null)}>解除</button>
        </p>
      )}
    </>
  )
}

function runLabel(r: HybridRun): string {
  const base = `${r.kind === 'rle' ? 'RLE' : 'Bit-Packing'}・位置 ${formatNumber(r.offset)}・${r.byteLength} B（ヘッダ ${r.headerSize} B）・${formatNumber(r.count)} 値`
  if (r.kind === 'rle') return `${base}（値 ${r.value} を繰り返す）`
  return r.encodedCount > r.count ? `${base}（末尾の ${r.encodedCount - r.count} 値は詰め物）` : base
}

/** 強調する値の位置（pos）の範囲。index の区切りは null でない値の順番なので、pos に直す */
function focusedPositions(focus: Focus, posOfNonNull: number[]): { from: number; to: number } | undefined {
  if (focus?.kind !== 'run') return undefined
  const { firstValue, count } = focus.run
  if (count === 0) return undefined
  if (focus.section === 'index') return { from: posOfNonNull[firstValue], to: posOfNonNull[firstValue + count - 1] }
  return { from: firstValue, to: firstValue + count - 1 }
}

function ValueTable({ dict, data, focus, setFocus, posOfNonNull }: { dict: DictionaryContent; data: DataPageContent; focus: Focus; setFocus: (f: Focus) => void; posOfNonNull: number[] }) {
  const range = focusedPositions(focus, posOfNonNull)
  // 強調したものが別のページ送りの位置にあれば、そこへ移る
  const target = range?.from ?? (focus?.kind === 'index' ? data.entries.find((e) => e.index === focus.index)?.pos : undefined)
  const [page, setPage] = usePager(data.entries.length, target)
  const shown = data.entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const hit = (pos: number, index?: number) => (range ? pos >= range.from && pos <= range.to : focus?.kind === 'index' && index === focus.index)
  const hits = focus?.kind === 'index' ? data.entries.filter((e) => e.index === focus.index).length : undefined
  return (
    <>
      <h4>値の並び</h4>
      {hits !== undefined && (
        <p>
          index {focus?.kind === 'index' && focus.index} はこのページに {formatNumber(hits)} 回出てきます <button onClick={() => setFocus(null)}>解除</button>
        </p>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>{data.rowsAbsolute ? '行' : '行（ページ内）'}</th>
            {data.maxRep > 0 && <th>rep</th>}
            {data.maxDef > 0 && <th>def</th>}
            <th>index</th>
            <th>値</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((e) => (
            <tr key={e.pos} className={`clickable${hit(e.pos, e.index) ? ' active' : ''}${e.rep === 0 && e.pos > 0 ? ' row-start' : ''}`} onClick={() => e.index !== undefined && setFocus({ kind: 'index', index: e.index })}>
              <td>{e.pos}</td>
              <td>{formatNumber(e.row)}</td>
              {data.maxRep > 0 && <td className="mono">{e.rep}</td>}
              {data.maxDef > 0 && <td className="mono">{e.def}</td>}
              <td className="mono">{e.index ?? '-'}</td>
              <td className="mono ellipsis value-cell">{e.index === undefined ? <span className="muted">null</span> : formatDictValue(dict.values[e.index])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} setPage={setPage} total={data.entries.length} />
      {data.maxRep > 0 && <p className="muted">rep level が 0 の値から新しい行が始まります（線で区切っています）。1 以上なら、前の値と同じ行の続きです。</p>}
    </>
  )
}

function DictionaryTable({ dict, counts, focus, setFocus }: { dict: DictionaryContent; counts?: Map<number, number>; focus?: Focus; setFocus?: (f: Focus) => void }) {
  const [onlyUsed, setOnlyUsed] = useState(true)
  // データページから開いたときは、このページで使った値を多い順に（D56）。辞書ページから開いたときは辞書の順
  const order = useMemo(() => {
    if (counts && onlyUsed) return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([i]) => i)
    return dict.values.map((_, i) => i)
  }, [dict, counts, onlyUsed])
  const focusIndex = focus?.kind === 'index' ? focus.index : undefined
  const target = focusIndex === undefined ? undefined : order.indexOf(focusIndex)
  const [page, setPage] = usePager(order.length, target === -1 ? undefined : target)
  return (
    <>
      {counts && (
        <label className="data-toggle">
          <input type="checkbox" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} /> このページで使った値だけ（多い順）
        </label>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>index</th>
            <th>値</th>
            {counts && <th>このページでの回数</th>}
            <th>PLAIN のサイズ</th>
          </tr>
        </thead>
        <tbody>
          {order.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((i) => (
            <tr key={i} className={`${setFocus ? 'clickable' : ''}${focusIndex === i ? ' active' : ''}`} onClick={() => setFocus?.({ kind: 'index', index: i })}>
              <td className="mono">{i}</td>
              <td className="mono ellipsis value-cell">{formatDictValue(dict.values[i])}</td>
              {counts && <td>{formatNumber(counts.get(i) ?? 0)}</td>}
              <td>{dict.plainSizes[i]} B</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={page} setPage={setPage} total={order.length} />
    </>
  )
}

/** ページ送りの位置。target（強調した行の位置）が変わったら、その行を含むところへ移る */
function usePager(total: number, target?: number): [number, (p: number) => void] {
  const [page, setPage] = useState(0)
  const [lastTarget, setLastTarget] = useState<number | undefined>(undefined)
  // 描画中に state を直すのは React の「前の値と比べて調整する」書き方。effect で直すと 1 回古い位置で描いてしまう
  if (target !== lastTarget) {
    setLastTarget(target)
    if (target !== undefined) setPage(Math.floor(target / PAGE_SIZE))
  }
  const max = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)
  return [Math.min(page, max), setPage]
}

function Pager({ page, setPage, total }: { page: number; setPage: (p: number) => void; total: number }) {
  const pages = Math.ceil(total / PAGE_SIZE)
  if (pages <= 1) return null
  return (
    <div className="pager">
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>
        前へ
      </button>
      <span className="muted">
        {formatNumber(page * PAGE_SIZE + 1)}〜{formatNumber(Math.min(total, (page + 1) * PAGE_SIZE))} / {formatNumber(total)}
      </span>
      <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
        次へ
      </button>
    </div>
  )
}

function formatDictValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Uint8Array) return `${v.length} B のバイト列`
  return String(v)
}
