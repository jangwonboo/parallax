"""Generate a small synthetic .parallax book for reader smoke checks."""
import argparse
import base64
import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "src/shared/schema-contract.json").read_text(encoding="utf-8"))
DB_SOURCE = (ROOT / "src/main/db.ts").read_text(encoding="utf-8")
DDL = re.search(r"const DDL = `([\s\S]*?)`;", DB_SOURCE).group(1)
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/"
    "lXcAAAAASUVORK5CYII="
)


def make(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError(path)
    with sqlite3.connect(path) as db:
        db.executescript(DDL)
        db.execute(
            "INSERT INTO doc(id,title,source_kind,pages,schema_version) VALUES (?,?,?,?,?)",
            ("fixture", "Reader smoke fixture", "pdf", 1, SCHEMA["schemaVersion"]),
        )
        blocks = [
            ("heading", 1024, 1, "h1", "Sample chapter", "시험 장", 0),
            ("text", 2048, 1, "p", "A formula $x^2+y^2=z^2$ and a figure.", "수식과 그림.", 0),
            ("formula", 3072, 1, "equation", "$$E=mc^2$$", None, 16),
            ("picture", 4096, 1, "figure", "sample-asset", None, 16),
            ("caption", 5120, 1, "figcaption", "Figure 1. A pixel.", "그림 1. 픽셀.", 0),
        ]
        db.executemany(
            "INSERT INTO block(id,ord,page,type,src,ko,flags) VALUES (?,?,?,?,?,?,?)", blocks
        )
        db.execute(
            "INSERT INTO asset(id,mime,w,h,alt,wfrac,data) VALUES (?,?,?,?,?,?,?)",
            ("sample-asset", "image/png", 1, 1, "pixel", 0.2, PNG),
        )
        db.execute(
            "INSERT INTO highlight(id,group_id,block_id,side,start_off,end_off,text,created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            ("highlight", "group", "text", "src", 2, 9, "formula", 1),
        )
        db.execute(
            "CREATE TABLE bookmark (id TEXT PRIMARY KEY, block_id TEXT UNIQUE, created_at INTEGER)"
        )
        db.execute("INSERT INTO bookmark VALUES (?,?,?)", ("bookmark", "formula", 1))
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    print(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "work/reader-smoke.parallax")
    make(parser.parse_args().out)
