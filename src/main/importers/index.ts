import { readFileSync, existsSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, extname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
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
  /* homedir() 를 쓴다. Windows 에는 HOME 이 없어 (USERPROFILE 을 쓴다)
     `undefined/.claude/skills/…` 를 뒤지고 있었다. */
  const home = homedir();
  const cands = [
    configured,
    process.env.PARALLAX_SKILL_DIR,
    join(home, ".claude", "skills", "pdf-ko-translate"),
    join(process.cwd(), "pdf-ko-translate"),
    join(process.cwd(), "..", "pdf-ko-translate"),
  ].filter(Boolean) as string[];
  for (const c of cands) {
    const s = join(c, "scripts", "extract.py");
    if (existsSync(s)) return s;
  }
  return null;
}

/**
 * 실제로 돌아가는 파이썬을 찾는다.
 *
 * `python3` 를 그냥 부르면 안 된다. Windows 의 `python3.exe` 는 대개
 * Microsoft Store 로 보내는 0바이트 재파싱 지점이라, 실행하면 파이썬이 아니라
 * 스토어가 뜨고 추출은 알 수 없는 이유로 실패한다. 후보를 하나씩 실제로
 * 실행해 보고 판별한다.
 */
let pythonCache: string | null | undefined;
export function findPython(): string | null {
  if (pythonCache !== undefined) return pythonCache;
  const configured = process.env.PARALLAX_PYTHON;
  const cands = configured
    ? [configured]
    : process.platform === "win32"
      ? ["python", "py", "python3"]
      : ["python3", "python"];
  for (const c of cands) {
    const r = spawnSync(c, ["-c", "import sys;print(sys.version_info[0])"],
                        { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status === 0 && String(r.stdout).trim() === "3") return (pythonCache = c);
  }
  return (pythonCache = null);
}

export function importPdf(
  path: string,
  script: string,
  onProgress: (p: T.ImportProgress) => void
): Promise<{ title: string; author: string; pages: number; blocks: RawBlock[] }> {
  return new Promise((resolve, reject) => {
    /* 임시 산출물은 임시 폴더에 쓴다. 원본 옆에 쓰면 extract.py 가 같은 자리에
       내는 blocks.txt 까지 사용자의 문서 폴더에 남는다. */
    const tmp = join(tmpdir(), `parallax-extract-${Date.now()}.json`);
    const py = findPython();
    if (!py) {
      return reject(new Error(
        "파이썬 3을 찾지 못했습니다. 설치했다면 PARALLAX_PYTHON 에 실행 파일 경로를 지정하세요."));
    }
    const proc = spawn(py, [script, path, "--out", tmp], { stdio: ["ignore", "pipe", "pipe"] });

    let err = "";
    proc.stdout.on("data", (d) => {
      const s = String(d);
      const m = /(\d+)\s+blocks/.exec(s);
      onProgress({ stage: "extract", message: s.trim().split("\n").pop(), blocks: m ? +m[1] : undefined });
    });
    proc.stderr.on("data", (d) => (err += d));

    proc.on("error", () =>
      reject(new Error(`${py} 를 실행할 수 없습니다. PARALLAX_PYTHON 으로 경로를 지정하세요.`))
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
      } finally {
        for (const f of [tmp, join(tmpdir(), "blocks.txt")]) {
          try { rmSync(f, { force: true }); } catch {}
        }
      }
    });
  });
}
