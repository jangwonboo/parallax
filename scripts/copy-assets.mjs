import { cp, mkdir, readdir } from "node:fs/promises";

await mkdir("dist/renderer", { recursive: true });
await cp("src/renderer", "dist/renderer", { recursive: true });

/* KaTeX 를 함께 심는다. CSP 가 `script-src 'self'` 라 CDN 에서 못 받는다 —
   그리고 리더는 비행기에서도 열려야 한다.

   저장소에 바이너리를 커밋하지 않고 **빌드할 때 node_modules 에서 복사**한다.
   폰트는 woff2 만 가져간다(Chromium 은 그것만 요청한다) — woff·ttf 까지 넣으면
   1.2MB 가 되고 셋 다 쓰이지 않는다. katex.min.css 가 woff·ttf 도 가리키지만
   브라우저는 woff2 를 찾은 뒤 나머지를 요청하지 않는다. */
const KATEX = "node_modules/katex/dist";
await mkdir("dist/renderer/vendor/katex/fonts", { recursive: true });
for (const f of ["katex.min.js", "katex.min.css"]) {
  await cp(`${KATEX}/${f}`, `dist/renderer/vendor/katex/${f}`);
}
let fonts = 0;
for (const f of await readdir(`${KATEX}/fonts`)) {
  if (!f.endsWith(".woff2")) continue;
  await cp(`${KATEX}/fonts/${f}`, `dist/renderer/vendor/katex/fonts/${f}`);
  fonts++;
}
console.log(`renderer assets copied (+ katex, ${fonts} woff2)`);
