"""Read-only validation for a translated .parallax book."""

import argparse
import sqlite3
from pathlib import Path


def check(path):
    db = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    try:
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        total, translated, pending = db.execute("""
            SELECT count(*),
              sum(CASE WHEN ko IS NOT NULL AND ko<>'' THEN 1 ELSE 0 END),
              sum(CASE WHEN (flags&16)=0 AND (flags&32)=0
                AND (ko IS NULL OR ko='') THEN 1 ELSE 0 END)
            FROM block
        """).fetchone()
        assets = db.execute("SELECT count(*) FROM asset").fetchone()[0]
        missing_images = db.execute("""
            SELECT count(*) FROM block b LEFT JOIN asset a ON a.id=b.src
            WHERE b.type='figure' AND a.id IS NULL
        """).fetchone()[0]
        unlocalized = db.execute("""
            SELECT count(*) FROM block WHERE length(src)>100 AND ko IS NOT NULL
              AND ko NOT GLOB '*[가-힣]*'
        """).fetchone()[0]
        short = db.execute("""
            SELECT count(*) FROM block WHERE length(src)>300 AND ko IS NOT NULL
              AND length(ko)<length(src)*0.2
        """).fetchone()[0]
        print(f"integrity={integrity}; blocks={total}; translated={translated}; pending={pending}; "
              f"assets={assets}; missing_images={missing_images}; "
              f"unlocalized_long={unlocalized}; suspicious_short={short}")
        return integrity == "ok" and pending == 0 and missing_images == 0 and short == 0
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("book", type=Path)
    args = parser.parse_args()
    raise SystemExit(0 if check(args.book) else 1)
