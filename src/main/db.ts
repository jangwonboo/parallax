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
CREATE TABLE IF NOT EXISTS asset (
  id TEXT PRIMARY KEY, mime TEXT NOT NULL, w INTEGER, h INTEGER, alt TEXT,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS glossary (
  en TEXT PRIMARY KEY, ko TEXT NOT NULL, kind TEXT, locked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS page_check (
  page INTEGER PRIMARY KEY, coverage REAL, columns INTEGER, notes TEXT, checked_at INTEGER
);
`;

/* ── 목차 다듬기 ─────────────────────────────────────
   여기서 하는 일은 데이터를 고치는 것이 아니라 **목차를 조립하는 것**이다.
   블록은 그대로 두고 outline() 이 내보내는 목록만 손본다 — 되돌리려면 이
   함수 둘만 지우면 되고, 이미 만들어 둔 .parallax 를 다시 변환할 필요도 없다. */

/** 이보다 긴 것은 제목이 아니라 본문이다(근거는 outline() 주석). */
const MAX_HEADING = 120;

/** 「CHAPTER 1」·「PART ONE」·「제 3 장」처럼 **수사뿐**인 제목인가.
 *
 *  끝을 물린 것(`$`)이 중요하다. 「Part I — Foundational Marketing Signals」
 *  처럼 수사와 제목이 이미 한 줄에 있는 것은 합칠 것이 없으므로 걸리면 안 된다.
 *
 *  번호가 붙은 것만 본다. 「INTRODUCTION」·「CONCLUSION」 같은 맨 수사는
 *  일부러 뺐다 — 뒤따르는 것이 그 부의 제목인지 첫 절인지 데이터로 구분되지
 *  않는다(실측: INTRODUCTION 다음의 「Unheimlich」는 제목이 아니라 첫 절로
 *  보인다). 잘못 합치면 절 하나가 목차에서 사라진다. */
const ORDINAL =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|" +
  "fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty";
const LABEL_EN = new RegExp(
  `^(chapter|part|book|section|appendix)\\s+([0-9]{1,3}|[ivxlcdm]{1,6}|${ORDINAL})[.:]?$`,
  "i"
);
const LABEL_KO = /^제?\s*[0-9]{1,3}\s*[장부편]$/;

function isNumberedLabel(text: string): boolean {
  const t = text.trim();
  return LABEL_EN.test(t) || LABEL_KO.test(t);
}

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
    blocks: { id: string; page?: number | null; type: string; src: string; flags?: number }[],
    /* 재판독(`--trust vision`)이 밀어낸 원 텍스트 레이어. 스킬 export.py 와 같은
       저장 형식(page 정수, payload 는 JSON 문자열)이다 — 한쪽을 고치면 다른 쪽도. */
    superseded?: Record<string, unknown[]>,
    /* pagecheck 판정. 리포트 파일은 임시 폴더와 함께 지워지므로 여기 못 넣으면
       쪽당 비전 호출로 산 근거가 사라진다. 요약은 page=0 행. */
    pageCheck?: T.PageCheck | null,
    /* Datalab 재판독이 잘라 보낸 그림. figure 블록의 src 가 여기 id 를 가리킨다.
       스킬 export.py 와 같은 이관이다 — 한쪽을 고치면 다른 쪽도. */
    assets?: Record<string, { mime: string; w: number; h: number; alt?: string; b64: string }>
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
    const sup = db.prepare("INSERT INTO superseded(page,payload) VALUES (?,?)");
    const insAsset = db.prepare(
      "INSERT INTO asset(id,mime,w,h,alt,data) VALUES (?,?,?,?,?,?)");
    db.transaction(() => {
      blocks.forEach((b, i) =>
        ins.run(b.id, (i + 1) * T.ORD_STEP, b.page ?? null, b.type, b.src, b.flags ?? 0, now)
      );
      for (const [pg, items] of Object.entries(superseded ?? {})) {
        sup.run(parseInt(pg, 10), JSON.stringify(items));
      }
      for (const [aid, a] of Object.entries(assets ?? {})) {
        insAsset.run(aid, a.mime, a.w, a.h, a.alt ?? null, Buffer.from(a.b64, "base64"));
      }
      if (pageCheck) {
        const pc = db.prepare(
          "INSERT INTO page_check(page,coverage,columns,notes,checked_at) VALUES (?,?,?,?,?)");
        pc.run(0, null, null, pageCheck.summary, now);
        for (const r of pageCheck.pages) {
          /* 사유·메모를 notes 로 합친다 — 스킬 export.py 와 같은 규칙. */
          const notes = [(r.reasons ?? []).join("; "), r.notes ?? ""]
            .filter(Boolean).join(" — ");
          pc.run(r.page, r.coverage, r.columns, notes, now);
        }
      }
    })();
    return new Doc(db, path);
  }

  /** 그림 목록(데이터 제외). 렌더러가 문서를 열 때 한 번 받아 높이 추정에 쓴다. */
  assetsMeta(): T.AssetMeta[] {
    return this.db
      .prepare("SELECT id,mime,w,h,alt FROM asset")
      .all() as T.AssetMeta[];
  }

  /** 그림 데이터. 렌더러가 data URI 로 만들어 <img> 에 건다. */
  asset(id: string): (T.AssetMeta & { b64: string }) | null {
    const r = this.db
      .prepare("SELECT id,mime,w,h,alt,data FROM asset WHERE id=?")
      .get(id) as any;
    if (!r) return null;
    const { data, ...meta } = r;
    return { ...meta, b64: Buffer.from(data).toString("base64") };
  }

  /** pagecheck 판정 행. page=0 이 요약, 없으면 검증 없이 연 문서다. */
  pageCheck(): { page: number; coverage: number | null; columns: number | null; notes: string | null }[] {
    return this.db
      .prepare("SELECT page,coverage,columns,notes FROM page_check ORDER BY page")
      .all() as any;
  }

  meta(): T.DocMeta {
    const d = this.db.prepare("SELECT * FROM doc LIMIT 1").get() as any;
    /* 세는 것도 보여 주는 것과 같아야 한다 — 버린 블록을 분모에 넣으면
       전부 번역해도 진행률이 100% 에 닿지 않는다. */
    const c = this.db
      .prepare(`SELECT count(*) n FROM block WHERE flags & ${T.DROPPED} = 0`)
      .get() as { n: number };
    const t = this.db
      .prepare(`SELECT count(*) n FROM block
                WHERE ko IS NOT NULL AND ko<>'' AND flags & ${T.DROPPED} = 0`)
      .get() as { n: number };
    return { ...d, blockCount: c.n, translated: t.n };
  }

  /* 리더는 버린 블록을 보여 주지 않는다.
     `DROPPED` 는 전자책 뷰어의 쪽 표시(`Page 60 of 252 · 3%`), 러닝 헤드, 도판에서
     뜯겨 나온 눈금 조각이다 — 원문 대조에 쓸모가 있으리라 보고 원문 칸에 남겨 뒀는데,
     244쪽 책 하나에 184개가 본문 사이에 흩뿌려져 읽는 흐름을 끊었다. 파일에는 그대로
     남는다(ID 불변, 되돌릴 수 있다). 보여 주지 않을 뿐이다. */
  private readonly VISIBLE = `flags & ${T.DROPPED} = 0`;

  count(): number {
    return (this.db.prepare(`SELECT count(*) n FROM block WHERE ${this.VISIBLE}`)
      .get() as any).n;
  }

  /** 가상 스크롤용 — 인덱스 구간을 ord 순으로 */
  range(offset: number, limit: number): T.Block[] {
    return this.db
      .prepare(`SELECT * FROM block WHERE ${this.VISIBLE} ORDER BY ord LIMIT ? OFFSET ?`)
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
    const rows: any[] = this.db
      .prepare(
        /* 목차는 늘 원문이다. 번역이 도착하는 대로 항목이 바뀌면 위치를 기억할
           수 없고, 번역된 것과 아닌 것이 섞여 목록이 두 언어로 갈린다.

           rn 은 **버리지 않은 블록 전체**에서의 자리다. 제목 둘이 정말 맞붙어
           있는지(사이에 본문이 없는지) 판별하는 데 쓴다 — ord 차이로 재면
           안 된다. ord 는 성기게 매겨져 간격이 일정하지 않다. */
        `WITH b AS (
           SELECT id, ord, type, src, ROW_NUMBER() OVER (ORDER BY ord) rn
           FROM block WHERE flags & ${T.DROPPED} = 0
         )
         SELECT id, ord, type, src text, rn FROM b
         WHERE type IN ('h1','h2','h3') ORDER BY ord`
      )
      .all();

    const heads = rows
      /* 구조 인식이 본문 한 문단을 제목으로 잘못 잡는 일이 있다(실측: 한 책에
         129자짜리 문단이 h2 로 들어와 목차에 통째로 박혀 있었다). 네 책의 진짜
         제목 최장은 95자라 120 을 넘으면 제목이 아니라고 본다. 파일은 그대로
         두고 목차에서만 감춘다. */
      .filter((r) => r.text.length <= MAX_HEADING)
      .map((r) => ({
        id: r.id as string,
        ord: r.ord as number,
        level: Number(r.type.slice(1)) as 1 | 2 | 3,
        text: r.text as string,
        rn: r.rn as number,
      }));

    /* 수사와 제목이 두 블록으로 갈려 있는 책이 많다 — 「CHAPTER 1」 다음 줄에
       「The Meaning of Meaning」. 그대로 두면 수사가 부모, 제목이 자식으로
       보여 위계가 한 칸씩 밀린다. 맞붙어 있으면 한 항목으로 합친다.

       클릭 목표(id)와 자리(ord)는 **앞의 수사 블록**을 그대로 쓴다. 그래야
       목차를 눌렀을 때 장이 열리는 자리에 정확히 선다. */
    const out: T.Heading[] = [];
    for (let i = 0; i < heads.length; i++) {
      const cur = heads[i], next = heads[i + 1];
      const merge =
        next &&
        next.rn === cur.rn + 1 &&        // 사이에 본문이 없다
        next.level >= cur.level &&       // 제목이 수사보다 얕아지지는 않는다
        isNumberedLabel(cur.text) &&
        !isNumberedLabel(next.text);
      out.push({
        id: cur.id, ord: cur.ord, level: cur.level,
        text: merge ? `${cur.text} · ${next.text}` : cur.text,
      });
      if (merge) i++;                    // 제목은 흡수됐다
    }
    return out;
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
