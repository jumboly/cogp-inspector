import { levelOfRowGroup } from '../../cogp/lod'
import { sameCrs, type CrsInfo } from '../../geo/crs'
import { wkbTypeName } from '../../geo/geometryTypes'
import type { Inspection } from '../../inspect'
import type { ColumnChunkModel } from '../../parquet/model'
import { useStore, type Selection } from '../../state/store'
import { levelColor } from '../../util/color'
import { formatBytes, formatNumber, formatPercent, formatRange, formatValue, toJsonText } from '../../util/format'
import { KV, RawJson } from '../common/KV'
import { columnRole, ROLE_LABEL } from './columnRole'
import { Help, Overview } from './help'
import { LevelPrefix } from './LevelPrefix'
import { AccessPlanView } from './AccessPlanView'
import { DiagnosisView } from './DiagnosisView'
import { PageBboxSection } from './PageBboxView'
import { ChunkPagesSection, PageView } from './PagesView'
import { ReadsView } from './ReadsView'

const size = (r: { start: number; end: number }) => r.end - r.start

/**
 * hyparquet は BYTE_ARRAY の統計値を文字列として返すが、WKB などのバイナリ列では文字化けするだけなので長さだけ示す。
 * 文字列として解釈できる論理型（STRING など）のときだけ中身を表示する。
 */
function statText(c: ColumnChunkModel, v: unknown): string {
  const textual = ['STRING', 'JSON', 'ENUM', 'UTF8'].includes(c.column.logicalType ?? c.column.convertedType ?? '')
  if (c.column.physicalType === 'BYTE_ARRAY' && !textual && typeof v === 'string') return `<バイナリ ${v.length} bytes>`
  return formatValue(v)
}
const BBOX_SOURCE = {
  'covering-stats': 'bbox covering 列の Row Group 統計（最小・最大）',
  'geospatial-stats': 'Parquet の geospatial_statistics',
  none: '統計なし',
} as const

export function Inspector() {
  const inspection = useStore((s) => s.inspection)
  const selection = useStore((s) => s.selection)
  if (!inspection || !selection) return <Overview />
  return (
    <div className="inspector">
      <Help kind={selection.kind} />
      <Body sel={selection} ins={inspection} />
    </div>
  )
}

