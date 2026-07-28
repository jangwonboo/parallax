import * as T from "../shared/types";

const MD_HEAD: Record<string, string> = { h1: "# ", h2: "## ", h3: "### " };

/* 문서를 가리키는 이름 — 파일 이름은 원문으로 고정한다. 리더가 쓰는 규칙과
   같다. 번역 제목은 기계가 지은 이름이라 같은 책이 산출물마다 다른 이름으로
   불린다. */
export function docTitle(meta: T.DocMeta): string {
  return meta.title || "book";
}

/**
 * 한 언어짜리 Markdown. 내보내기는 영문·한글을 파일 하나씩 낸다 — 대역이
 * 필요하면 앱에서 읽으면 되고, 밖으로 가져가는 글은 한 언어로 읽는 글이다.
 *
 * 책 제목 머리글은 넣지 않는다 — 파일 이름이 곧 제목이고, 리더에서도 같은
 * 이유로 booktitle 영역을 없앴다. 본문은 문서의 첫 제목 블록에서 시작한다.
 *
 * 한글 쪽에서 번역이 없는 블록(원문 유지·판권면)은 원문을 그대로 쓴다.
 */
export function renderMarkdown(blocks: T.Block[], lang: "src" | "ko"): string {
  const out: string[] = [];
  for (const b of blocks) {
    const text = (lang === "ko" ? b.ko || b.src : b.src || "").trim();
    if (!text) continue;
    if (MD_HEAD[b.type]) out.push(`\n${MD_HEAD[b.type]}${text}\n`);
    else if (b.type === "quote") out.push(`\n> ${text}\n`);
    else if (b.type === "footnote") out.push(`\n<sub>${text}</sub>\n`);
    else if (b.type === "figcaption") out.push(`\n*${text}*\n`);
    else out.push(`\n${text}\n`);
  }
  return out.join("").replace(/^\n/, "");
}
