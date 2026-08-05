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
 *
 * DROPPED 는 뺀다. 그건 러닝 헤드·쪽 번호이거나 도판 안에서 뜯겨 나온 글자
 * 조각(`ZINZINZINZ`, `temporal fovea nasal eccentricity (degrees)`)이라 애초에
 * 읽을 글이 아니다. 리더는 원문 칸에 그대로 두지만 — 쪽을 대조할 때 필요하다 —
 * 밖으로 가져가는 글에는 자리가 없다. NO_TRANSLATE(색인·참고문헌)는 남긴다.
 */
export function renderMarkdown(blocks: T.Block[], lang: "src" | "ko"): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.flags & T.DROPPED) continue;
    /* 그림의 src 는 asset id 다. md 는 텍스트 스냅샷이므로 그림 데이터는 싣지
       않고 자리만 남긴다 — 되찾을 곳은 .parallax 의 asset 테이블이다. */
    if (b.type === "figure") {
      out.push(`\n![그림](asset:${b.src})\n`);
      continue;
    }
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
