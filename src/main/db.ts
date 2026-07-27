import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as T from "../shared/types";

const DDL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS doc (
  id TEXT PRIMARY KEY, title TEXT, title_ko TEXT, author TEXT,
  source_path TEXT, source_hash TEXT, source_kind TEXT, pages INTEGER,
  schema_version INTEGER, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS block (
  id TEXT PRIMARY KEY, ord INTEGER NOT NULL, page INTEGER, type TEXT NOT NULL,
  src TEXT NOT NULL, ko TEXT, ko_raw TEXT,
  state INTEGER DEFAULT 0, flags INTEGER DEFAULT 0,
  height_px INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS block_ord   ON block(ord);
CREATE INDEX IF NOT EXISTS block_state ON block(state, ord);
CREATE INDEX IF NOT EXISTS block_page  ON block(page);

CREATE TABLE IF NOT EXISTS superseded (page INTEGER PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS glossary (
  en TEXT PRIMARY KEY, ko TEXT NOT NULL, kind TEXT, locked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS page_check (
  page INTEGER PRIMARY KEY, coverage REAL, columns INTEGER, notes TEXT, checked_at INTEGER
);
`;

export class Doc {
  readonly db: Database.Database;
  readonly path: string;

  private constructor(db: Database.Database, path: string) {
    this.db = db;
    this.path = path;
  }

  static open(path: string): Doc {
    const db = new Database(path);
    db.exec(DDL);
    const v = db.prepare("SELECT schema_version v FROM doc LIMIT 1").get() as
      | { v: number }
      | undefined;
    if (v && v.v > T.SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `이 문서는 더 새로운 형식(v${v.v})입니다. Parallax를 업데이트하세요.`
      );
    }
    // IN_FLIGHT 는 실행 중에만 유효하다 — 비정상 종료 흔적을 되돌린다
    db.prepare("UPDATE block SET state=0 WHERE state=1").run();
    return new Doc(db, path);
  }

  /** 새 문서를 만든다. blocks 는 읽기 순서대로. */
  static create(
    path: string,
    meta: {
      title: string;
      author?: string;
      sourcePath?: string;
      sourceKind: "pdf" | "md" | "txt";
      pages?: number | null;
    },
    blocks: { id: string; page?: number | null; type: string; src: string; flags?: number }[]
  ): Doc {
    const db = new Database(path);
    db.exec(DDL);
    const now = Math.floor(Date.now() / 1000);
    let hash = "";
    if (meta.sourcePath && existsSync(meta.sourcePath)) {
      hash = createHash("sha1").update(readFileSync(meta.sourcePath)).digest("hex");
    }
    db.prepare(
      `INSERT INTO doc(id,title,title_ko,author,source_path,source_hash,source_kind,
        pages,schema_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      randomUUID(), meta.title, null, meta.author ?? null, meta.sourcePath ?? null,
      hash, meta.sourceKind, meta.pages ?? null, T.SCHEMA_VERSION, now, now
    );
    const ins = db.prepare(
      `INSERT INTO block(id,ord,page,type,src,state,flags,updated_at)
       VALUES (?,?,?,?,?,0,?,?)`
    );
    db.transaction(() => {
      blocks.forEach((b, i) =>
        ins.run(b.id, (i + 1) * T.ORD_STEP, b.page ?? null, b.type, b.src, b.flags ?? 0, now)
      );
    })();
    return new Doc(db, path);
  }

  meta(): T.DocMeta {
    const d = this.db.prepare("SELECT * FROM doc LIMIT 1").get() as any;
    const c = this.db.prepare("SELECT count(*) n FROM block").get() as { n: number };
    const t = this.db
      .prepare("SELECT count(*) n FROM block WHERE ko IS NOT NULL AND ko<>''")
      .get() as { n: number };
    return { ...d, blockCount: c.n, translated: t.n };
  }

  count(): number {
    return (this.db.prepare("SELECT count(*) n FROM block").get() as any).n;
  }

  /** 가상 스크롤용 — 인덱스 구간을 ord 순으로 */
  range(offset: number, limit: number): T.Block[] {
    return this.db
      .prepare("SELECT * FROM block ORDER BY ord LIMIT ? OFFSET ?")
      .all(limit, offset) as T.Block[];
  }

  byIds(ids: string[]): T.Block[] {
    if (!ids.length) return [];
    const q = ids.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM block WHERE id IN (${q}) ORDER BY ord`)
      .all(...ids) as T.Block[];
  }

  /** 높이 캐시 — 렌더러가 실측해 돌려준다 */
  heights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare("SELECT id,height_px FROM block WHERE height_px IS NOT NULL")
      .iterate() as any) {
      out[r.id] = r.height_px;
    }
    return out;
  }

  setHeights(pairs: [string, number][]): void {
    const up = this.db.prepare("UPDATE block SET height_px=? WHERE id=?");
    this.db.transaction(() => pairs.forEach(([id, px]) => up.run(px, id)))();
  }

  clearHeights(): void {
    this.db.prepare("UPDATE block SET height_px=NULL").run();
  }

  outline(): T.Heading[] {
    return this.db
      .prepare(
        /* 목차는 늘 원문이다. 번역이 도착하는 대로 항목이 바뀌면 위치를 기억할
           수 없고, 번역된 것과 아닌 것이 섞여 목록이 두 언어로 갈린다. */
        `SELECT id, ord, type, src text
         FROM block WHERE type IN ('h1','h2','h3') ORDER BY ord`
      )
      .all()
      .map((r: any) => ({
        id: r.id,
        ord: r.ord,
        level: Number(r.type.slice(1)) as 1 | 2 | 3,
        text: r.text,
      }));
  }

  /** 번역 대상이면서 아직 안 된 블록. 스케줄러가 쓴다. */
  pending(limit = 200, afterOrd = -1): T.Block[] {
    return this.db
      .prepare(
        `SELECT * FROM block
         WHERE state=0 AND (flags & ?)=0 AND (flags & ?)=0 AND ord > ?
         ORDER BY ord LIMIT ?`
      )
      .all(T.NO_TRANSLATE, T.DROPPED, afterOrd, limit) as T.Block[];
  }

  markInFlight(ids: string[]): void {
    if (!ids.length) return;
    const q = ids.map(() => "?").join(",");
    this.db.prepare(`UPDATE block SET state=1 WHERE id IN (${q}) AND state=0`).run(...ids);
  }

  release(ids: string[]): void {
    if (!ids.length) return;
    const q = ids.map(() => "?").join(",");
    this.db.prepare(`UPDATE block SET state=0 WHERE id IN (${q}) AND state=1`).run(...ids);
  }

  applyTranslation(pairs: [string, string][]): void {
    const now = Math.floor(Date.now() / 1000);
    const up = this.db.prepare(
      "UPDATE block SET ko=?, state=?, height_px=NULL, updated_at=? WHERE id=?"
    );
    this.db.transaction(() => {
      for (const [id, ko] of pairs) up.run(ko, T.TRANSLATED, now, id);
      this.db.prepare("UPDATE doc SET updated_at=?").run(now);
    })();
  }

  applyDeslop(pairs: [string, string, string][]): void {
    const now = Math.floor(Date.now() / 1000);
    const up = this.db.prepare(
      "UPDATE block SET ko=?, ko_raw=?, state=?, height_px=NULL, updated_at=? WHERE id=?"
    );
    this.db.transaction(() => {
      for (const [id, ko, raw] of pairs) up.run(ko, raw, T.DESLOPPED, now, id);
    })();
  }

  /** 오역 대응 — 편집 대신 그 블록만 다시 돌린다 (spec §11.4) */
  resetBlocks(ids: string[]): void {
    if (!ids.length) return;
    const q = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE block SET ko=NULL, ko_raw=NULL, state=0, height_px=NULL WHERE id IN (${q})`
      )
      .run(...ids);
  }

  glossary(): { terms: Record<string, string>; keep: string[] } {
    const terms: Record<string, string> = {};
    const keep: string[] = [];
    for (const r of this.db.prepare("SELECT * FROM glossary").all() as any[]) {
      if (r.kind === "keep_original") keep.push(r.en);
      else terms[r.en] = r.ko;
    }
    return { terms, keep };
  }

  setGlossary(terms: Record<string, string>, keep: string[]): void {
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO glossary(en,ko,kind,locked) VALUES (?,?,?,1)"
    );
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM glossary").run();
      for (const [en, ko] of Object.entries(terms)) ins.run(en, ko, "term");
      for (const w of keep) ins.run(w, w, "keep_original");
    })();
  }

  /** 원본 파일이 바뀌었는지 (spec §3 — 바뀌어도 번역은 유지한다) */
  sourceChanged(): boolean {
    const d = this.db.prepare("SELECT source_path,source_hash FROM doc").get() as any;
    if (!d?.source_path || !d.source_hash || !existsSync(d.source_path)) return false;
    const now = createHash("sha1").update(readFileSync(d.source_path)).digest("hex");
    return now !== d.source_hash;
  }

  close(): void {
    this.db.close();
  }
}
