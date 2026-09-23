# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow==25.0.1", "numpy"]
# ///
"""比較用サンプル 3 種類を作る（design.md D43）。

公式サンプル（全世界の POI、COGP）から東京 23 区付近を切り出し、次の 3 つを public/samples/ に書く。

1. tokyo-id.parquet       元の順（id 順）の通常 GeoParquet
2. tokyo-hilbert.parquet  Hilbert 順の通常 GeoParquet
3. tokyo.cogp.parquet     1. を cogp（参照実装 CLI）で変換した COGP

1 と 2 の差で「空間的にまとめる」効果、2 と 3 の差で「Level がある」効果を分けて見るため、
行・列・圧縮・Row Group の大きさ・ページの大きさ・Page Index の有無をそろえる。

使い方:
    uv run scripts/make_samples.py --source data/pois.cogp.parquet --cogp /path/to/cogp

cogp は https://github.com/Kanahiro/cloud-optimized-geoparquet/releases/tag/v1.0.0 の
バイナリ（または同タグの cogp-rs をビルドしたもの）を使う。
"""

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

# 東京 23 区付近。約 15 万行で、各ファイルが 20MB（D43 の目安）に収まる大きさ
REGION = (139.56, 35.52, 139.92, 35.82)

# 公式サンプル（65,536 行）より小さくする。約 15 万行を 65,536 行で切ると通常 GeoParquet が
# 3 個の Row Group にしかならず、Row Group 単位の読み飛ばしの差が見えないため
ROW_GROUP_SIZE = 8192
# Row Group の中を 8 ページに分け、Page Index による絞り込みの差も見えるようにする
PAGE_ROW_COUNT = 1024

# cogp（parquet-rs）の書き方に合わせる: ZSTD レベル 3、geometry と bbox は辞書を使わない
COMPRESSION = "zstd"
COMPRESSION_LEVEL = 3
DICTIONARY_COLUMNS = ["id", "tags"]

HILBERT_ORDER = 16


def read_region(source: Path) -> pa.Table:
    pf = pq.ParquetFile(source)
    x0, y0, x1, y1 = REGION
    parts = []
    # 全列を一度に読むと 2GB 超を展開するので、Row Group 統計で範囲外を飛ばしてから読む
    bbox_idx = {pf.metadata.row_group(0).column(i).path_in_schema: i for i in range(pf.metadata.num_columns)}
    for rg in range(pf.metadata.num_row_groups):
        meta = pf.metadata.row_group(rg)
        st = {k: meta.column(i).statistics for k, i in bbox_idx.items() if k.startswith("bbox.")}
        if st["bbox.xmin"].min > x1 or st["bbox.xmax"].max < x0 or st["bbox.ymin"].min > y1 or st["bbox.ymax"].max < y0:
            continue
        t = pf.read_row_group(rg)
        b = t.column("bbox")
        mask = pc.and_(
            pc.and_(pc.less_equal(pc.struct_field(b, "xmin"), x1), pc.greater_equal(pc.struct_field(b, "xmax"), x0)),
            pc.and_(pc.less_equal(pc.struct_field(b, "ymin"), y1), pc.greater_equal(pc.struct_field(b, "ymax"), y0)),
        )
        parts.append(t.filter(mask))
    return pa.concat_tables(parts)


def hilbert_index(x: np.ndarray, y: np.ndarray, order: int) -> np.ndarray:
    """(x, y) ∈ [0, 2^order) の整数格子上の Hilbert 曲線の番号（古典的な xy2d をベクトル化）"""
    x = x.astype(np.int64).copy()
    y = y.astype(np.int64).copy()
    d = np.zeros_like(x)
    full = (1 << order) - 1
    s = 1 << (order - 1)
    while s > 0:
        rx = ((x & s) > 0).astype(np.int64)
        ry = ((y & s) > 0).astype(np.int64)
        d += s * s * ((3 * rx) ^ ry)
        # 象限ごとに向きをそろえる回転。ry == 0 の象限だけが対象
        flip = (ry == 0) & (rx == 1)
        x = np.where(flip, full - x, x)
        y = np.where(flip, full - y, y)
        swap = ry == 0
        x, y = np.where(swap, y, x), np.where(swap, x, y)
        s >>= 1
    return d


