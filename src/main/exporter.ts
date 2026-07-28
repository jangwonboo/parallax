import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as T from "../shared/types";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MD_HEAD: Record<string, string> = { h1: "# ", h2: "## ", h3: "### " };

/* 문서를 가리키는 이름 — 제목·목차·파일 이름은 원문으로 고정한다. 리더가 쓰는
   규칙과 같다. 번역 제목은 기계가 지은 이름이라 같은 책이 산출물마다 다른
   이름으로 불린다. 버리지는 않고 부제로 남긴다. */
export function docTitle(meta: T.DocMeta): string {
  return meta.title || "book";
}
const subtitle = (meta: T.DocMeta) =>
  meta.title_ko && meta.title_ko !== meta.title ? meta.title_ko : "";

export function renderMarkdown(meta: T.DocMeta, blocks: T.Block[]): string {
  const out = [`# ${docTitle(meta)}\n`];
  const sub = subtitle(meta);
  if (sub) out.push(`*${sub}*\n`);
  if (meta.author) out.push(`*${meta.author}*\n`);
  for (const b of blocks) {
    const text = (b.ko || b.src || "").trim();
    if (!text) continue;
    if (MD_HEAD[b.type]) out.push(`\n${MD_HEAD[b.type]}${text}\n`);
    else if (b.type === "quote") out.push(`\n> ${text}\n`);
    else if (b.type === "footnote") out.push(`\n<sub>${text}</sub>\n`);
    else if (b.type === "figcaption") out.push(`\n*${text}*\n`);
    else out.push(`\n${text}\n`);
  }
  return out.join("");
}

function slug(text: string, n: number): string {
  const s = text.toLowerCase().replace(/[^\w가-힣]+/g, "-").replace(/^-|-$/g, "");
  return s ? `${s.slice(0, 40)}-${n}` : `sec-${n}`;
}

/** 자립형 병렬 대역 HTML. 리더와 같은 조판을 쓰되 앱 기능(사전·스케줄러)은 빠진다. */
export function renderHtml(meta: T.DocMeta, blocks: T.Block[]): string {
  const css = readFileSync(join(__dirname, "../renderer/reader.css"), "utf8");
  const rows: string[] = [];
  const toc: string[] = [];
  let n = 0;

  for (const b of blocks) {
    const ko = (b.ko || "").trim();
    const src = (b.src || "").trim();
    if (!ko && !src) continue;
    let tag = "p";
    let anchor = "";
    let cls = "";
    if (b.type === "h1" || b.type === "h2" || b.type === "h3") {
      /* 목차도 원문이다 — 리더와 같은 규칙(db.ts 의 outline 이 src 를 낸다). */
      const aid = slug(src || ko, ++n);
      anchor = ` id="${aid}"`;
      toc.push(`<a href="#${aid}" data-level="${b.type[1]}">${esc(src || ko)}</a>`);
      tag = b.type;
    } else if (b.type === "quote") tag = "blockquote";
    else if (b.type === "footnote" || b.type === "figcaption") cls = ` class="${b.type}"`;

    const srcCls = "cell src" + (b.flags & T.FROM_OCR ? " read" : "");
    const koCls = "cell ko" + (b.flags & T.NEEDS_REVIEW ? " review" : "");
    rows.push(
      `<div class="row row-${b.type}" data-id="${b.id}">` +
        `<div class="${srcCls}"><${tag}${anchor}${cls}>${esc(src)}</${tag}></div>` +
        `<div class="${koCls}"><${tag}${cls}>${esc(ko)}</${tag}></div></div>`
    );
  }

  const title = esc(docTitle(meta));
  const sub = subtitle(meta);
  return `<!doctype html>
<html lang="ko" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/sun-typeface/SUIT@2.0.5/fonts/variable/woff2/SUIT-Variable.css">
<style>
${css}
.doc { padding-top: 1.5rem; }
.booksub { margin: -1.8rem 0 2.4rem; color: var(--ink-soft);
           font-family: var(--font-ui); font-size: var(--ui-size); }
</style>
</head>
<body>
<nav class="toc" id="toc" data-open="false">${toc.join("\n") || "<p>목차 없음</p>"}</nav>
<main class="doc" id="doc">
  <h1 class="booktitle">${title}</h1>
${sub ? `  <p class="booksub">${esc(sub)}</p>\n` : ""}${rows.join("\n")}
</main>
</body>
</html>`;
}
