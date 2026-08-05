/**
 * Supertonic 3 합성기 — `vendor/supertonic-nodejs/helper.js`(MIT, 7e2804f) 이식.
 * spec-tts.md §5.4 가 열거한 것을 고쳐 옮겼다.
 *
 * 상류는 npm 패키지가 아니라 예제 프로젝트라(`"name": "tts-onnx-nodejs"`) 베껴 오는
 * 것 외에 선택지가 없었다. 상류가 아카이브 예정이므로 갱신할 상류도 없다 — 부채가
 * 아니라 사실상의 동결이다. 원본은 `vendor/` 에 그대로 있다.
 *
 * 고친 것:
 * - 잠재 벡터를 3중 중첩 배열이 아니라 평평한 Float32Array 로 든다. 상류는 스텝마다
 *   `array.flat(Infinity)` 로 다시 펴는데, 10초 문장이면 스텝당 수십만 요소다.
 * - 보코더 출력을 `Array.from` 으로 일반 배열에 담지 않는다(§5.4).
 * - `console.log` 제거 — utilityProcess 의 stdout 을 오염시킨다.
 * - `vector_estimator` 반복 사이에 취소 지점(§7.3).
 * - `batch()`·GPU 경로 삭제 — 우리는 언제나 단일 화자·단일 문장이다.
 * - 파일로 쓰는 `writeWavFile` 대신 메모리 버퍼를 내는 `wavBuffer`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-node";

export type Lang = "ko" | "en";

export interface SpeakOpt {
  style: string;   // "F1" 같은 보이스 이름
  steps: number;   // 5~12. 지연과 품질의 유일한 손잡이, 비용은 선형
  speed: number;   // 0.7~2.0
}

/** 사용자가 중간에 멈춘 것. 실패와 구분해야 오류로 보고하지 않는다. */
export class Cancelled extends Error {
  constructor() {
    super("취소했습니다.");
    this.name = "Cancelled";
  }
}

const LANGS = new Set([
  "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr",
  "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk",
  "sl", "sv", "tr", "uk", "vi", "na",
]);

const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;

const SUBST: Record<string, string> = {
  "–": "-", "‑": "-", "—": "-", "_": " ",
  "“": '"', "”": '"', "‘": "'", "’": "'",
  "´": "'", "`": "'", "[": " ", "]": " ", "|": " ", "/": " ", "#": " ",
  "→": " ", "←": " ",
};

/* 텍스트 → 유니코드 인덱스. g2p 도 espeak 도 사전도 없다 — 코드포인트를 곧장
   먹인다. 언어별 외부 의존이 0이라는 뜻이고, 이 모델을 붙일 만하게 만드는
   성질이다(spec-tts.md §5.1). */
class UnicodeProcessor {
  private indexer: Record<string, number>;

  constructor(dir: string) {
    this.indexer = JSON.parse(readFileSync(join(dir, "unicode_indexer.json"), "utf8"));
  }

