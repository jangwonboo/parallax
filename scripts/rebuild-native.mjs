// better-sqlite3 를 Electron ABI 에 맞춥니다.
// 미리 빌드된 바이너리를 먼저 받고, 없을 때만 소스에서 컴파일합니다.
// 두 방법이 모두 실패해도 설치 자체는 막지 않습니다.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// node 는 그대로 실행합니다 — 경로에 공백이 있으면 셸이 잘라먹습니다.
// electron-rebuild 는 Windows 에서 .cmd 라 셸이 필요합니다.
const run = (cmd, args, { cwd, shell = false } = {}) =>
  spawnSync(cmd, args, { cwd, stdio: "inherit", shell }).status === 0;

const sqlite = "node_modules/better-sqlite3";
if (!existsSync(sqlite)) {
  console.log("better-sqlite3 가 없어 재빌드를 건너뜁니다.");
  process.exit(0);
}

const electron = JSON.parse(await readFile("node_modules/electron/package.json", "utf8")).version;

const prebuilt = run(
  process.execPath,
  ["../prebuild-install/bin.js", "-r", "electron", "-t", electron, "--tag-prefix", "v"],
  { cwd: sqlite },
);
if (prebuilt) {
  console.log(`better-sqlite3 — Electron ${electron} 용 미리 빌드된 바이너리를 받았습니다.`);
  process.exit(0);
}

console.log("미리 빌드된 바이너리가 없어 소스에서 컴파일합니다.");
if (run("electron-rebuild", ["-f", "-w", "better-sqlite3"], { shell: process.platform === "win32" }))
  process.exit(0);

console.log(
  "네이티브 모듈 재빌드 실패 — npm run rebuild 를 수동 실행하세요.\n" +
    "Windows 라면 Visual Studio Build Tools 의 'C++ 데스크톱 개발' 워크로드가 필요합니다.",
);
