import Anthropic from "@anthropic-ai/sdk";
import { Doc } from "../db";
import * as T from "../../shared/types";
import { translateSystem, DESLOP_SYSTEM, toWire, fromWire } from "./prompt";

const MODEL = process.env.PARALLAX_MODEL || "claude-sonnet-4-6";
const CHUNK_CHARS = 6000;
const CONCURRENCY: Record<T.Priority, number> = { 0: 4, 1: 2, 2: 2, 3: 1 };

/** 대략치. 정확한 청구는 콘솔에서 확인해야 한다. */
const USD_PER_MTOK_IN = 3;
const USD_PER_MTOK_OUT = 15;

interface Task {
  ids: string[];
  priority: T.Priority;
  kind: "translate" | "deslop";
}

export class Scheduler {
  private doc: Doc;
  private client: Anthropic | null = null;
  private queue: Task[] = [];
  private inFlight = new Set<string>();
  private queued = new Set<string>();
  private running = 0;
  private spendUsd = 0;
  private mode: T.Mode = "chapter";
  private paused = false;
  private tail = "";
  private onChange: (ids: string[]) => void;
  private onStats: () => void;

  constructor(doc: Doc, onChange: (ids: string[]) => void, onStats: () => void) {
    this.doc = doc;
    this.onChange = onChange;
    this.onStats = onStats;
  }

  setKey(key: string | null) {
    this.client = key ? new Anthropic({ apiKey: key }) : null;
  }

  hasKey(): boolean {
    return this.client !== null;
  }

  setMode(mode: T.Mode) {
    this.mode = mode;
    if (mode === "all") this.seedAll();
  }

  pause(v: boolean) {
    this.paused = v;
    if (!v) this.pump();
  }

  stats(): T.Stats {
    const m = this.doc.meta();
    const translatable = (
      this.doc.db
        .prepare("SELECT count(*) n FROM block WHERE (flags & ?)=0 AND (flags & ?)=0")
        .get(T.NO_TRANSLATE, T.DROPPED) as any
    ).n;
    return {
      total: m.blockCount,
      translatable,
      done: m.translated,
      inFlight: this.inFlight.size,
      queued: this.queued.size,
      spendUsd: this.spendUsd,
      mode: this.mode,
      paused: this.paused,
    };
  }

  /** 뷰포트가 바뀔 때 렌더러가 부른다. 이미 큐에 있으면 우선순위만 올린다. */
  request(ids: string[], priority: T.Priority) {
    const fresh = ids.filter((id) => !this.inFlight.has(id) && !this.queued.has(id));
    if (fresh.length) {
      for (const t of this.queue) {
        if (t.priority > priority && t.ids.some((i) => fresh.includes(i))) t.priority = priority;
      }
      for (const chunk of this.buildChunks(fresh)) {
        chunk.ids.forEach((i) => this.queued.add(i));
        this.queue.push({ ...chunk, priority, kind: "translate" });
      }
    } else {
      // 승격만
      for (const t of this.queue) {
        if (t.priority > priority && t.ids.some((i) => ids.includes(i))) t.priority = priority;
      }
    }
    this.pump();
  }

  private seedAll() {
    const pending = this.doc.pending(5000);
    const ids = pending.map((b) => b.id).filter((i) => !this.queued.has(i) && !this.inFlight.has(i));
    for (const chunk of this.buildChunks(ids)) {
      chunk.ids.forEach((i) => this.queued.add(i));
      this.queue.push({ ...chunk, priority: 3, kind: "translate" });
    }
    this.pump();
  }

  /** 블록 하나만 던지면 문맥이 끊긴다. 장 경계를 넘지 않는 선에서 묶는다. */
  private buildChunks(ids: string[]): { ids: string[] }[] {
    const blocks = this.doc.byIds(ids);
    const out: { ids: string[] }[] = [];
    let cur: string[] = [];
    let size = 0;
    for (const b of blocks) {
      if (b.type === "h1" && cur.length) {
        out.push({ ids: cur });
        cur = [];
        size = 0;
      }
      if (size + b.src.length > CHUNK_CHARS && cur.length) {
        out.push({ ids: cur });
        cur = [];
        size = 0;
      }
      cur.push(b.id);
      size += b.src.length;
    }
    if (cur.length) out.push({ ids: cur });
    return out;
  }

  private next(): Task | undefined {
    if (this.paused) return undefined;
    let best = -1;
    for (let i = 0; i < this.queue.length; i++) {
      if (best < 0 || this.queue[i].priority < this.queue[best].priority) best = i;
    }
    return best < 0 ? undefined : this.queue.splice(best, 1)[0];
  }

