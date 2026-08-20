import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as T from "../shared/types";
import { MERGE_SEP, isOverlongHeading, mergesWithNext } from "../shared/headings";

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
  -- 원본 쪽 폭 대비 이 그림의 폭(0~1). 리더가 **원본에서 차지하던 비율대로**
  -- 그린다 — 작은 아이콘을 칸 가득 늘리지 않기 위한 값이다. 옛 파일에는 없다.
  wfrac REAL,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS glossary (
  en TEXT PRIMARY KEY, ko TEXT NOT NULL, kind TEXT, locked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS page_check (
  page INTEGER PRIMARY KEY, coverage REAL, columns INTEGER, notes TEXT, checked_at INTEGER
);

-- 형광펜. 사용자가 그은 것이라 책에 딸려 다녀야 한다 — 그래서 별도 파일이
-- 아니라 .parallax 안이다. 좌표는 DOM 이 아니라 block.src / block.ko 의
-- **문자 오프셋**이다(shared/types.ts 의 Highlight 주석 참조).
--
-- schema_version 은 올리지 않는다. 표를 더하는 것은 하위호환이고, 올리면
-- 구버전 앱이 「더 새로운 형식입니다」로 파일 자체를 거부한다. 구버전은 이
-- 표를 모른 채 그냥 무시하면 된다.
CREATE TABLE IF NOT EXISTS highlight (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, block_id TEXT NOT NULL,
  -- end 는 SQLite 예약어(CASE…END)라 컬럼명으로 쓰면 인용해야 한다. 짝인
  -- start 까지 같이 바꿔 둔다 — 한쪽만 다르면 질의문마다 헷갈린다.
  -- (이 DDL 은 template literal 이다 — 주석에 백틱을 쓰면 문자열이 끊긴다.)
  side TEXT NOT NULL, start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hl_block ON highlight(block_id, side);
CREATE INDEX IF NOT EXISTS hl_group ON highlight(group_id);
`;

export class Doc {
  readonly db: Database.Database;
  readonly path: string;

  private constructor(db: Database.Database, path: string) {
    this.db = db;
    this.path = path;
  }

  /** 열을 나중에 붙인다.
   *
   * `CREATE TABLE IF NOT EXISTS` 는 **이미 있는 표를 건드리지 않는다.** DDL 에
   * 열을 적어 두는 것만으로는 옛 파일에 생기지 않고, 그 열을 SELECT 하는 순간
   * `no such column` 으로 문서가 안 열린다 — 2026-08-16 에 `wfrac` 을 넣으면서
   * 실제로 그렇게 됐다. 열을 늘릴 때는 DDL 과 **여기 둘 다** 고칠 것. */
  private static migrate(db: Database.Database): void {
    const add = (table: string, col: string, decl: string) => {
      const has = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .some((c) => c.name === col);
      if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    };
    add("asset", "wfrac", "REAL");
    /* 표를 더하는 것은 위 DDL 의 `IF NOT EXISTS` 가 옛 파일에도 해 준다 —
       열을 더하는 것과 달리 여기서 따로 할 일이 없다. */
  }

  static open(path: string): Doc {
    const db = new Database(path);
    db.exec(DDL);
    Doc.migrate(db);
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
    assets?: Record<string, { mime: string; w: number; h: number; alt?: string;
                              wfrac?: number; b64: string }>
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
      "INSERT INTO asset(id,mime,w,h,alt,wfrac,data) VALUES (?,?,?,?,?,?,?)");
    db.transaction(() => {
      blocks.forEach((b, i) =>
        ins.run(b.id, (i + 1) * T.ORD_STEP, b.page ?? null, b.type, b.src, b.flags ?? 0, now)
      );
      for (const [pg, items] of Object.entries(superseded ?? {})) {
        sup.run(parseInt(pg, 10), JSON.stringify(items));
      }
      for (const [aid, a] of Object.entries(assets ?? {})) {
        insAsset.run(aid, a.mime, a.w, a.h, a.alt ?? null, a.wfrac ?? null,
                     Buffer.from(a.b64, "base64"));
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
      .prepare("SELECT id,mime,w,h,alt,wfrac FROM asset")
      .all() as T.AssetMeta[];
  }

  /** 그림 데이터. 렌더러가 data URI 로 만들어 <img> 에 건다. */
  asset(id: string): (T.AssetMeta & { b64: string }) | null {
    const r = this.db
      .prepare("SELECT id,mime,w,h,alt,wfrac,data FROM asset WHERE id=?")
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

  /* ── 형광펜 ──────────────────────────────────────────
     좌표는 block.src / block.ko 의 문자 오프셋이다. 여기서는 그것을 저장하고
     겹침만 정리한다 — 무엇이 어디에 칠해지는지는 렌더러가 판단한다. */

  /** 읽기 순서(ord)대로. `page` 는 목록에 쪽을 적기 위한 것이다. */
  highlights(): (T.Highlight & { ord: number; page: number | null })[] {
    return this.db
      .prepare(
        `SELECT h.id, h.group_id AS groupId, h.block_id AS blockId, h.side,
                h.start_off AS start, h.end_off AS end, h.text,
                h.created_at AS createdAt, b.ord, b.page
           FROM highlight h JOIN block b ON b.id = h.block_id
          ORDER BY b.ord, h.side DESC, h.start_off`
      )
      .all() as any;
  }

  /**
   * 형광펜 하나를 넣는다. `frags` 는 한 번의 드래그가 걸친 블록마다 한 조각.
   *
   * **겹치면 합집합 하나로 합친다**(사용자 결정 2026-08-20). 중첩을 허용하면
   * 화면의 칠 하나에 목록 항목이 둘 붙어 「이 칠을 지우려면 어느 항목인가」에
   * 답이 없어진다. 🗑 을 눌러도 절반만 지워지는 꼴이 된다.
   *
   * 합칠 때 겹친 그룹을 통째로 지우지 않고 **남은 조각을 새 그룹으로 데려온다.**
   * 세 단락에 걸친 형광펜의 가운데 단락만 겹쳐 그었다고 해서 위아래 단락의
   * 칠까지 사라지면 안 된다.
   */
  addHighlight(
    frags: { blockId: string; side: "src" | "ko"; start: number; end: number; text: string }[]
  ): string {
    const gid = randomUUID();
    const now = Date.now();

    const overlapping = this.db.prepare(
      /* 맞닿은 것(`<=`)까지 겹친 것으로 친다 — 「abc」와 바로 뒤 「def」를 따로
         두면 화면에는 이어진 칠 하나로 보이는데 항목은 둘이다. */
      `SELECT id, group_id AS gid, start_off AS s, end_off AS e FROM highlight
        WHERE block_id=? AND side=? AND start_off <= ? AND end_off >= ?`
    );
    const dropFrag = this.db.prepare("DELETE FROM highlight WHERE id=?");
    const reparent = this.db.prepare("UPDATE highlight SET group_id=? WHERE group_id=?");
    const ins = this.db.prepare(
      `INSERT INTO highlight (id,group_id,block_id,side,start_off,end_off,text,created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    );

    this.db.transaction(() => {
      for (const f of frags) {
        let { start, end, text } = f;
        const hit = overlapping.all(f.blockId, f.side, end, start) as
          { id: string; gid: string; s: number; e: number }[];
        for (const h of hit) {
          start = Math.min(start, h.s);
          end = Math.max(end, h.e);
          dropFrag.run(h.id);
          /* 이 블록 밖에 있던 같은 그룹의 조각들을 새 그룹으로 옮긴다.
             위에서 이 블록의 조각은 이미 지웠으므로 중복은 생기지 않는다. */
          if (h.gid !== gid) reparent.run(gid, h.gid);
        }
        /* 범위가 넓어졌으면 사본도 다시 떠야 한다 — 옛 사본을 그대로 두면
           다음 대조에서 어긋난 것으로 판정돼 칠이 안 된다. */
        if (start !== f.start || end !== f.end) {
          const b = this.db.prepare("SELECT src, ko FROM block WHERE id=?")
            .get(f.blockId) as { src: string; ko: string | null } | undefined;
          const whole = (f.side === "src" ? b?.src : b?.ko) ?? "";
          text = whole.slice(start, end);
        }
        ins.run(randomUUID(), gid, f.blockId, f.side, start, end, text, now);
      }
    })();
    return gid;
  }

  /** 그룹 단위로 지운다. 사용자가 한 번 그은 것은 한 번에 사라져야 한다. */
  removeHighlights(groupIds: string[]): number {
    if (!groupIds.length) return 0;
    const q = groupIds.map(() => "?").join(",");
    return this.db.prepare(`DELETE FROM highlight WHERE group_id IN (${q})`)
      .run(...groupIds).changes;
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
      /* 본문 한 문단이 제목으로 잘못 잡힌 것은 목차에서 감춘다(규칙은
         shared/headings). 파일은 그대로 둔다. 내보내기는 같은 것을 버리지
         않고 문단으로 내린다 — 거기서는 글이 사라지면 안 된다. */
      .filter((r) => !isOverlongHeading(r.text))
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
      const merge = mergesWithNext(cur, next, !!next && next.rn === cur.rn + 1);
      out.push({
        id: cur.id, ord: cur.ord, level: cur.level,
        text: merge ? cur.text + MERGE_SEP + next.text : cur.text,
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
