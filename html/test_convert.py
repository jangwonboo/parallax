import base64
import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

from convert import convert


class ConvertTest(unittest.TestCase):
    def test_older_book_without_new_columns_opens_read_only(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "old.parallax"
            db = sqlite3.connect(source)
            db.executescript("""
                CREATE TABLE doc (id TEXT, title TEXT, schema_version INTEGER);
                INSERT INTO doc VALUES ('old','Older book',1);
                CREATE TABLE block (id TEXT, ord INTEGER, page INTEGER, type TEXT,
                    src TEXT, ko TEXT, flags INTEGER);
                INSERT INTO block VALUES ('b1',1024,1,'p','Old text','옛 글',0);
                CREATE TABLE asset (id TEXT,mime TEXT,w INTEGER,h INTEGER,alt TEXT,data BLOB);
                INSERT INTO asset VALUES ('a1','image/png',1,1,'old',X'89504E47');
                CREATE TABLE dict_cache (word TEXT,ipa TEXT,defs TEXT);
                INSERT INTO dict_cache VALUES ('old','','[]');
            """)
            db.commit()
            db.close()
            book = convert(source)
            self.assertIsNone(book["assets"][0]["wfrac"])
            self.assertEqual(book["dictCache"]["old"]["ko"], "")

    def test_existing_book_survives_json_export_without_changing_source(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "sample.parallax"
            db = sqlite3.connect(source)
            db.executescript("""
                CREATE TABLE doc (id TEXT, title TEXT, title_ko TEXT, schema_version INTEGER);
                INSERT INTO doc VALUES ('d1','Book','책',2);
                CREATE TABLE block (id TEXT, ord INTEGER, page INTEGER, type TEXT,
                    src TEXT, ko TEXT, ko_raw TEXT, state INTEGER, flags INTEGER, height_px INTEGER);
                INSERT INTO block VALUES ('b1',1024,1,'h1','CHAPTER 1','제1장',NULL,2,0,NULL);
                INSERT INTO block VALUES ('b2',2048,1,'h2','Opening','시작',NULL,2,0,NULL);
                INSERT INTO block VALUES ('b3',3072,1,'p','Hello','안녕',NULL,2,0,NULL);
                INSERT INTO block VALUES ('b4',4096,1,'p','Page 1 of 1',NULL,NULL,0,32,NULL);
                CREATE TABLE asset (id TEXT,mime TEXT,w INTEGER,h INTEGER,alt TEXT,
                    wfrac REAL,data BLOB);
                INSERT INTO asset VALUES ('a1','image/png',1,1,'tiny',0.1,X'89504E47');
                CREATE TABLE highlight (id TEXT,group_id TEXT,block_id TEXT,side TEXT,
                    start_off INTEGER,end_off INTEGER,text TEXT,created_at INTEGER);
                INSERT INTO highlight VALUES ('h1','g1','b3','src',0,5,'Hello',123);
                CREATE TABLE dict_cache (word TEXT,ipa TEXT,ko TEXT,defs TEXT);
                INSERT INTO dict_cache VALUES ('hello','/həˈləʊ/','안녕','[{"pos":"interj","text":"A greeting."}]');
            """)
            db.commit()
            db.close()
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            book = convert(source)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            self.assertEqual(book["format"], "parallax-json")
            self.assertEqual(book["outline"][0]["text"], "CHAPTER 1 · Opening")
            self.assertEqual(len(book["blocks"]), 4)  # 버린 블록도 책에는 남는다
            self.assertEqual(base64.b64decode(book["assets"][0]["b64"]), b"\x89PNG")
            self.assertEqual(book["highlights"][0]["groupId"], "g1")
            self.assertEqual(book["dictCache"]["hello"]["defs"][0]["text"], "A greeting.")


if __name__ == "__main__":
    unittest.main()
