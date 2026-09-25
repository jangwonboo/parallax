"""Build an Electron compatible .parallax book from Markdown and local images."""

import argparse
import hashlib
import mimetypes
import re
import sqlite3
import time
import uuid
from pathlib import Path

DDL = """
CREATE TABLE doc (id TEXT PRIMARY KEY, title TEXT, title_ko TEXT, author TEXT,
  source_path TEXT, source_hash TEXT, source_kind TEXT, pages INTEGER,
  schema_version INTEGER, created_at INTEGER, updated_at INTEGER);
CREATE TABLE block (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, page INTEGER,
  type TEXT NOT NULL, src TEXT NOT NULL, ko TEXT, ko_raw TEXT,
  state INTEGER DEFAULT 0, flags INTEGER DEFAULT 0,
  height_px INTEGER, updated_at INTEGER);
CREATE INDEX block_ord ON block(ord);
CREATE INDEX block_state ON block(state, ord);
CREATE INDEX block_page ON block(page);
CREATE TABLE asset (id TEXT PRIMARY KEY, mime TEXT NOT NULL, w INTEGER,
  h INTEGER, alt TEXT, wfrac REAL, data BLOB NOT NULL);
CREATE TABLE highlight (id TEXT PRIMARY KEY, group_id TEXT NOT NULL,
  block_id TEXT NOT NULL, side TEXT NOT NULL, start_off INTEGER NOT NULL,
  end_off INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX hl_block ON highlight(block_id, side);
CREATE INDEX hl_group ON highlight(group_id);
CREATE TABLE dict_cache (word TEXT PRIMARY KEY, ipa TEXT, ko TEXT,
  defs TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE glossary (en TEXT PRIMARY KEY, ko TEXT NOT NULL,
  kind TEXT, locked INTEGER DEFAULT 0);
CREATE TABLE page_check (page INTEGER PRIMARY KEY, coverage REAL,
  columns INTEGER, notes TEXT, checked_at INTEGER);
CREATE TABLE superseded (page INTEGER PRIMARY KEY, payload TEXT NOT NULL);
"""

IMAGE = re.compile(r"^!\[([^]]*)\]\(([^)]+)\)$")
HEADING = re.compile(r"^(#{1,6})\s+(.+)$")
LINK = re.compile(r"\[([^]]+)\]\([^)]+\)")


def clean(text):
    text = LINK.sub(r"\1", text)
    text = text.replace("**", "").replace("__", "")
    return re.sub(r"\s+", " ", text).strip()


def parse(source):
    root = source.parent.resolve()
    blocks = []
    images = {}
    paragraph = []

    def add(kind, text, flags=0):
        value = clean(text)
        if value:
            blocks.append((f"b{len(blocks)+1:05d}", kind, value, flags))

    def flush():
        if paragraph:
            add("p", " ".join(paragraph))
            paragraph.clear()

    for raw in source.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line:
            flush()
            continue
        image = IMAGE.fullmatch(line)
        if image:
            flush()
            path = (root / image.group(2)).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                raise ValueError(f"이미지 파일이 없습니다: {image.group(2)}")
            aid = "asset-" + hashlib.sha1(image.group(2).encode()).hexdigest()[:16]
            images[aid] = (path, image.group(1))
            add("figure", aid, 16)
            continue
        heading = HEADING.fullmatch(line)
        if heading:
            flush()
            level = len(heading.group(1))
            add("h" + str(min(3, max(1, level - 1))), heading.group(2))
            continue
        if line.startswith("> "):
            flush()
            add("quote", line[2:])
            continue
        paragraph.append(line)
    flush()
    return blocks, images


def create(source, target):
    source = source.resolve()
    target = target.resolve()
    if target.exists():
        raise FileExistsError(f"대상 파일이 이미 있습니다: {target}")
    blocks, images = parse(source)
    title = next((text for _, kind, text, _ in blocks if kind == "h1"), source.stem)
    now = int(time.time())
    target.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(target)
    try:
        db.executescript(DDL)
        db.execute("INSERT INTO doc VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
            str(uuid.uuid4()), title, None, "Chip Heath and Dan Heath",
            str(source), hashlib.sha1(source.read_bytes()).hexdigest(),
            "md", None, 2, now, now))
        db.executemany(
            "INSERT INTO block(id,ord,page,type,src,ko,ko_raw,state,flags,height_px,updated_at) "
            "VALUES (?,?,?,?,?,NULL,NULL,0,?,NULL,?)",
            [(bid, i * 1024, None, kind, text, flags, now)
             for i, (bid, kind, text, flags) in enumerate(blocks, 1)])
        for aid, (path, alt) in images.items():
            db.execute("INSERT INTO asset VALUES (?,?,?,?,?,?,?)", (
                aid, mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                None, None, alt, None, path.read_bytes()))
        db.commit()
        print(f"{target} - {len(blocks)} blocks, {len(images)} images")
    except BaseException:
        db.close()
        target.unlink(missing_ok=True)
        raise
    finally:
        try:
            db.close()
        except Exception:
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    create(args.source, args.out)
