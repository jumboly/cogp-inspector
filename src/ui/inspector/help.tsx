import type { Selection } from '../../state/store'

/** 教材として、選んだ要素が Parquet / GeoParquet / COGP のどの層の何なのかを 1〜2 文で説明する */
export const HELP: Partial<Record<Selection['kind'], { layer: 'Parquet' | 'GeoParquet' | 'COGP' | 'アクセス'; text: string }>> = {
  file: { layer: 'Parquet', text: 'Parquet は列指向のファイル形式です。データ本体（Row Group）が先頭側に、それを説明するメタデータ（Footer）が末尾にあります。' },
  header: { layer: 'Parquet', text: 'ファイル先頭の 4 バイトは magic "PAR1" です。Parquet であることの目印で、リーダーは通常ここを読みません。' },
  rowGroups: { layer: 'Parquet', text: 'Row Group は行をまとめた単位です。リーダーは Row Group 単位で読むか読まないかを決められます。' },
  rowGroup: { layer: 'Parquet', text: 'Row Group の中身は列ごとの Column Chunk に分かれています。必要な列の Column Chunk だけを読めるのが列指向の利点です。' },
  column: { layer: 'Parquet', text: 'Column Chunk は 1 つの Row Group の 1 列分のデータです。中はさらに Page に分かれ、統計値（最小・最大）が Footer に記録されます。' },
  page: { layer: 'Parquet', text: 'Page は Column Chunk をさらに分けた、読み込み・展開（圧縮解除）の最小単位です。先頭にページヘッダがあり、種類・サイズ・値の数・符号化が書かれています。' },
  pageIndex: { layer: 'Parquet', text: 'Page Index は Page ごとの位置（OffsetIndex）と最小・最大値（ColumnIndex）です。Row Group より細かい単位で読み飛ばせるようになります。' },
  footer: { layer: 'Parquet', text: 'Footer（FileMetaData）には Schema、全 Row Group・Column Chunk の位置と統計値、key-value メタデータが入っています。リーダーは最初にここだけを読み、どこを読むべきかを決めます。' },
  trailer: { layer: 'Parquet', text: '末尾 8 バイトは Footer の長さ（4 バイト）と magic "PAR1" です。リーダーはまずこの 8 バイトを読み、Footer の位置を知ります。' },
  schema: { layer: 'Parquet', text: 'Schema は列の定義です。物理型（physical type）は保存形式、論理型（logical type）はその解釈を表します。' },
  geo: { layer: 'GeoParquet', text: 'GeoParquet は Parquet の key-value メタデータ "geo" に、ジオメトリ列・CRS・bbox covering などの情報を JSON で書く仕様です。' },
  lod: { layer: 'COGP', text: 'COGP は geo メタデータに lod.levels を足し、Row Group を粗い順に並べます。Level N は RG 0 から row_group_end までの先頭部分（prefix）を読むだけで、その解像度に必要な地物がそろいます。' },
  level: { layer: 'COGP', text: 'この Level を表示するには、RG 0 から row_group_end までを読みます。前の Level の Row Group に、この Level の Row Group を足した範囲です。' },
  plan: { layer: 'アクセス', text: '地図の表示範囲と縮尺から、リーダーがどこを読むかを推定します。Level で候補を先頭の一部に絞り、Row Group とページの bbox で表示範囲外を読み飛ばし、残ったページを Range Request にまとめます。' },
  diagnosis: { layer: 'COGP', text: 'このファイルが Cloud Optimized と言える構造かを、開いたときに読んだ Footer だけから判定します。仕様の必須要件（MUST）・推奨（SHOULD）・仕様外の目安を分けて示し、項目をクリックすると該当する Row Group などを選びます。' },
  reads: { layer: 'アクセス', text: 'ファイルを開いてから実際に読んだバイト範囲の記録です。URL の場合はそれぞれが 1 回の HTTP Range Request です。' },
}

export function Help({ kind }: { kind: Selection['kind'] }) {
  const h = HELP[kind]
  if (!h) return null
  return (
    <p className="help">
      <span className={`layer layer-${h.layer}`}>{h.layer}</span>
      {h.text}
    </p>
  )
}

/** ファイル未選択時に出す、3 つの層の関係の説明（セクション 21） */
export function Overview() {
  return (
    <div className="overview">
      <p>このツールは COGP ファイルを、3 つの層に分けて見せます。</p>
      <dl>
        <dt>
          <span className="layer layer-Parquet">Parquet</span>
        </dt>
        <dd>Row Group（行のまとまり）・Column Chunk（列ごとの塊）・Page・統計値・Footer（末尾のメタデータ）</dd>
        <dt>
          <span className="layer layer-GeoParquet">GeoParquet</span>
        </dt>
        <dd>ジオメトリ列・CRS（座標参照系）・bbox covering（外接矩形の列）を geo メタデータで宣言</dd>
        <dt>
          <span className="layer layer-COGP">COGP</span>
        </dt>
        <dd>Level（詳細度の段階）と resolution。Row Group を粗い順に並べ、先頭から読むほど細かくなる</dd>
      </dl>
      <p className="muted">ファイルを開くと、最初に読むのは末尾の Footer だけです。どこを読んだかは下の Physical File Map に表示されます。</p>
    </div>
  )
}
