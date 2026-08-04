/**
 * Supertonic 자산 관리 — 있는지 보고, 없으면 받는다 (spec-tts.md §3).
 *
 * 설치본에 동봉하지 않는다. 설치본이 383MB 커지고, 모델 가중치는 OpenRAIL-M 이라
 * 동봉해 배포하면 사용제한 조항을 함께 실어야 한다. 받아 쓰면 그 관계가 사용자와
 * Supertone 사이에 남는다.
 *
 * 리비전을 `main` 이 아니라 해시로 고정한다. 상류가 아카이브 예정이라 `main` 이
 * 움직일 일은 없지만, 움직였을 때 조용히 다른 모델을 받는 것보다 실패하는 편이 낫다.
 *
 * 파이썬이 아니라 Node 가 받는다 — 이 PC 는 파이썬만 전 HTTPS 호출이
 * CERTIFICATE_VERIFY_FAILED 로 죽는다(§9.1). `scripts/fetch-tts-assets.mjs` 와
 * 같은 규칙이다: `.part` 로 받고 크기를 확인한 뒤에만 이름을 바꾼다. 끊긴 파일을
 * 정상으로 오인하면 ONNX 로딩이 알 수 없는 이유로 실패한다.
 */
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";

const REPO = "Supertone/supertonic-3";
export const REV = "3cadd1ee6394adea1bd021217a0e650ede09a323";

const ONNX = [
  "duration_predictor.onnx", "text_encoder.onnx", "vector_estimator.onnx",
  "vocoder.onnx", "unicode_indexer.json", "tts.json",
];
export const VOICES = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];

const paths = (dir: string) => [
  ...ONNX.map((f) => join(dir, "onnx", f)),
  ...VOICES.map((v) => join(dir, "voice_styles", `${v}.json`)),
];

/** 자산이 다 있고 리비전이 맞나. 크기까지는 보지 않는다 — 받을 때 이미 확인했다. */
export async function installed(dir: string): Promise<boolean> {
  if (!paths(dir).every(existsSync)) return false;
  try {
    return (await readFile(join(dir, "VERSION"), "utf8")).trim() === REV;
  } catch {
    return false;
  }
}

interface Entry { path: string; size: number }

async function tree(sub: string): Promise<Entry[]> {
  const r = await fetch(`https://huggingface.co/api/models/${REPO}/tree/${REV}/${sub}`);
  if (!r.ok) throw new Error(`자산 목록을 받지 못했습니다 (${r.status})`);
  return (await r.json()).filter((e: { type: string }) => e.type === "file");
}

export async function bytesNeeded(dir: string): Promise<number> {
  if (await installed(dir)) return 0;
  const files = [...(await tree("onnx")), ...(await tree("voice_styles"))];
  return files.reduce((s, f) => s + f.size, 0);
}

/** 383MB 는 진행 표시 없이 기다리게 할 분량이 아니다. `import:progress` 와 같은 방식. */
export async function install(
  dir: string,
  onProgress: (got: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const files = [...(await tree("onnx")), ...(await tree("voice_styles"))];
  const total = files.reduce((s, f) => s + f.size, 0);
  let got = 0;

  for (const f of files) {
    const dest = join(dir, f.path);
    try {
      if ((await stat(dest)).size === f.size) {
        got += f.size;
        onProgress(got, total);
        continue;
      }
    } catch { /* 없으면 받는다 */ }

    await mkdir(dirname(dest), { recursive: true });
    const r = await fetch(`https://huggingface.co/${REPO}/resolve/${REV}/${f.path}`, { signal });
    if (!r.ok || !r.body) throw new Error(`${f.path}: ${r.status}`);

    const part = dest + ".part";
    let seen = 0;
    const body = Readable.fromWeb(r.body as any);
    body.on("data", (c: Buffer) => {
      seen += c.length;
      onProgress(got + seen, total);
    });
    await pipeline(body, createWriteStream(part));

    const size = (await stat(part)).size;
    if (size !== f.size) throw new Error(`${f.path}: 크기가 다릅니다 (${size} ≠ ${f.size})`);
    await rename(part, dest);
    got += f.size;
    onProgress(got, total);
  }

  await writeFile(join(dir, "VERSION"), REV + "\n", "utf8");
}