def geo_metadata(table: pa.Table) -> dict:
    b = table.column("bbox")
    return {
        "version": "1.1.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                "geometry_types": ["Point"],
                "bbox": [
                    pc.min(pc.struct_field(b, "xmin")).as_py(),
                    pc.min(pc.struct_field(b, "ymin")).as_py(),
                    pc.max(pc.struct_field(b, "xmax")).as_py(),
                    pc.max(pc.struct_field(b, "ymax")).as_py(),
                ],
                "covering": {
                    "bbox": {k: ["bbox", k] for k in ("xmin", "ymin", "xmax", "ymax")},
                },
            }
        },
    }


def write_geoparquet(table: pa.Table, path: Path) -> None:
    with pq.ParquetWriter(
        path,
        table.schema,
        compression=COMPRESSION,
        compression_level=COMPRESSION_LEVEL,
        use_dictionary=DICTIONARY_COLUMNS,
        write_statistics=True,
        write_page_index=True,
        max_rows_per_page=PAGE_ROW_COUNT,
        # 行数でページを切るため、バイト数の上限では先に切れないよう大きくする
        data_page_size=64 * 1024 * 1024,
        # ARROW:schema を埋めると Footer が膨らみ、COGP との Footer の大きさの比較がずれる
        store_schema=False,
    ) as w:
        w.write_table(table, row_group_size=ROW_GROUP_SIZE)
        # store_schema=False ではスキーマのメタデータも書かれないので、geo は直接足す
        w.add_key_value_metadata({"geo": json.dumps(geo_metadata(table))})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=Path("data/pois.cogp.parquet"))
    ap.add_argument("--cogp", type=Path, required=True, help="cogp v1.0.0 の CLI")
    ap.add_argument("--out", type=Path, default=Path("public/samples"))
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    table = read_region(args.source)
    # 「元の順」は id 順とする。OSM の id は登録順で、場所とはほぼ無関係に並ぶ
    table = table.sort_by("id")
    print(f"rows: {table.num_rows}")

    id_path = args.out / "tokyo-id.parquet"
    write_geoparquet(table, id_path)

    b = table.column("bbox")
    cx = (pc.struct_field(b, "xmin").to_numpy() + pc.struct_field(b, "xmax").to_numpy()) / 2
    cy = (pc.struct_field(b, "ymin").to_numpy() + pc.struct_field(b, "ymax").to_numpy()) / 2
    n = (1 << HILBERT_ORDER) - 1
    x0, y0, x1, y1 = REGION
    hx = np.clip((cx - x0) / (x1 - x0) * n, 0, n)
    hy = np.clip((cy - y0) / (y1 - y0) * n, 0, n)
    # 同じ Hilbert 番号の行は id 順に並べ、実行ごとに結果が変わらないようにする
    order = np.lexsort((table.column("id").to_numpy(), hilbert_index(hx, hy, HILBERT_ORDER)))
    write_geoparquet(table.take(order), args.out / "tokyo-hilbert.parquet")

    subprocess.run(
        [
            str(args.cogp),
            "convert",
            str(id_path),
            str(args.out / "tokyo.cogp.parquet"),
            "--row-group-size",
            str(ROW_GROUP_SIZE),
            "--page-row-count",
            str(PAGE_ROW_COUNT),
        ],
        check=True,
    )
    subprocess.run([str(args.cogp), "validate", str(args.out / "tokyo.cogp.parquet")], check=True)

    for p in sorted(args.out.glob("*.parquet")):
        md = pq.ParquetFile(p).metadata
        print(f"{p.name}: {p.stat().st_size:,} B, {md.num_row_groups} RG, {md.num_rows} rows")


if __name__ == "__main__":
    main()
