/* vendor/vlmparse → 스킬 안으로, 그리고 정본 zip 재포장.
 *
 * 왜 복사하는가. `vlmparse` 는 별도 저장소이고 여기에는 **git subtree** 로 들어와
 * 있다(`vendor/vlmparse`). 그런데 스킬은 zip 하나로 배포돼 **설치 단계가 없다** —
 * `findSidecar()` 가 폴더를 찾을 뿐이라 `pip install` 을 시킬 자리가 없다. 그래서
 * 패키지 사본을 `scripts/vlmparse/` 로 넣어 zip 이 자족하게 만든다. 스크립트는
 * 자기 폴더가 sys.path[0] 이므로 `import vlmparse` 가 그대로 걸린다.
 *
 *   node scripts/sync-vlmparse.mjs          사본만 갱신
 *   node scripts/sync-vlmparse.mjs --zip    zip 까지 다시 싼다
 *
 * 저장소를 오가는 것은 subtree 명령이다:
 *   git subtree pull --prefix=vendor/vlmparse <url> main --squash
 *   git subtree push --prefix=vendor/vlmparse <url> main
 */
import { cp, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SRC = "vendor/vlmparse/src/vlmparse";
const DST = "pdf2parallax/scripts/vlmparse";
const SKILL = "pdf2parallax";
const ZIP = "pdf2parallax.zip";

if (!existsSync(SRC)) {
  console.error(`${SRC} 가 없습니다 — subtree 가 붙어 있는지 보세요.`);
  process.exit(1);
}
if (!existsSync(SKILL)) {
  console.error(`${SKILL}/ 이 없습니다 — 정본 zip 을 먼저 풀어 두세요.`);
  process.exit(1);
}

await rm(DST, { recursive: true, force: true });
await cp(SRC, DST, { recursive: true });
/* __pycache__ 는 따라가면 안 된다 — 다른 파이썬 버전에서 못 읽는다 */
await rm(join(DST, "__pycache__"), { recursive: true, force: true });
await rm(join(DST, "backends", "__pycache__"), { recursive: true, force: true });

/** 스킬 폴더 아래 모든 `__pycache__` 경로. */
async function pycacheDirs(root) {
  const out = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = join(root, e.name);
    if (e.name === "__pycache__") out.push(full);
    else out.push(...(await pycacheDirs(full)));
  }
  return out;
}

const files = [];
for (const d of ["", "backends"]) {
  for (const f of await readdir(join(DST, d))) {
    const full = join(DST, d, f);
    if ((await stat(full)).isFile()) files.push(full);
  }
}
console.log(`vlmparse → ${DST} (${files.length} 파일)`);

if (process.argv.includes("--zip")) {
  /* 스크립트를 한 번이라도 돌리면 `scripts/__pycache__` 가 생기고, 그대로 싸면
     정본 zip 이 부풀며 다른 파이썬 버전에서 못 읽는 .pyc 가 배포된다
     (실측 2026-08-20: 146KB → 212KB, .pyc 세 개가 딸려 들어갔다).
     위에서 vlmparse 사본만 지우고 있었다 — 스킬 폴더 전체를 훑어야 한다. */
  for (const dir of await pycacheDirs(SKILL)) {
    await rm(dir, { recursive: true, force: true });
  }

  /* PowerShell 의 Compress-Archive 는 폴더 이름을 유지한다 — zip 안이
     `pdf2parallax/...` 여야 스킬 로더가 찾는다. */
  await rm(ZIP, { force: true });
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Compress-Archive -Path '${SKILL}' -DestinationPath '${ZIP}' -Force`],
    { stdio: "inherit" });
  console.log(`${ZIP} 재포장 완료`);
} else {
  console.log("zip 은 그대로입니다 — 다시 싸려면 --zip");
}
