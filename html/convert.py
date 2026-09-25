"""Read an existing .parallax SQLite book into the browser viewer's JSON format.

This command only reads the source file. Close the Electron reader before converting
so SQLite can include any outstanding WAL changes in the snapshot.
"""

import argparse
import base64
import json
import os
import re
import sqlite3
import tempfile
from pathlib import Path

DROPPED = 32
LABEL = re.compile(
    r"^(?:(?:chapter|part|book|section|appendix|lecture)\s+)?"
    r"(?:[0-9]{1,3}|[ivxlcdm]{1,6}|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)"
    r"[.:]?$|^제?\s*[0-9]{1,3}\s*[장부편]$",
    re.I,
)


def has_table(db, name):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def rows(db, sql):
    return [dict(row) for row in db.execute(sql)]


def make_outline(blocks):
    heads = []
    for i, block in enumerate(blocks):
        if block["flags"] & DROPPED or block["type"] not in ("h1", "h2", "h3"):
            continue
        text = block["src"].strip()
        if len(text) <= 120:
            heads.append({"id": block["id"], "ord": block["ord"],
                          "level": int(block["type"][1]), "text": text, "pos": i})
    out = []
    i = 0
    while i < len(heads):
        cur = heads[i]
        next_head = heads[i + 1] if i + 1 < len(heads) else None
        text = cur["text"]
        if (next_head and LABEL.fullmatch(text) and
                next_head["level"] >= cur["level"] and
                not LABEL.fullmatch(next_head["text"]) and
                all(b["flags"] & DROPPED for b in blocks[cur["pos"] + 1:next_head["pos"]])):
            text += " · " + next_head["text"]
            i += 1
        out.append({"id": cur["id"], "ord": cur["ord"],
                    "level": cur["level"], "text": text})
        i += 1
    return out


def convert(source):
    if not source.is_file():
        raise ValueError(f"파일이 없습니다: {source}")
    uri = source.resolve().as_uri() + "?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    db.row_factory = sqlite3.Row
    try:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite 무결성 검사에 실패했습니다.")
        if not has_table(db, "doc") or not has_table(db, "block"):
            raise ValueError(".parallax 문서가 아닙니다.")
        doc = db.execute("SELECT * FROM doc LIMIT 1").fetchone()
        if doc is None:
            raise ValueError("문서 정보가 비었습니다.")
        if doc["schema_version"] > 2:
            raise ValueError("새로운 문서 형식입니다. 변환 도구를 업데이트하세요.")
        blocks = rows(db, "SELECT * FROM block ORDER BY ord")
        assets = []
        if has_table(db, "asset"):
            cols = {r[1] for r in db.execute("PRAGMA table_info(asset)")}
            for row in db.execute("SELECT * FROM asset"):
                asset = dict(row)
                asset["b64"] = base64.b64encode(asset.pop("data")).decode("ascii")
                if "wfrac" not in cols:
                    asset["wfrac"] = None
                assets.append(asset)
        highlights = []
        if has_table(db, "highlight"):
            highlights = rows(db,
                "SELECT id,group_id AS groupId,block_id AS blockId,side,"
                "start_off AS start,end_off AS end,text,created_at AS createdAt FROM highlight")
        cache = {}
        if has_table(db, "dict_cache"):
            cache_cols = {r[1] for r in db.execute("PRAGMA table_info(dict_cache)")}
            ko_col = "ko" if "ko" in cache_cols else "NULL AS ko"
            for row in rows(db, f"SELECT word,ipa,{ko_col},defs FROM dict_cache"):
                try:
                    defs = json.loads(row["defs"] or "[]")
                except json.JSONDecodeError:
                    defs = []
                cache[row["word"]] = {"ipa": row["ipa"] or "", "ko": row["ko"] or "", "defs": defs}
        return {
            "format": "parallax-json", "version": 1,
            "doc": dict(doc), "blocks": blocks,
            "outline": make_outline(blocks), "assets": assets,
            "highlights": highlights, "dictCache": cache,
            "bookmarks": [],
            "glossary": rows(db, "SELECT * FROM glossary") if has_table(db, "glossary") else [],
            "pageCheck": rows(db, "SELECT * FROM page_check") if has_table(db, "page_check") else [],
            "superseded": rows(db, "SELECT * FROM superseded") if has_table(db, "superseded") else [],
        }
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=".parallax 책을 HTML 뷰어용 JSON으로 변환")
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    target = args.out or args.source.with_suffix(".parallax.json")
    if target.resolve() == args.source.resolve():
        parser.error("출력 파일은 원본과 달라야 합니다.")
    book = convert(args.source)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(book, stream, ensure_ascii=False, separators=(",", ":"))
        os.replace(temp, target)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    print(f"{target} ({len(book['blocks'])} blocks, {len(book['assets'])} assets)")


if __name__ == "__main__":
    main()