  private pre(text: string, lang: Lang): string {
    let t = text.normalize("NFKD").replace(EMOJI, "");
    for (const [k, v] of Object.entries(SUBST)) t = t.replaceAll(k, v);
    t = t.replace(/[♥☆♡©\\]/g, "");
    t = t.replaceAll("@", " at ").replaceAll("e.g.,", "for example, ")
         .replaceAll("i.e.,", "that is, ");
    t = t.replace(/ ([,.!?;:'])/g, "$1");
    while (t.includes('""')) t = t.replace('""', '"');
    while (t.includes("''")) t = t.replace("''", "'");
    t = t.replace(/\s+/g, " ").trim();
    // 문장부호로 끝나지 않으면 마침표를 붙인다 — 없으면 끝을 흐리게 읽는다
    if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(t)) t += ".";
    if (!LANGS.has(lang)) throw new Error(`지원하지 않는 언어: ${lang}`);
    return `<${lang}>${t}</${lang}>`;
  }

  /** 단일 문장 전용. 배치가 없으므로 패딩도 없다. */
  call(text: string, lang: Lang): { ids: BigInt64Array; len: number } {
    const t = this.pre(text, lang);
    const ids = new BigInt64Array(t.length);
    for (let i = 0; i < t.length; i++) {
      ids[i] = BigInt(this.indexer[String(t.charCodeAt(i))] ?? 0);
    }
    return { ids, len: t.length };
  }
}

/**
 * 문단 → 문장 → maxLen 이내로 다시 묶는다. 상류 `chunkText` 를 그대로 옮겼다.
 *
 * 자체 문장 분할기를 쓰지 않는 이유: 상류의 `call()` 도 내부적으로 이걸로 자른 뒤
 * 청크마다 따로 합성하고 0.3초 무음으로 잇는다. 같은 분할을 쓰면 **스트리밍이
 * 음질을 깎지 않는다** — 어차피 상류도 문장을 따로 합성하기 때문이다(§5.2).
 *
 * 이 함수는 상류에서 export 되지 않는 내부 함수라 함께 베껴 왔다.
 */
export function chunkText(text: string, maxLen: number): string[] {
  const out: string[] = [];
  for (const para of text.trim().split(/\n\s*\n+/)) {
    const p = para.trim();
    if (!p) continue;
    const sentences = p.split(
      /(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/
    );
    let cur = "";
    for (const s of sentences) {
      if (cur.length + s.length + 1 <= maxLen) cur += (cur ? " " : "") + s;
      else {
        if (cur) out.push(cur.trim());
        cur = s;
      }
    }
    if (cur) out.push(cur.trim());
  }
  return out;
}

/** 한국어는 120자, 나머지는 300자. 첫 청크만 절반으로 낮춰 소리를 먼저 낸다(§5.2). */
export const maxLenFor = (lang: Lang, first: boolean) =>
  lang === "ko" ? (first ? 60 : 120) : (first ? 150 : 300);

interface Cfgs {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { chunk_compress_factor: number; latent_dim: number };
}

export class Synth {
  private dir: string;
  private cfgs!: Cfgs;
  private proc!: UnicodeProcessor;
  private dp!: ort.InferenceSession;
  private enc!: ort.InferenceSession;
  private est!: ort.InferenceSession;
  private voc!: ort.InferenceSession;
  private styles = new Map<string, { ttl: ort.Tensor; dp: ort.Tensor }>();
  private cancelled = false;
  sampleRate = 44100;

  constructor(dir: string) {
    this.dir = dir;
  }

  async load(): Promise<void> {
    const onnx = join(this.dir, "onnx");
    this.cfgs = JSON.parse(readFileSync(join(onnx, "tts.json"), "utf8"));
    this.sampleRate = this.cfgs.ae.sample_rate;
    this.proc = new UnicodeProcessor(onnx);
    const make = (f: string) => ort.InferenceSession.create(join(onnx, f));
    [this.dp, this.enc, this.est, this.voc] = await Promise.all([
      make("duration_predictor.onnx"), make("text_encoder.onnx"),
      make("vector_estimator.onnx"), make("vocoder.onnx"),
    ]);
  }

  chunk(text: string, lang: Lang, first: boolean): string[] {
    return chunkText(text, maxLenFor(lang, first));
  }

  private style(name: string) {
    let s = this.styles.get(name);
    if (s) return s;
    const raw = JSON.parse(
      readFileSync(join(this.dir, "voice_styles", `${name}.json`), "utf8"));
    const mk = (o: { dims: number[]; data: number[] }) =>
      new ort.Tensor("float32", Float32Array.from(o.data.flat(Infinity)), o.dims);
    s = { ttl: mk(raw.style_ttl), dp: mk(raw.style_dp) };
    this.styles.set(name, s);
    return s;
  }

  cancel(): void {
    this.cancelled = true;
  }

  private check(): void {
    if (this.cancelled) throw new Cancelled();
  }

  /**
   * 한 청크를 합성한다. 배치가 없으므로 bsz 는 언제나 1이고, 그 덕에 상류의
   * 3중 중첩 배열이 전부 평평한 typed array 로 접힌다.
   */
  async speak(text: string, lang: Lang, opt: SpeakOpt): Promise<Float32Array> {
    this.cancelled = false;
    const style = this.style(opt.style);
    const { ids, len } = this.proc.call(text, lang);

    const textIds = new ort.Tensor("int64", ids, [1, len]);
    const textMask = new ort.Tensor("float32", new Float32Array(len).fill(1), [1, 1, len]);

    const dpOut = await this.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    const duration = (dpOut.duration.data as Float32Array)[0] / opt.speed;
    this.check();

    const encOut = await this.enc.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
    const textEmb = encOut.text_emb;
    this.check();

    // 잠재 벡터 — [1, latentDim, latentLen] 을 평평하게 든다
    const chunkSize = this.cfgs.ae.base_chunk_size * this.cfgs.ttl.chunk_compress_factor;
    const wavLen = Math.floor(duration * this.sampleRate);
    const latentLen = Math.floor((duration * this.sampleRate + chunkSize - 1) / chunkSize);
    const latentDim = this.cfgs.ttl.latent_dim * this.cfgs.ttl.chunk_compress_factor;
    const validLen = Math.floor((wavLen + chunkSize - 1) / chunkSize);

    const mask = new Float32Array(latentLen);
    mask.fill(1, 0, Math.min(validLen, latentLen));
    const latentMask = new ort.Tensor("float32", mask, [1, 1, latentLen]);

    // ORT 가 돌려주는 버퍼는 `ArrayBufferLike` 라 기본 `Float32Array` 에 못 담는다.
    // 스텝마다 복사하지 않으려면 넓은 쪽으로 선언해야 한다.
    let latent: Float32Array<ArrayBufferLike> = new Float32Array(latentDim * latentLen);
    for (let d = 0; d < latentDim; d++) {
      const row = d * latentLen;
      for (let t = 0; t < latentLen; t++) {
        // Box-Muller. eps 를 두는 것은 log(0) 을 피하기 위함이다.
        const u1 = Math.max(1e-10, Math.random());
        const u2 = Math.random();
        latent[row + t] =
          Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * mask[t];
      }
    }

    const latentShape = [1, latentDim, latentLen];
    const totalStep = new ort.Tensor("float32", Float32Array.from([opt.steps]), [1]);

    for (let step = 0; step < opt.steps; step++) {
      this.check();   // 스텝 하나가 취소의 최소 단위다 (§7.3)
      const out = await this.est.run({
        noisy_latent: new ort.Tensor("float32", latent, latentShape),
        text_emb: textEmb,
        style_ttl: style.ttl,
        text_mask: textMask,
        latent_mask: latentMask,
        total_step: totalStep,
        current_step: new ort.Tensor("float32", Float32Array.from([step]), [1]),
      });
      latent = out.denoised_latent.data as Float32Array;
    }

    this.check();
    const vocOut = await this.voc.run({
      latent: new ort.Tensor("float32", latent, latentShape),
    });
    const wav = vocOut.wav_tts.data as Float32Array;
    // 보코더는 잠재 길이에 맞춰 내므로 실제 발화보다 길다. duration 으로 자른다.
    return wav.length > wavLen ? wav.subarray(0, wavLen) : wav;
  }

  dispose(): void {
    this.styles.clear();
  }
}

/**
 * float32 오디오 → 16-bit PCM WAV 버퍼.
 *
 * 상류 `writeWavFile` 의 헤더 생성부만 떼어 냈다. 우리는 파일이 아니라 렌더러로
 * 보낼 메모리 버퍼가 필요하다(§5.4).
 */
export function wavBuffer(audio: Float32Array, sampleRate: number): Buffer {
  const dataSize = audio.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < audio.length; i++) {
    const s = Math.max(-1, Math.min(1, audio[i]));
    buf.writeInt16LE(Math.floor(s * 32767), 44 + i * 2);
  }
  return buf;
}
