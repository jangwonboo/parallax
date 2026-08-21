/** `.parallax` 포맷 — spec.md §2.2. 스키마를 바꿀 때 여기와 스펙을 함께 고친다. */

export const SCHEMA_VERSION = 2; // v2: asset 테이블 + figure 블록 유형
export const ORD_STEP = 1024;

/** block.state */
export const UNTRANSLATED = 0;
export const IN_FLIGHT = 1;
export const TRANSLATED = 2;
export const DESLOPPED = 3;

/** block.flags — 비트 필드 */
export const FROM_OCR = 1 << 0;
export const REBUILT = 1 << 1;
export const STITCHED = 1 << 2;
export const NEEDS_REVIEW = 1 << 3;
export const NO_TRANSLATE = 1 << 4;
export const DROPPED = 1 << 5;

export type BlockType =
  | "h1" | "h2" | "h3" | "p" | "quote" | "figcaption" | "footnote" | "table_raw"
  /* 별행 수식. src 는 `$$…$$` 로 감싼 LaTeX 다 — 언어가 없으므로 번역 대상이
     아니고, 리더는 좌우 두 칸에 같은 것을 그린다(그림과 같은 취급). */
  | "equation"
  /* 그림. src 는 본문이 아니라 asset 테이블의 id 다 — 번역 대상이 아니다. */
  | "figure";

export interface Block {
  id: string;
  ord: number;
  page: number | null;
  type: BlockType;
  src: string;
  ko: string | null;
  ko_raw: string | null;
  state: number;
  flags: number;
  height_px: number | null;
}

export interface DocMeta {
  id: string;
  title: string;
  title_ko: string | null;
  author: string | null;
  source_path: string | null;
  source_hash: string | null;
  source_kind: "pdf" | "md" | "txt";
  pages: number | null;
  schema_version: number;
  blockCount: number;
  translated: number;
}

export interface DocSummary {
  id: string;
  path: string;
  title: string;
  title_ko: string | null;
  pages: number | null;
  progress_read: number;
  progress_translated: number;
  last_opened_at: number;
}

/** asset 행에서 데이터를 뺀 것 — 렌더러가 높이 추정과 alt 에 쓴다. */
export interface AssetMeta {
  id: string;
  mime: string;
  w: number;
  h: number;
  alt: string | null;
  /** 원본 쪽 폭 대비 폭(0~1). 옛 파일에는 없어 null 이다 — 그때는 상한만 건다. */
  wfrac: number | null;
}

export interface Heading {
  id: string;
  ord: number;
  level: 1 | 2 | 3;
  text: string;
}

/**
 * 형광펜 한 조각.
 *
 * 좌표가 **블록 원문 문자열의 문자 오프셋**이라는 것이 이 구조의 전부다. DOM
 * 위치로 잡으면 안 된다 — 리더는 가상 스크롤이라 행이 스크롤할 때마다 지워지고
 * 다시 만들어지고, `setTextWithMath` 가 수식을 KaTeX 로 그려 DOM 글자수와 원문
 * 글자수가 애초에 다르다.
 *
 * `text` 는 그 구간의 사본이다. 붙일 때 `blockText.slice(start,end)` 와 대조해서
 * 어긋나면 칠하지 않는다 — 번역은 재번역·deslop 으로 바뀌기 때문이다.
 *
 * 여러 단락에 걸쳐 그으면 블록마다 조각이 하나씩 생기고 `groupId` 로 묶인다.
 * 사용자가 한 번 그은 것은 목록에서 한 줄이고 삭제도 한 번이어야 한다.
 */
export interface Highlight {
  id: string;
  groupId: string;
  blockId: string;
  /** 원문 칸인가 번역 칸인가. 둘은 서로를 모른다(spec §6.2). */
  side: "src" | "ko";
  start: number;
  end: number;
  text: string;
  createdAt: number;
}

/** 사전 한 항목. `.parallax` 의 dict_cache 에 그대로 담긴다. */
export interface WordEntry {
  ipa: string;
  /** 영한. 한 낱말만 그었을 때 함께 보여 준다. */
  ko: string;
  defs: { pos: string; text: string }[];
}

/** 형광펜 밑에 다는 낱말 풀이 한 줄. */
export interface Gloss {
  word: string;
  ipa: string;
  /** 영한. 한 낱말만 그었을 때만 채운다. */
  ko: string;
  defs: { pos: string; text: string }[];
}

export type Priority = 0 | 1 | 2 | 3;
export type Mode = "chapter" | "all";

export interface Stats {
  total: number;
  translatable: number;
  done: number;
  inFlight: number;
  queued: number;
  spendUsd: number;
  mode: Mode;
  paused: boolean;
}

export interface DictEntry {
  word: string;
  ipa: string;
  ko: string;
  koOk: boolean;
  defs: { pos: string; text: string }[];
  error?: string;
}

/** pagecheck 판정 — book.json 의 `page_check`. page_check 테이블로 옮겨 보관한다. */
export interface PageCheck {
  /** 엔진·모델·수정 통계 한 줄. 테이블에는 page=0 행으로 들어간다. */
  summary: string;
  pages: {
    page: number;
    coverage: number | null;
    columns: number | null;
    /** 이상 사유(세미콜론 구분). 재수입 행은 메모까지 합쳐져 있다. */
    reasons?: string[];
    notes?: string;
  }[];
}

export interface ImportProgress {
  stage: "read" | "extract" | "pagecheck" | "structure" | "write" | "done" | "error";
  page?: number;
  of?: number;
  blocks?: number;
  message?: string;
}

export const BODY_TYPES: BlockType[] = ["p", "quote", "footnote", "figcaption"];
export const HEADING_TYPES: BlockType[] = ["h1", "h2", "h3"];

/**
 * 밖으로 내보내는 글에 들어가는가.
 *
 * DROPPED 는 뺀다 — 러닝 헤드·쪽 번호이거나 도판에서 뜯겨 나온 조각이라 애초에
 * 읽을 글이 아니다. 리더는 원문 칸에 그대로 두지만(쪽을 대조할 때 필요하다)
 * 가져가는 글에는 자리가 없다. NO_TRANSLATE(색인·참고문헌)는 책의 일부라 남긴다.
 */
export const isExportable = (b: Pick<Block, "flags">) => (b.flags & DROPPED) === 0;
