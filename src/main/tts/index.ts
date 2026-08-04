/**
 * TTS 수명주기 — utilityProcess 를 띄우고 재우고, 합성 요청을 중계한다.
 * spec-tts.md §4.3, §7.
 *
 * T2 범위는 「블록 하나가 소리 난다」까지다. 청크 큐·선행 합성·연속 재생은 T3.
 */
import { app, utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as A from "./assets";
import type { Lang, SpeakOpt } from "./synth";

export interface TtsStatus {
  installed: boolean;
  bytesNeeded: number;
  ready: boolean;
  voice: string;
  voices: string[];
}

export interface TtsSettings {
  side: "ko" | "src";
  voice: string;
  speed: number;
  steps: number;
  gapMs: number;
  blockGapMs: number;
  follow: boolean;
  idleExitSec: number;
}

export const DEFAULTS: TtsSettings = {
  side: "ko", voice: "F1", speed: 1.05, steps: 8,
  gapMs: 300, blockGapMs: 500, follow: true, idleExitSec: 300,
};

type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void };

export class Tts {
  private dir = join(app.getPath("userData"), "tts");
  private proc: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private waiters = new Map<string, Waiter>();
  private steps = new Map<string, (done: number, total: number) => void>();
  private idle: NodeJS.Timeout | null = null;
  private emit: (channel: string, payload: unknown) => void;
  private cfg: TtsSettings = DEFAULTS;
  sampleRate = 44100;

  constructor(emit: (channel: string, payload: unknown) => void) {
    this.emit = emit;
  }

  setSettings(patch: Partial<TtsSettings>) {
    this.cfg = { ...this.cfg, ...patch };
  }

  get assetsDir() {
    return this.dir;
  }

  async status(): Promise<TtsStatus> {
    const inst = await A.installed(this.dir);
    return {
      installed: inst,
      bytesNeeded: inst ? 0 : await A.bytesNeeded(this.dir).catch(() => 0),
      ready: this.proc !== null,
      voice: this.cfg.voice,
      voices: A.VOICES,
    };
  }

  async install(): Promise<void> {
    this.emit("tts:state", { phase: "loading", message: "음성 자산을 받는 중" });
    try {
      await A.install(this.dir, (got, total) => this.emit("tts:progress", { got, total }));
      this.emit("tts:state", { phase: "idle" });
    } catch (e) {
      this.emit("tts:state", { phase: "error", message: (e as Error).message });
      throw e;
    }
  }

  /**
   * 첫 재생 요청에서 fork 한다. 앱 시작 때는 아무것도 하지 않는다 —
   * 낭독을 안 쓰는 사용자에게 424MB 를 물릴 이유가 없다(§4.3).
   */
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      /* 자식은 dist 안의 컴파일된 파일이다. `__dirname` 은 dist/main/tts. */
      const child = utilityProcess.fork(join(__dirname, "worker.js"), [], {
        serviceName: "parallax-tts",
        stdio: "ignore",
      });
      this.proc = child;

      child.on("message", (m: any) => {
        if (m.type === "ready") {
          this.sampleRate = m.sampleRate;
          this.emit("tts:state", { phase: "ready" });
          resolve();
          return;
        }
        /* 진행 보고는 답이 아니다 — 기다리는 쪽을 깨우지 않고 흘려보낸다. */
        if (m.type === "step") {
          this.steps.get(m.id)?.(m.done, m.total);
          return;
        }
        const w = m.id ? this.waiters.get(m.id) : undefined;
        if (!w) return;
        this.waiters.delete(m.id);
        this.steps.delete(m.id);
        if (m.type === "error") w.reject(new Error(m.message));
        else if (m.type === "cancelled") w.reject(Object.assign(new Error("취소"), { name: "Cancelled" }));
        else w.resolve(m);
      });

      child.on("exit", () => {
        this.proc = null;
        this.ready = null;
        for (const w of this.waiters.values()) w.reject(new Error("음성 프로세스가 종료됐습니다."));
        this.waiters.clear();
        this.emit("tts:state", { phase: "idle" });
      });

      this.emit("tts:state", { phase: "loading", message: "음성 준비 중" });
      child.postMessage({ type: "load", dir: this.dir });
      setTimeout(() => reject(new Error("음성 모델 로딩이 너무 오래 걸립니다.")), 60_000);
    });
    return this.ready;
  }

  private call<T>(msg: Record<string, unknown>, onStep?: (done: number, total: number) => void): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      if (onStep) this.steps.set(id, onStep);
      this.proc!.postMessage({ ...msg, id });
    });
  }

  /** 유휴 종료 — 424MB 를 안 쓰면서 들고 있을 이유가 없다. 로딩이 1초라 대가가 싸다. */
  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), this.cfg.idleExitSec * 1000);
  }

  async chunks(text: string, lang: Lang, first: boolean): Promise<string[]> {
    await this.start();
    this.touch();
    const r = await this.call<{ chunks: string[] }>({ type: "chunk", text, lang, first });
    return r.chunks;
  }

  async speak(text: string, lang: Lang, opt?: Partial<SpeakOpt>): Promise<{ wav: Uint8Array; seconds: number }> {
    await this.start();
    this.touch();
    return this.call({
      type: "speak", text, lang,
      opt: { style: this.cfg.voice, steps: this.cfg.steps, speed: this.cfg.speed, ...opt },
    });
  }

  /**
   * 청크 목록을 한 벌의 mp3 로. 합성과 인코딩이 모두 워커에서 끝난다 —
   * 30분 낭독이면 중간 PCM 이 150MB 라, 프로세스 경계를 넘기지 않는 편이 낫다.
   */
  async render(
    chunks: string[], lang: Lang, kbps: number,
    onStep?: (done: number, total: number) => void,
  ): Promise<{ mp3: Uint8Array; seconds: number }> {
    await this.start();
    this.touch();
    return this.call(
      {
        type: "render", chunks, lang, kbps,
        opt: { style: this.cfg.voice, steps: this.cfg.steps, speed: this.cfg.speed },
      },
      onStep,
    );
  }

  cancel() {
    this.proc?.postMessage({ type: "cancel" });
  }

  stop() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}