  private pump() {
    if (!this.client) return;
    while (this.running < 4) {
      const peek = this.queue.length ? Math.min(...this.queue.map((t) => t.priority)) : 3;
      if (this.running >= CONCURRENCY[peek as T.Priority]) break;
      const task = this.next();
      if (!task) break;
      this.running++;
      this.run(task)
        .catch((e) => console.error("[scheduler]", e?.message ?? e))
        .finally(() => {
          this.running--;
          this.onStats();
          this.pump();
        });
    }
  }

  private async run(task: Task) {
    const blocks = this.doc.byIds(task.ids).filter((b) => !b.ko);
    task.ids.forEach((i) => this.queued.delete(i));
    if (!blocks.length) return;

    const ids = blocks.map((b) => b.id);
    ids.forEach((i) => this.inFlight.add(i));
    this.doc.markInFlight(ids);
    this.onStats();

    try {
      const g = this.doc.glossary();
      const wire = toWire(blocks.map((b) => ({ id: b.id, text: b.src })));
      const user = this.tail
        ? `[직전 문맥 — 참고만 하고 번역하지 마라]\n${this.tail}\n\n[번역 대상]\n${wire}`
        : wire;

      const got = await this.call(translateSystem(g), user, ids);
      const pairs: [string, string][] = [];
      for (const b of blocks) if (got[b.id]) {
        /* 시스템 프롬프트의 블록 타입 설명(h2 = 제목 …)을 보고 모델이 이따금
           타입 토큰을 번역 앞에 흘린다. 자기 블록의 타입과 일치할 때만 벗긴다 —
           실제로 h2 블록 하나가 "h2 내 삶에서…" 로 저장된 적이 있다. */
        let ko = got[b.id];
        if (ko.startsWith(b.type + " ")) ko = ko.slice(b.type.length + 1).trim();
        pairs.push([b.id, ko]);
      }

      if (pairs.length) {
        this.doc.applyTranslation(pairs);
        const last = blocks.slice(-2);
        this.tail = last.map((b) => `${b.src}\n→ ${got[b.id] ?? ""}`).join("\n");
        this.onChange(pairs.map(([id]) => id));
      }
      const missed = ids.filter((i) => !got[i]);
      if (missed.length) this.doc.release(missed);
    } finally {
      ids.forEach((i) => this.inFlight.delete(i));
    }
  }

  /** ID 보존 호출. 빠뜨린 블록은 한 번 더 요청한다. */
  private async call(
    system: string,
    user: string,
    expected: string[]
  ): Promise<Record<string, string>> {
    const raw = await this.send(system, user);
    let got = fromWire(raw);
    const missing = expected.filter((i) => !got[i]);
    if (missing.length && missing.length < expected.length) {
      const lines = user
        .split("\n")
        .filter((l) => missing.some((m) => l.startsWith(`[${m}]`)))
        .join("\n");
      if (lines.trim()) {
        const retry = await this.send(system, lines);
        got = { ...got, ...fromWire(retry) };
      }
    }
    const clean: Record<string, string> = {};
    for (const id of expected) if (got[id]) clean[id] = got[id];
    return clean;
  }

  private async send(system: string, user: string): Promise<string> {
    if (!this.client) throw new Error("API 키가 설정되지 않았습니다.");
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.client.messages.create({
          model: MODEL,
          max_tokens: Math.min(16000, user.length * 2 + 2000),
          system,
          messages: [{ role: "user", content: user }],
        });
        const u = r.usage;
        this.spendUsd +=
          (u.input_tokens / 1e6) * USD_PER_MTOK_IN + (u.output_tokens / 1e6) * USD_PER_MTOK_OUT;
        return r.content
          .filter((c): c is Anthropic.TextBlock => c.type === "text")
          .map((c) => c.text)
          .join("");
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 2 ** attempt * 4000));
      }
    }
    throw lastErr;
  }

  /** deslop 은 읽는 중에 글자가 바뀌지 않도록 뷰포트를 벗어난 뒤에 돈다 (spec §4.5) */
  async deslop(ids: string[]) {
    const blocks = this.doc.byIds(ids).filter((b) => b.ko && b.state === T.TRANSLATED);
    if (!blocks.length || !this.client) return;
    const wire = blocks.map((b) => `[${b.id}] ${b.ko}`).join("\n");
    const src = blocks.map((b) => `[${b.id}] ${b.src}`).join("\n");
    const got = await this.call(
      DESLOP_SYSTEM,
      `[영어 원문 — 의미 검사용, 번역 대상 아님]\n${src}\n\n[교정 대상 한국어]\n${wire}`,
      blocks.map((b) => b.id)
    );
    const pairs: [string, string, string][] = [];
    for (const b of blocks) {
      const nu = got[b.id];
      if (nu && b.ko) pairs.push([b.id, nu, b.ko]);
    }
    if (pairs.length) {
      this.doc.applyDeslop(pairs);
      this.onChange(pairs.map(([id]) => id));
    }
  }

  dispose() {
    this.queue = [];
    this.queued.clear();
    this.inFlight.clear();
  }
}