function Body({ sel, ins }: { sel: Selection; ins: Inspection }) {
  const { file, geo, lod } = ins
  switch (sel.kind) {
    case 'file': {
      const dataBytes = file.rowGroups.reduce((a, r) => a + r.compressedSize, 0)
      return (
        <>
          <h3>File</h3>
          <KV
            rows={[
              ['種別', lod ? (lod.valid ? 'COGP' : 'COGP（lod が仕様違反）') : geo ? 'GeoParquet' : 'Parquet'],
              ['サイズ', `${formatBytes(file.size)}（${formatNumber(file.size)} B）`],
              ['行数 num_rows', formatNumber(file.numRows)],
              ['Row Group 数', formatNumber(file.rowGroups.length)],
              ['列数（葉）', file.leafColumns.length],
              ['format version', file.version],
              ['created_by', file.createdBy ?? '-', '書き出したライブラリ'],
              ['データ本体', `${formatBytes(dataBytes)}（${formatPercent(dataBytes, file.size)}）`],
              ['Page Index', file.pageIndex ? `${formatBytes(size(file.pageIndex))}（${formatPercent(size(file.pageIndex), file.size)}）` : 'なし'],
              ['Footer', `${formatBytes(size(file.footer))}（${formatPercent(size(file.footer), file.size)}）`],
            ]}
          />
          <h4>key-value メタデータ</h4>
          <KV rows={file.keyValue.map((kv) => [kv.key, `${formatNumber(kv.value?.length ?? 0)} 文字`])} />
        </>
      )
    }
    case 'header':
      return <KV rows={[['範囲', formatRange(file.headerMagic)], ['サイズ', '4 B']]} />
    case 'trailer':
      return (
        <KV
          rows={[
            ['範囲', formatRange(file.trailer)],
            ['内容', `Footer 長 = ${formatNumber(size(file.footer))} B（4 B, little endian）+ "PAR1"`],
            ['読み方', 'ファイルサイズ − 8 から 8 バイトを読む → Footer の開始位置 = サイズ − 8 − Footer 長'],
          ]}
        />
      )
    case 'footer':
      return (
        <KV
          rows={[
            ['範囲', formatRange(file.footer)],
            ['サイズ', `${formatBytes(size(file.footer))}（ファイルの ${formatPercent(size(file.footer), file.size)}）`],
            ['符号化', 'Thrift Compact Protocol'],
            ['含むもの', `Schema ${file.leafColumns.length} 列、Row Group ${file.rowGroups.length} 個 × Column Chunk ${file.leafColumns.length} 個の位置と統計値、key-value ${file.keyValue.length} 件`],
          ]}
        />
      )
    case 'schema':
      return (
        <table className="table">
          <thead>
            <tr>
              <th>列</th>
              <th>physical</th>
              <th>logical / converted</th>
              <th>repetition</th>
              <th>役割</th>
            </tr>
          </thead>
          <tbody>
            {file.leafColumns.map((c) => {
              const role = columnRole(c, geo)
              return (
                <tr key={c.index}>
                  <td className="mono">{c.name}</td>
                  <td>{c.physicalType}</td>
                  <td>{c.logicalType ?? c.convertedType ?? '-'}</td>
                  <td>{c.repetition ?? '-'}</td>
                  <td>
                    <span className={`role role-${role}`}>{ROLE_LABEL[role]}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )
    case 'geo':
      return geo ? <GeoView ins={ins} /> : null
    case 'lod':
      return lod ? <LodView ins={ins} /> : null
    case 'level':
      return <LevelView ins={ins} level={sel.level} />
    case 'rowGroups':
      return <KV rows={[['Row Group 数', formatNumber(file.rowGroups.length)], ['1 個あたりの行数', rangeOf(file.rowGroups.map((r) => r.numRows))], ['1 個あたりの圧縮後サイズ', rangeOf(file.rowGroups.map((r) => r.compressedSize), formatBytes)]]} />
    case 'rowGroup':
      return <RowGroupView ins={ins} rg={sel.rg} />
    case 'column':
      return <ColumnView ins={ins} chunk={file.rowGroups[sel.rg].columns[sel.col]} />
    case 'page':
      return <PageView ins={ins} rg={sel.rg} col={sel.col} page={sel.page} />
    case 'pageIndex': {
      const chunks = file.rowGroups.flatMap((r) => r.columns)
      const ci = chunks.filter((c) => c.columnIndex)
      const oi = chunks.filter((c) => c.offsetIndex)
      const cols = [...new Set(ci.map((c) => c.column.name))]
      return (
        <KV
          rows={[
            ['範囲', formatRange(file.pageIndex!)],
            ['サイズ', formatBytes(size(file.pageIndex!))],
            ['OffsetIndex', `${formatNumber(oi.length)} / ${formatNumber(chunks.length)} Column Chunk`, 'Page ごとの位置・サイズ・先頭行番号'],
            ['ColumnIndex', `${formatNumber(ci.length)} / ${formatNumber(chunks.length)} Column Chunk`, 'Page ごとの最小・最大値'],
            ['ColumnIndex のある列', cols.join(', ') || '-'],
            ['読み方', 'ファイルを開いた時点では読みません。Column Chunk を選ぶと、その Chunk の分だけを読みます'],
          ]}
        />
      )
    }
    case 'reads':
      return <ReadsView fileSize={file.size} selectedId={sel.id} />
    case 'plan':
      return <AccessPlanView ins={ins} />
    case 'diagnosis':
      return <DiagnosisView />
  }
}

function rangeOf(values: number[], f: (n: number) => string = formatNumber) {
  return `${f(Math.min(...values))} 〜 ${f(Math.max(...values))}`
}

function GeoView({ ins }: { ins: Inspection }) {
  const geo = ins.geo!
  return (
    <>
      {geo.hasGeo ? (
        <KV rows={[['version', geo.version ?? '-'], ['primary_column', geo.primaryColumn ?? '-', '主ジオメトリ列']]} />
      ) : (
        <>
          <p className="muted">
            geo メタデータがありません。Parquet ネイティブの GEOMETRY / GEOGRAPHY 論理型の列だけを持つファイルです（GeoParquet 2.0 には準拠しませんが、2.0 の reader は読めるとされています）。
            スキーマ上で最初の geometry 列を主ジオメトリ列として扱います。
          </p>
          <KV rows={[['主ジオメトリ列', geo.primaryColumn ?? '-', 'geo が無いので、スキーマ上で最初の geometry 列']]} />
        </>
      )}
      {geo.problems.length > 0 && (
        <ul className="problems">
          {geo.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {geo.columns.map((c) => (
        <section key={c.name}>
          <h4>
            列 <span className="mono">{c.name}</span>
          </h4>
          <KV
            rows={[
              ['論理型', c.logical ? `${c.logical.type}${c.logical.algorithm ? `（algorithm ${c.logical.algorithm}）` : ''}` : 'なし', c.logical ? 'Parquet ネイティブの型（GeoParquet 2.0）' : '通常の BYTE_ARRAY 列（GeoParquet 1.x の書き方）'],
              ['encoding', c.encoding ?? '-', c.inGeo ? '保存形式（WKB など）' : '論理型の値は WKB と決まっている'],
              ['geometry_types', c.inGeo ? c.geometryTypes.join(', ') || '（指定なし＝任意）' : '-（geo に無い列）'],
              ['使う CRS', c.crs.label, `${c.logical ? '論理型の crs が正（GeoParquet 2.0）' : 'geo の crs'}。${c.crs.mapProjection ? '地図に表示できます' : 'この CRS は地図表示に未対応です（構造解析のみ）'}`],
              ...(c.logical ? [['論理型の crs', c.logical.crsText ?? '（省略＝OGC:CRS84）', '書かれている文字列']] as [string, string, string][] : []),
              ...(c.logical && c.geoCrs ? [['geo の crs', c.geoCrs.label, sameCrsNote(c.logical.crs, c.geoCrs)]] as [string, string, string][] : []),
              ['座標の単位', c.crs.unit, 'COGP の resolution はこの単位'],
              ['edges', c.edges ?? (c.inGeo ? 'planar（既定）' : '-（geo に無い列）')],
              ['bbox', c.bbox ? c.bbox.map((v) => v.toFixed(4)).join(', ') : '-', 'ファイル全体の範囲'],
              ['covering.bbox', c.covering ? `${c.covering.xmin.join('.')}, ${c.covering.ymin.join('.')}, ${c.covering.xmax.join('.')}, ${c.covering.ymax.join('.')}` : 'なし', '外接矩形を別の列に持たせ、その統計値で空間の絞り込みをする仕組み'],
            ]}
          />
          {c.crs.raw !== undefined && <RawJson summary="CRS（PROJJSON）" text={toJsonText(c.crs.raw)} />}
        </section>
      ))}
      {geo.hasGeo && <RawJson text={toJsonText(geo.raw)} />}
    </>
  )
}

function sameCrsNote(logical: CrsInfo, geoCrs: CrsInfo): string {
  const same = sameCrs(logical, geoCrs)
  if (same === undefined) return '識別子が無いので、論理型の crs と同じかを確かめられません'
  return same ? '論理型の crs と同じ CRS' : '論理型の crs と食い違っています（仕様では同じ CRS を表す MUST。表示には論理型を使う）'
}

function LodView({ ins }: { ins: Inspection }) {
  const lod = ins.lod!
  const select = useStore((s) => s.select)
  const unit = ins.geo?.primary?.crs.unit ?? '座標単位'
  return (
    <>
      <KV rows={[['Level 数', lod.levels.length], ['検証（MUST 要件）', lod.valid ? '適合' : `${lod.violations.length} 件の違反`]]} />
      {!lod.valid && (
        <>
          <p className="warn">仕様では、違反のある lod を Level 選択（prefix 選択）に使ってはいけません。</p>
          <ul className="problems">
            {lod.violations.map((v, i) => (
              <li key={i}>
                <strong>{v.rule}</strong>：{v.detail}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>prefix 構造</h4>
      <LevelPrefix lod={lod} rowGroupCount={ins.file.rowGroups.length} />
      <table className="table">
        <thead>
          <tr>
            <th>Level</th>
            <th>resolution（{unit}）</th>
            <th>読む RG</th>
            <th>新規 RG</th>
            <th>読む量</th>
          </tr>
        </thead>
        <tbody>
          {lod.levels.map((l) => (
            <tr key={l.level} className="clickable" onClick={() => select({ kind: 'level', level: l.level }, 'inspector')}>
              <td>
                <span className="swatch" style={{ background: levelColor(l.level, lod.levels.length) }} /> {l.level}
              </td>
              <td className="mono">{l.resolution.toPrecision(4)}</td>
              <td>0–{l.rowGroupEnd}</td>
              <td>{l.newFrom <= l.rowGroupEnd ? `${l.newFrom}–${l.rowGroupEnd}` : '-'}</td>
              <td>{formatPercent(l.prefixCompressedBytes, ins.file.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <RawJson text={toJsonText(lod.raw)} />
    </>
  )
}

function LevelView({ ins, level }: { ins: Inspection; level: number }) {
  const lod = ins.lod!
  const l = lod.levels[level]
  const unit = ins.geo?.primary?.crs.unit ?? '座標単位'
  const setViewLevel = useStore((s) => s.setViewLevel)
  return (
    <>
      <h3>
        <span className="swatch" style={{ background: levelColor(level, lod.levels.length) }} /> Level {level}
      </h3>
      <KV
        rows={[
          ['resolution', `${l.resolution}`, `単位: ${unit}。この Level が想定する表示の細かさ`],
          ['row_group_end', l.rowGroupEnd, 'この値を含む'],
          ['読む Row Group', `RG 0–${l.rowGroupEnd}（${l.rowGroupEnd + 1} 個）`],
          ['この Level で増える Row Group', l.newFrom <= l.rowGroupEnd ? `RG ${l.newFrom}–${l.rowGroupEnd}（${l.rowGroupEnd - l.newFrom + 1} 個）` : 'なし'],
          ['読む行数', `${formatNumber(l.prefixRows)}（全体の ${formatPercent(l.prefixRows, ins.file.numRows)}）`],
          ['増える行数', formatNumber(l.newRows)],
          ['読む量（全列）', `${formatBytes(l.prefixCompressedBytes)}（ファイルの ${formatPercent(l.prefixCompressedBytes, ins.file.size)}）`, '表示範囲による Row Group の絞り込みをする前の上限'],
        ]}
      />
      <button onClick={() => setViewLevel(level)}>地図でこの Level を表示</button>
      <h4>prefix 構造</h4>
      <LevelPrefix lod={lod} rowGroupCount={ins.file.rowGroups.length} highlight={level} />
    </>
  )
}

function RowGroupView({ ins, rg }: { ins: Inspection; rg: number }) {
  const r = ins.file.rowGroups[rg]
  const b = ins.rowGroupBboxes[rg]
  const lv = levelOfRowGroup(ins.lod, rg)
  const select = useStore((s) => s.select)
  return (
    <>
      <h3>
        {lv !== undefined && <span className="swatch" style={{ background: levelColor(lv, ins.lod!.levels.length) }} />} Row Group {rg}
      </h3>
      <KV
        rows={[
          ['COGP Level', lv ?? '-', lv !== undefined ? `Level ${lv} 以降の表示で読まれる` : undefined],
          ['行数', formatNumber(r.numRows), `ファイル全体の行番号 ${formatNumber(r.firstRow)}〜${formatNumber(r.firstRow + r.numRows - 1)}`],
          ['bbox', b.bbox ? b.bbox.map((v) => v.toFixed(5)).join(', ') : '不明', BBOX_SOURCE[b.source] + (b.note ? `（${b.note}）` : '')],
          ['圧縮後サイズ', `${formatBytes(r.compressedSize)}（ファイルの ${formatPercent(r.compressedSize, ins.file.size)}）`],
          ['非圧縮サイズ total_byte_size', formatBytes(r.totalByteSize)],
          ['ファイル内の範囲', formatRange(r.range)],
        ]}
      />
      <h4>Column Chunk</h4>
      <ChunkTable ins={ins} chunks={r.columns} onSelect={(ci) => select({ kind: 'column', rg, col: ci }, 'inspector')} />
      <PageBboxSection ins={ins} rg={rg} />
    </>
  )
}

function ChunkTable({ ins, chunks, onSelect }: { ins: Inspection; chunks: ColumnChunkModel[]; onSelect: (ci: number) => void }) {
  const total = chunks.reduce((a, c) => a + c.compressedSize, 0)
  return (
    <table className="table">
      <thead>
        <tr>
          <th>列</th>
          <th>codec</th>
          <th>辞書</th>
          <th>圧縮後</th>
          <th>割合</th>
          <th>min / max</th>
        </tr>
      </thead>
      <tbody>
        {chunks.map((c, ci) => {
          const role = columnRole(c.column, ins.geo)
          return (
            <tr key={ci} className={`clickable row-${role}`} onClick={() => onSelect(ci)}>
              <td className="mono" title={ROLE_LABEL[role]}>
                {c.column.name}
              </td>
              <td>{c.codec}</td>
              <td>{c.hasDictionary ? 'あり' : '-'}</td>
              <td>{formatBytes(c.compressedSize)}</td>
              <td>{formatPercent(c.compressedSize, total)}</td>
              <td className="mono">{c.stats ? `${statText(c, c.stats.min)} / ${statText(c, c.stats.max)}` : '-'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// GEOMETRY / GEOGRAPHY 列の通常の min/max はソート順が決まっておらず、reader は無視する MUST（design.md D50）
const GEO_MINMAX_NOTE = 'GEOMETRY / GEOGRAPHY 列の min/max は仕様上 reader が無視するので、判定に使わない'

/** Parquet ネイティブの geospatial_statistics（GeoParquet 2.0 の Row Group 単位の bbox と型） */
function geoStatRows(c: ColumnChunkModel): [string, string, string?][] {
  if (!c.column.geoLogical) return []
  const g = c.raw.meta_data?.geospatial_statistics
  if (!g) return [['geospatial_statistics', 'なし', 'Row Group 単位の bbox が無いので、この列の統計では読み飛ばせない']]
  const b = g.bbox
  const f = (v: number | undefined) => (v === undefined ? '-' : formatValue(v))
  return [
    ['geospatial bbox', b ? `x ${f(b.xmin)} 〜 ${f(b.xmax)}、y ${f(b.ymin)} 〜 ${f(b.ymax)}` : 'なし', b && b.xmin > b.xmax ? '日付変更線をまたぐ（xmin > xmax）' : 'Row Group の bbox に使う'],
    ...(b && (b.zmin !== undefined || b.mmin !== undefined)
      ? ([['geospatial bbox（z / m）', `z ${f(b.zmin)} 〜 ${f(b.zmax)}、m ${f(b.mmin)} 〜 ${f(b.mmax)}`]] as [string, string][])
      : []),
    ['geospatial_types', g.geospatial_types?.length ? g.geospatial_types.map(wkbTypeName).join(', ') : '（空＝不明）', 'ISO WKB の型番号を名前にしたもの'],
  ]
}

function ColumnView({ ins, chunk: c }: { ins: Inspection; chunk: ColumnChunkModel }) {
  const role = columnRole(c.column, ins.geo)
  const geoLogical = c.column.geoLogical
  return (
    <>
      <h3>
        <span className="mono">{c.column.name}</span> <span className={`role role-${role}`}>{ROLE_LABEL[role]}</span>
      </h3>
      <p className="muted">Row Group {c.rowGroup} の Column Chunk</p>
      <KV
        rows={[
          ['physical type', c.column.physicalType, '保存上の型'],
          ['logical type', c.column.logicalType ?? c.column.convertedType ?? '-', '値の解釈'],
          ['codec', c.codec, '圧縮方式'],
          ['encodings', c.encodings.join(', '), '符号化方式'],
          ['辞書（Dictionary）', c.hasDictionary ? `あり（dictionary_page_offset ${formatNumber(c.dictionaryPageOffset ?? NaN)}）` : 'なし'],
          ['値の数 num_values', formatNumber(c.numValues)],
          ['圧縮後サイズ', formatBytes(c.compressedSize), 'Page ヘッダを含む'],
          ['非圧縮サイズ', `${formatBytes(c.uncompressedSize)}（圧縮率 ${formatPercent(c.compressedSize, c.uncompressedSize)}）`],
          ['ファイル内の範囲', formatRange(c.range)],
          ['data_page_offset', formatNumber(c.dataPageOffset), '最初のデータ Page の位置'],
          ['統計 min', c.stats ? statText(c, c.stats.min) : '-', geoLogical ? GEO_MINMAX_NOTE : c.stats?.fromDeprecated ? '非推奨の min から取得' : c.stats?.minExact === false ? '正確な値ではない（切り詰め）' : undefined],
          ['統計 max', c.stats ? statText(c, c.stats.max) : '-', geoLogical ? GEO_MINMAX_NOTE : undefined],
          ...geoStatRows(c),
          ['null の数', c.stats?.nullCount !== undefined ? formatNumber(c.stats.nullCount) : '-'],
          ['ColumnIndex', c.columnIndex ? `${formatRange(c.columnIndex)}（${formatBytes(size(c.columnIndex))}）` : 'なし'],
          ['OffsetIndex', c.offsetIndex ? `${formatRange(c.offsetIndex)}（${formatBytes(size(c.offsetIndex))}）` : 'なし'],
          ['file_offset', formatNumber(Number(c.raw.file_offset)), '非推奨：実装によって指す先が違うため使わない'],
        ]}
      />
      <ChunkPagesSection ins={ins} chunk={c} />
      <RawJson summary="Raw ColumnChunk（Thrift をデコードしたもの）" text={toJsonText(c.raw)} />
    </>
  )
}
