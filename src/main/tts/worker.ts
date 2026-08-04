/**
 * TTS 자식 프로세스. `utilityProcess.fork()` 로 뜬다.
 *
 * main 에서 직접 돌리면 안 되는 이유(spec-tts.md §4.1): ONNX 의 `session.run()` 은
 * 네이티브 스레드풀로 빠지지만 그 앞뒤 JS 는 호출한 스레드에서 돈다 — 정규난수
 * latentDim×latentLen 개 생성, 44.1kHz 오디오의 16-bit 변환(1초당 44,100회).
 * 10초 문장이면 마지막 것만으로 441,000회다. main 에서 돌리면 재생 중에 툴바도
 * 스크롤도 번역 반영도 멈춘다.
 *
 * `worker_threads` 가 아니라 `utilityProcess` 인 것은 크래시 격리(세션이 죽어도
 * 낭독만 죽는다)와 메모리 분리(424MB 가 main 의 힙 밖에 있다) 때문이다.
 *
 * 부모와는 `parentPort` 로만 말한다. stdout 은 쓰지 않는다 — 상류 코드의
 * `console.log` 를 지운 이유가 이것이다.
 */
import { Synth, wavBuffer, Cancelled, type Lang, type SpeakOpt } from "./synth";

type In =
  | { type: "load"; dir: string }
  | { type: "speak"; id: string; text: string; lang: Lang; opt: SpeakOpt }
  | { type: "cancel" }
  | { type: "chunk"; text: string; lang: Lang; first: boolean; id: string }
  | { type: "render"; id: string; chunks: string[]; lang: Lang; opt: SpeakOpt; kbps: number };

type Out =
  | { type: "ready"; sampleRate: number }
  | { type: "chunks"; id: string; chunks: string[] }
  | { type: "wav"; id: string; wav: Uint8Array; seconds: number }
  | { type: "step"; id: string; done: number; total: number }
  | { type: "mp3"; id: string; mp3: Uint8Array; seconds: number }
  | { type: "cancelled"; id: string }
  | { type: "error"; id?: string; message: string };

const port = process.parentPort;
let synth: Synth | null = null;

const send = (m: Out) => port.postMessage(m);

/**
 * lamejs 는 ESM 전용이다(`exports.require` 로 걸린 IIFE 번들은 module.exports 에
 * 아무것도 싣지 않는다). tsc 가 CommonJS 로 내리면서 `await import()` 를
 * `require()` 로 바꿔 버리므로, 문자열로 감싸 그 변환을 피한다.
 */
const importESM = new Function("s", "return import(s)") as (s: string) => Promise<any>;
let Mp3Encoder: any = null;

async function encodeMp3(pcm: Float32Array, sampleRate: number, kbps: number): Promise<Uint8Array> {
  Mp3Encoder ??= (await importESM("@breezystack/lamejs")).Mp3Encoder;
  const enc = new Mp3Encoder(1, sampleRate, kbps);
  const parts: Uint8Array[] = [];
  /* 한 번에 다 넘기면 인코더가 그 크기의 배열을 통째로 잡는다. 1152 의 배수로
     끊어 넣는다 — MP3 프레임 하나가 1152 표본이다. */
  const STEP = 1152 * 64;
  const buf = new Int16Array(Math.min(STEP, pcm.length));
  for (let off = 0; off < pcm.length; off += STEP) {
    const n = Math.min(STEP, pcm.length - off);
    const view = n === buf.length ? buf : buf.subarray(0, n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, pcm[off + i]));
      view[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const b = enc.encodeBuffer(view);
    if (b.length) parts.push(new Uint8Array(b));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

port.on("message", async (e) => {
  const msg = e.data as In;
  try {
    switch (msg.type) {
      case "load":
        synth = new Synth(msg.dir);
        await synth.load();
        send({ type: "ready", sampleRate: synth.sampleRate });
        break;

      case "chunk":
        if (!synth) throw new Error("모델이 아직 올라오지 않았습니다.");
        send({ type: "chunks", id: msg.id, chunks: synth.chunk(msg.text, msg.lang, msg.first) });
        break;

      case "speak": {
        if (!synth) throw new Error("모델이 아직 올라오지 않았습니다.");
        const audio = await synth.speak(msg.text, msg.lang, msg.opt);
        const buf = wavBuffer(audio, synth.sampleRate);
        send({
          type: "wav",
          id: msg.id,
          wav: new Uint8Array(buf),
          seconds: audio.length / synth.sampleRate,
        });
        break;
      }

      /* 내보내기 — 청크를 차례로 합성해 이어 붙이고 mp3 로 만든다. 통째로 워커에서
         하는 이유는 오디오가 크기 때문이다: 30분이면 PCM 이 150MB 라, 합성과 인코딩을
         나누면 그 덩어리가 프로세스 경계를 왕복한다. */
      case "render": {
        if (!synth) throw new Error("모델이 아직 올라오지 않았습니다.");
        const parts: Float32Array[] = [];
        let n = 0;
        for (let i = 0; i < msg.chunks.length; i++) {
          const a = await synth.speak(msg.chunks[i], msg.lang, msg.opt);
          parts.push(a); n += a.length;
          send({ type: "step", id: msg.id, done: i + 1, total: msg.chunks.length });
        }
        const pcm = new Float32Array(n);
        let at = 0;
        for (const p of parts) { pcm.set(p, at); at += p.length; }
        const mp3 = await encodeMp3(pcm, synth.sampleRate, msg.kbps);
        send({ type: "mp3", id: msg.id, mp3, seconds: n / synth.sampleRate });
        break;
      }

      case "cancel":
        synth?.cancel();
        break;
    }
  } catch (err) {
    const id = "id" in msg ? msg.id : undefined;
    if (err instanceof Cancelled) send({ type: "cancelled", id: id ?? "" });
    else send({ type: "error", id, message: (err as Error).message });
  }
});
