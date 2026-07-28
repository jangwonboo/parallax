/** `.parallax` 포맷 — spec.md §2.2. 스키마를 바꿀 때 여기와 스펙을 함께 고친다. */

export const SCHEMA_VERSION = 1;
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
  | "h1" | "h2" | "h3" | "p" | "quote" | "figcaption" | "footnote" | "table_raw";

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

export interface Heading {
  id: string;
  ord: number;
  level: 1 | 2 | 3;
  text: string;
}

export type Priority = 0 | 1 | 2 | 3;
export type Mode = "viewport" | "chapter" | "all";

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
