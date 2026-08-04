#!/usr/bin/env node
/**
 * `electron-builder` 가 시작할 때 지우는 `release/win-unpacked` 를 미리 비운다.
 *
 * 왜 필요한가 — 이 PC 에서는 빌드가 새 `app.asar` 을 만드는 순간 explorer 가 asar
 * 뷰어를 띄우고(부모가 explorer.exe 인 것을 확인했다), 그 프로세스가 파일을 문 채
 * 남는다. 다음 빌드는 폴더를 못 지우고 죽는다:
 *
 *     ⨯ remove …\release\win-unpacked\resources\app.asar:
 *       The process cannot access the file because it is being used by another process.
 *
 * 오류 문구에 누가 물고 있는지가 없어서, 손으로 고치려면 매번 Restart Manager 를
 * 두드려야 했다. 빌드가 스스로 풀게 한다.
 *
 * **닫는 범위는 좁다.** Restart Manager 가 「우리 빌드 산출물을 물고 있다」고 지목한
 * 프로세스만 닫는다. 이름으로 짐작하지 않으므로 상관없는 앱을 건드릴 일이 없고,
 * 무엇을 닫았는지 반드시 찍는다 — 조용히 남의 창을 닫는 도구는 못 믿는다.
 */
import { rmSync, existsSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "release", "win-unpacked");
const asar = join(outDir, "resources", "app.asar");

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function tryRemove() {
  if (!existsSync(outDir)) return true;
  try {
    rmSync(outDir, { recursive: true, force: true });
    return !existsSync(outDir);
  } catch {
    return false;
  }
}

/* Restart Manager 는 **파일만** 받는다. 디렉터리를 섞어 넘기면 등록이 조용히
   실패하고 목록이 통째로 비어 나온다 — 잠긴 것이 뻔한데 「못 찾았다」가 된다.
   그래서 실제 파일을 모아 넘긴다. 전부 넘길 필요는 없다: 한 프로세스가 폴더 안
   무엇이든 하나만 물고 있어도 지우기는 실패하고, RM 은 그 하나로 프로세스를
   지목한다. 개수를 묶는 것은 명령줄 길이 때문이다. */
const MAX_PROBE = 60;

function probeFiles(dir, out = []) {
  if (out.length >= MAX_PROBE) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_PROBE) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) probeFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** 산출물을 물고 있는 프로세스 [{pid, name}]. Windows 밖에서는 빈 배열. */
function holders() {
  if (process.platform !== "win32") return [];
  const files = [...new Set([existsSync(asar) ? asar : null, ...probeFiles(outDir)]
    .filter(Boolean).map((f) => resolve(f)))];
  if (!files.length) return [];
  /* 목록은 파일로 넘긴다 — `-File` 로 부른 스크립트에 배열 인자를 주면 PowerShell 이
     첫 하나만 묶고 나머지를 위치 인자로 흘려 죽는다. */
  const listFile = join(mkdtempSync(join(tmpdir(), "parallax-lock-")), "paths.txt");
  writeFileSync(listFile, files.join("\n"), "utf8");
  const ps = spawnSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", join(root, "scripts", "who-locks.ps1"),
    "-PathsFile", listFile,
  ], { encoding: "utf8" });
  if (ps.status !== 0 && ps.stderr) console.error(ps.stderr.trim().split("\n")[0]);
  return (ps.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid, ...rest] = l.split("\t");
      return { pid: Number(pid), name: rest.join(" ") || "(이름 없음)" };
    })
    .filter((h) => Number.isFinite(h.pid) && h.pid !== process.pid);
}

/* 몇 번은 그냥 기다려 본다 — 바이러스 검사나 인덱서가 잠깐 잡은 것이면 저절로 풀린다. */
for (let i = 0; i < 6; i++) {
  if (tryRemove()) process.exit(0);
  sleep(400);
}

const held = holders();
if (!held.length) {
  console.error("release/win-unpacked 를 지우지 못했는데 무엇이 물고 있는지 알 수 없습니다.");
  console.error("폴더를 연 탐색기 창이나 편집기를 닫고 다시 시도하세요.");
  process.exit(1);
}

for (const h of held) {
  console.log(`빌드 산출물을 물고 있어 닫습니다: ${h.name} (pid ${h.pid})`);
  spawnSync("taskkill", ["/F", "/T", "/PID", String(h.pid)], { stdio: "ignore" });
}
sleep(600);

if (tryRemove()) process.exit(0);

console.error("닫은 뒤에도 release/win-unpacked 가 지워지지 않습니다:",
  held.map((h) => `${h.name}(${h.pid})`).join(", "));
process.exit(1);
