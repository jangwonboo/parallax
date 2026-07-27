import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, extname } from "node:path";
import * as T from "../../shared/types";

export interface RawBlock {
  id: string;
  page: number | null;
  type: string;
  src: string;
  flags?: number;
}

const bid = (n: number) => `b${String(n).padStart(4, "0")}`;

/** Markdown → 블록. OCR 산출물과 스킬이 낸 book.md 가 같은 경로로 들어온다. */
export function importMarkdown(path: string): { title: string; blocks: RawBlock[] } {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const blocks: RawBlock[] = [];
  let n = 0;
  const push = (type: string, src: string, flags = 0) => {
    const s = src.replace(/\s+/g, " ").trim();
    if (s) blocks.push({ id: bid(++n), page: null, type, src: s, flags });
  };

  let para: string[] = [];
  const flush = () => {
    if (para.length) push("p", para.join(" "));
    para = [];
  };

  let inFence = false;
  let fence: string[] = [];

  for (const line of text.split("\n")) {
    if (/^```/.test(line)) {
      if (inFence) {
        push("table_raw", fence.join(" "), T.NO_TRANSLATE);
        fence = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      push(`h${h[1].length}`, h[2]);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      push("quote", line.replace(/^>\s?/, ""));
      continue;
    }
    if (/^!\[/.test(line.trim())) {
      flush();
      push("figcaption", line.trim(), T.NO_TRANSLATE);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();

  const first = blocks.find((b) => b.type === "h1");
  return { title: first?.src ?? basename(path, extname(path)), blocks };
}

/** TXT → 빈 줄 기준 단락 분할. 구조 추론은 하지 않는다. */
export function importText(path: string): { title: string; blocks: RawBlock[] } {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const blocks: RawBlock[] = [];
  let n = 0;
  for (const para of text.split(/\n\s*\n/)) {
    const s = para.replace(/\s+/g, " ").trim();
    if (s) blocks.push({ id: bid(++n), page: null, type: "p", src: s });
  }
  return { title: basename(path, extname(path)), blocks };
}

/**
 * PDF → 파이썬 sidecar. `pdf-ko-translate` 스킬의 extract.py 를 그대로 쓴다.
 * 스킬 경로를 설정에서 받거나 표준 위치에서 찾는다.
 */
export function findSidecar(configured?: string | null): string | null {
  const cands = [
    configured,
    process.env.PARALLAX_SKILL_DIR,
    `${process.env.HOME}/.claude/skills/pdf-ko-translate`,
    `${process.cwd()}/../pdf-ko-translate`,
  ].filter(Boolean) as string[];
  for (const c of cands) {
    if (existsSync(`${c}/scripts/extract.py`)) return `${c}/scripts/extract.py`;
  }
  return null;
}

export function importPdf(
  path: string,
  script: string,
  onProgress: (p: T.ImportProgress) => void
): Promise<{ title: string; author: string; pages: number; blocks: RawBlock[] }> {
  return new Promise((resolve, reject) => {
    const tmp = `${path}.parallax-extract.json`;
    const py = process.env.PARALLAX_PYTHON || "python3";
    const proc = spawn(py, [script, path, "--out", tmp], { stdio: ["ignore", "pipe", "pipe"] });

    let err = "";
    proc.stdout.on("data", (d) => {
      const s = String(d);
      const m = /(\d+)\s+blocks/.exec(s);
      onProgress({ stage: "extract", message: s.trim().split("\n").pop(), blocks: m ? +m[1] : undefined });
    });
    proc.stderr.on("data", (d) => (err += d));

    proc.on("error", () =>
      reject(new Error(`python3 를 실행할 수 없습니다. 설정에서 경로를 지정하세요.`))
    );
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `추출 실패 (exit ${code})`));
      try {
        const j = JSON.parse(readFileSync(tmp, "utf8"));
        resolve({
          title: j.meta?.title ?? basename(path, ".pdf"),
          author: j.meta?.author ?? "",
          pages: j.meta?.pages ?? 0,
          blocks: j.blocks.map((b: any) => ({
            id: b.id,
            page: b.page ?? null,
            type: b.type,
            src: b.src,
            flags: b.translate === false ? T.NO_TRANSLATE : 0,
          })),
        });
      } catch (e: any) {
        reject(new Error(`추출 결과를 읽지 못했습니다: ${e.message}`));
      }
    });
  });
}
