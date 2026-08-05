/**
 * Supertonic-3 자산을 고정 리비전으로 내려받는다 (spec-tts.md §3.3, T0).
 *
 *   node scripts/fetch-tts-assets.mjs [--dir <경로>] [--rev <해시>]
 *
 * 상류 저장소가 아카이브 예정이라 이 사본이 유일한 대비다(§11.2). `main` 이 아니라
 * 해시로 고정해 받는 이유는, 상류가 움직였을 때 조용히 다른 모델을 받는 것보다
 * 실패하는 편이 낫기 때문이다.
 *
 * 파이썬으로 받지 않는다 — 이 PC 는 파이썬만 전 HTTPS 호출이
 * CERTIFICATE_VERIFY_FAILED 로 죽는다(§9.1). Node 는 멀쩡하다.
 *
 * 앱의 다운로더(`src/main/tts/assets.ts`)가 같은 규칙을 쓴다 — 부분 파일은 `.part`
 * 로 받고 크기를 확인한 뒤에만 이름을 바꾼다. 끊긴 파일을 정상으로 오인하면
 * ONNX 로딩이 알 수 없는 이유로 실패한다.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";

const REPO = "Supertone/supertonic-3";
const REV = arg("--rev") ?? "3cadd1ee6394adea1bd021217a0e650ede09a323";
const DIR = arg("--dir") ?? join(process.cwd(), "tts-assets");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

const mb = (n) => (n / 1048576).toFixed(1) + "MB";

/** HF 트리 API — 파일 목록과 바이트 수를 준다. 검증은 크기 비교로 충분하다. */
async function tree(path) {
  const url = `https://huggingface.co/api/models/${REPO}/tree/${REV}/${path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`트리 조회 실패 ${path}: ${r.status} ${r.statusText}`);
  return (await r.json()).filter((e) => e.type === "file");
}

async function get(path, size) {
  const dest = join(DIR, path);
  try {
    if ((await stat(dest)).size === size) {
      console.log(`  건너뜀 ${path} (${mb(size)}, 이미 있음)`);
      return 0;
    }
  } catch { /* 없으면 받는다 */ }

  await mkdir(dirname(dest), { recursive: true });
  const url = `https://huggingface.co/${REPO}/resolve/${REV}/${path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${r.statusText}`);

  const part = dest + ".part";
  process.stdout.write(`  받는 중 ${path} (${mb(size)}) … `);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(part));

  const got = (await stat(part)).size;
  if (got !== size) throw new Error(`${path}: 크기가 다르다 — 받은 ${got}, 기대 ${size}`);
  await rename(part, dest);
  console.log("완료");
  return size;
}

const files = [...(await tree("onnx")), ...(await tree("voice_styles"))];
const total = files.reduce((s, f) => s + f.size, 0);
console.log(`${REPO} @ ${REV.slice(0, 12)}`);
console.log(`파일 ${files.length}개 · ${mb(total)} -> ${DIR}\n`);

let got = 0;
for (const f of files) got += await get(f.path, f.size);

await writeFile(join(DIR, "VERSION"), REV + "\n", "utf8");
console.log(`\n받은 양 ${mb(got)} · 전체 ${mb(total)} · VERSION 기록 완료`);
