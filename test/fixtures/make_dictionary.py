# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow>=21"]
# ///
"""辞書の表示（design.md D53〜D59）のテスト用 fixture を作る。

公開サンプルは DATA_PAGE（v1）だけで、辞書から PLAIN への切り替え（fallback）も起きないため、
その 2 つを含む小さなファイルを作る。乱数の種を固定して、作り直しても同じ中身になるようにする。

    uv run test/fixtures/make_dictionary.py
"""
import random
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

OUT = Path(__file__).parent / "dictionary"
rng = random.Random(1)
KEYS = ["name", "amenity", "shop", "brand", "opening_hours", "wheelchair"]
N = 3000


def rows():
    for i in range(N):
        # 1 割は tags が null、1 割は空の map にして、def level の違いを出す
        r = rng.random()
        tags = None if r < 0.1 else [] if r < 0.2 else [(k, rng.choice(["yes", "no", None])) for k in rng.sample(KEYS, rng.randint(1, 4))]
        yield {"id": None if i % 7 == 0 else i * 13, "kind": rng.choice(["cafe", "bank", "school"]), "tags": tags, "label": f"label-{i:05d}-{'x' * 40}"}


def main():
    OUT.mkdir(exist_ok=True)
    schema = pa.schema([("id", pa.int64()), ("kind", pa.string()), ("tags", pa.map_(pa.string(), pa.string())), ("label", pa.string())])
    table = pa.Table.from_pylist(list(rows()), schema=schema)
    # v2 のデータページ: level が圧縮されずにページ本体の先頭に置かれる形を確かめる
    pq.write_table(table, OUT / "v2.parquet", data_page_version="2.0", compression="zstd", data_page_size=4096, write_page_index=True, row_group_size=N)
    # 辞書の上限を小さくして、label 列（すべて違う値）を途中で PLAIN に切り替えさせる
    pq.write_table(table, OUT / "fallback.parquet", compression="zstd", data_page_size=4096, dictionary_pagesize_limit=8192, write_page_index=True, row_group_size=N)


if __name__ == "__main__":
    main()
