import * as T from "../shared/types";
import { MERGE_SEP, isOverlongHeading, mergesWithNext } from "../shared/headings";

const HEAD_LEVEL: Record<string, number | undefined> = { h1: 1, h2: 2, h3: 3 };

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
 *
 * **머리글은 목차와 같은 규칙으로 단다**(`shared/headings`). 수사와 제목이 두
 * 블록으로 갈려 있으면 한 줄로 합치고(`# CHAPTER 1 · The Meaning of Meaning`),
 * 본문 한 문단이 제목으로 잘못 잡힌 것은 머리글에서 **문단으로 내린다.**
 * 목차는 그런 것을 감추지만 내보내는 글에서 감추면 글이 사라진다 — 태그만
 * 떼고 글은 남긴다. 그래서 리더의 목차와 내보낸 md 의 머리글이 같아진다.
 */
export function renderMarkdown(blocks: T.Block[], lang: "src" | "ko"): string {
  const out: string[] = [];
  const pick = (b: T.Block) => (lang === "ko" ? b.ko || b.src : b.src || "").trim();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.flags & T.DROPPED) continue;
    /* 그림의 src 는 asset id 다. md 는 텍스트 스냅샷이므로 그림 데이터는 싣지
       않고 자리만 남긴다 — 되찾을 곳은 .parallax 의 asset 테이블이다. */
    if (b.type === "figure") {
      out.push(`\n![그림](asset:${b.src})\n`);
      continue;
    }
    let text = pick(b);
    if (!text) continue;

    /* 제목으로 잡혔더라도 너무 길면 머리글을 달지 않는다 — 아래 분기에서
       그대로 문단이 된다. */
    const level = isOverlongHeading(b.src) ? undefined : HEAD_LEVEL[b.type];

    if (level !== undefined) {
      /* 바로 뒤(버린 블록은 건너뛴다)가 제목이면 합칠지 본다. 판정은 늘
         **원문**으로 한다 — 번역에서는 수사 꼴이 달라진다(「제1장」). */
      let j = i + 1;
      while (j < blocks.length && blocks[j].flags & T.DROPPED) j++;
      const nx = blocks[j];
      const nxLevel = nx ? HEAD_LEVEL[nx.type] : undefined;
      if (
        nx && nxLevel !== undefined &&
        mergesWithNext({ level, text: b.src }, { level: nxLevel, text: nx.src }, true)
      ) {
        const nt = pick(nx);
        if (nt) { text += MERGE_SEP + nt; i = j; }   // 제목은 흡수됐다
      }
    }

    if (level !== undefined) out.push(`\n${"#".repeat(level)} ${text}\n`);
    else if (b.type === "quote") out.push(`\n> ${text}\n`);
    else if (b.type === "footnote") out.push(`\n<sub>${text}</sub>\n`);
    else if (b.type === "figcaption") out.push(`\n*${text}*\n`);
    else out.push(`\n${text}\n`);
  }
  return out.join("").replace(/^\n/, "");
}
