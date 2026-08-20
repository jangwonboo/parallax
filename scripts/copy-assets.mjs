import { cp, mkdir, readdir, writeFile } from "node:fs/promises";

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
/* 낱말 난이도 표. 형광펜에 든 「어려운 낱말」을 고르는 데 쓴다.
   SCOWL 의 크기 등급(10·20·35 는 일상 어휘, 40 이상은 드문 것)을 그대로 쓴다.
   katex 와 같은 규칙이다 — 저장소에 데이터를 커밋하지 않고 빌드가 뽑는다.

   다섯 글자 미만은 버린다. 짧은 낱말은 어려워도 사전을 볼 만큼은 아니고,
   버리면 표가 절반으로 준다. 한 줄에 「등급 낱말」 하나씩 — JSON 보다 작고
   읽기도 빠르다. */
const BANDS = [10, 20, 35, 40, 50, 55, 60, 70];
const wl = (await import("wordlist-english")).default;
const level = new Map();
for (const b of BANDS) {
  for (const key of [`english/${b}`, `english/british/${b}`, `english/american/${b}`]) {
    for (const w of wl[key] || []) {
      const lw = w.toLowerCase();
      if (lw.length >= 5 && /^[a-z]+$/.test(lw) && !level.has(lw)) level.set(lw, b);
    }
  }
}
await mkdir("dist/main", { recursive: true });
const lines = [...level].map(([w, b]) => `${b} ${w}`).join("\n");
await writeFile("dist/main/wordlevels.txt", lines, "utf8");

console.log(`renderer assets copied (+ katex, ${fonts} woff2, ` +
            `낱말 ${level.size.toLocaleString()})`);
