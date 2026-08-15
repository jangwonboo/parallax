/* 제목 다듬기 — 목차(`main/db.ts` 의 `Doc.outline`)와 Markdown 내보내기
   (`main/exporter.ts`)가 **같은 규칙**을 쓴다.

   두 벌로 두면 반드시 어긋난다. 이 저장소는 스키마를 `spec.md` 와 스킬에
   이중으로 적어 두고 그 값을 이미 치르고 있다 — 여기서는 되풀이하지 않는다.

   블록은 건드리지 않는다. 목차 목록과 내보낸 글의 **머리글 태그**만 손본다. */

/** 이보다 긴 것은 제목이 아니라 본문이다.
 *
 *  구조 인식이 본문 한 문단을 제목으로 잘못 잡는 일이 있다(실측: 한 책에
 *  129자짜리 문단이 h2 로 들어와 목차에 통째로 박혀 있었다). 네 책의 진짜
 *  제목 최장은 95자(signals)라 120 이면 진짜를 먹지 않는다. */
export const MAX_HEADING = 120;

export function isOverlongHeading(text: string): boolean {
  return text.trim().length > MAX_HEADING;
}

/** 수사와 제목을 한 줄로 붙일 때 쓰는 구분자. */
export const MERGE_SEP = " · ";

const ORDINAL =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|" +
  "fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty";
const LABEL_EN = new RegExp(
  `^(chapter|part|book|section|appendix)\\s+([0-9]{1,3}|[ivxlcdm]{1,6}|${ORDINAL})[.:]?$`,
  "i"
);
const LABEL_KO = /^제?\s*[0-9]{1,3}\s*[장부편]$/;

/** 「CHAPTER 1」·「PART ONE」·「제3장」처럼 **수사뿐**인 제목인가.
 *
 *  끝을 물린 것(`$`)이 중요하다. 「Part I — Foundational Marketing Signals」
 *  처럼 수사와 제목이 이미 한 줄에 있는 것은 합칠 것이 없으므로 걸리면 안 된다.
 *
 *  번호가 붙은 것만 본다. 「INTRODUCTION」·「CONCLUSION」 같은 맨 수사는
 *  일부러 뺐다 — 뒤따르는 것이 그 부의 제목인지 첫 절인지 데이터로 구분되지
 *  않는다(실측: INTRODUCTION 다음의 「Unheimlich」는 제목이 아니라 첫 절로
 *  보인다). 잘못 합치면 절 하나가 목차에서 사라진다. */
export function isNumberedLabel(text: string): boolean {
  const t = text.trim();
  return LABEL_EN.test(t) || LABEL_KO.test(t);
}

/**
 * 수사 블록과 **바로 뒤** 제목을 한 항목으로 합칠 것인가.
 *
 * `adjacent` 는 둘 사이에 (버리지 않은) 본문이 없다는 뜻이다. 판정은 부르는
 * 쪽이 한다 — 목차는 SQL 의 `ROW_NUMBER`, 내보내기는 배열의 이웃으로 안다.
 *
 * 넘기는 글은 **늘 원문**이어야 한다. 번역에서는 수사 꼴이 달라진다
 * (「CHAPTER 1」 → 「제1장」). 구조는 원문의 성질이다.
 */
export function mergesWithNext(
  cur: { level: number; text: string },
  next: { level: number; text: string } | undefined,
  adjacent: boolean
): boolean {
  return (
    !!next &&
    adjacent &&
    next.level >= cur.level &&      // 제목이 수사보다 얕아지지는 않는다
    isNumberedLabel(cur.text) &&
    !isNumberedLabel(next.text)
  );
}
