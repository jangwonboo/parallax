/* 휴면 코드 — 앱이 .parallax 전용 리더로 좁혀지면서(2026-08-06) 호출부가 사라졌다.
   지금 main/index.ts 가 쓰는 건 Cancelled 와 cancelImport 둘뿐이고, 파이썬 sidecar
   경로(findSkillDir·extractPdf·pagecheckPdf·readExtraction)는 아무도 부르지 않는다.
   앱 안에서 다시 PDF 를 받을 여지를 두려고 남겼다. 대신 스킬 쪽 CLI 인자가 바뀌어도
   여기서는 안 깨지므로, extract.py·pagecheck.py 의 인자를 손대면 이 파일도 같이 보라. */
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
 * PDF → 파이썬 sidecar. `pdf-ko-translate` 스킬의 스크립트를 그대로 쓴다.
 * 스킬 경로를 설정에서 받거나 표준 위치에서 찾는다.
 *
 * 스크립트 하나가 아니라 스킬 폴더를 돌려준다 — 추출(extract.py) 다음에
 * 페이지 검증(pagecheck.py)도 같은 폴더에서 불러야 한다.
 */
export function findSkillDir(configured?: string | null): string | null {
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
    if (existsSync(join(c, "scripts", "extract.py"))) return c;
  }
  return null;
}

/** 스킬에 pagecheck 가 함께 들어 있는가 — 오래된 스킬 사본이면 없을 수 있다. */
export const hasPagecheck = (skillDir: string) =>
  existsSync(join(skillDir, "scripts", "pagecheck.py"));

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

/** 사용자가 중간에 멈춘 것. 실패와 구분해야 오류 상자가 뜨지 않는다. */
export class Cancelled extends Error {
  constructor() {
    super("취소했습니다.");
    this.name = "Cancelled";
  }
}

/* 파이썬 자식은 한 번에 하나만 돈다 — 문서도 한 번에 하나만 연다.
   페이지 검증은 몇 분씩 걸리고 쪽마다 돈이 나가므로 멈출 수 있어야 한다. */
let running: ChildProcess | null = null;
let stopped = false;

/** 돌고 있는 추출·검증을 멈춘다. 멈춘 게 있으면 true. */
export function cancelImport(): boolean {
  if (!running) return false;
  stopped = true;
  running.kill();
  return true;
}

function runPy(
  script: string,
  args: string[],
  env: Record<string, string> | null,
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const py = findPython();
    if (!py) {
      return reject(new Error(
        "파이썬 3을 찾지 못했습니다. 설치했다면 PARALLAX_PYTHON 에 실행 파일 경로를 지정하세요."));
    }
    stopped = false;
    /* -u: 파이프에 물리면 파이썬 stdout 은 블록 버퍼링이라, flush 없는 print 는
       프로세스가 끝날 때까지 안 나온다. 진행 표시가 몇 분씩 침묵하던 원인. */
    const proc = spawn(py, ["-u", script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      /* 파이썬의 표준 출력 인코딩은 콘솔 코드페이지를 따른다. Windows 에서는
         cp949 라 진행 문구의 한글·대시가 깨져 들어왔다. UTF-8 로 못박는다. */
      env: { ...process.env, PYTHONIOENCODING: "utf-8", ...(env ?? {}) },
    });
    running = proc;

    let err = "";
    /* 줄 단위로 자른다. 청크 경계는 줄 경계와 무관해서, 예전처럼 청크의
       마지막 줄만 보면 진행 표시가 띄엄띄엄 건너뛴다. */
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += String(d);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onLine(l.trim());
    });
    proc.stderr.on("data", (d) => (err += d));

    proc.on("error", () => {
      running = null;
      reject(new Error(`${py} 를 실행할 수 없습니다. PARALLAX_PYTHON 으로 경로를 지정하세요.`));
    });
    proc.on("close", (code) => {
      running = null;
      if (stopped) return reject(new Cancelled());
      if (code !== 0) return reject(new Error(err.trim() || `실패 (exit ${code})`));
      resolve();
    });
  });
}

/** 추출이 끝난 뒤의 작업 상태. 검증까지 마친 다음에 블록을 읽어 간다. */
export interface Extraction {
  /** 임시 작업 폴더. book.json 과 pagecheck 산출물이 여기 쌓인다. */
  dir: string;
  book: string;
  title: string;
  author: string;
  pages: number;
  /** 텍스트 레이어 자체가 OCR 산출물인가 — 검증의 --trust 를 이걸로 고른다. */
  ocrLayer: boolean;
  blocks: number;
}

/**
 * PDF → book.json. 산출물은 전부 임시 폴더 하나에 모은다.
 *
 * 예전에는 임시 폴더 바닥에 파일을 흩뿌렸다. pagecheck 는 book.json 옆에
 * `pages/`(쪽 이미지)·캐시·리포트를 만들기 때문에 한 폴더로 묶어야 통째로
 * 지울 수 있다.
 */
export async function extractPdf(
  pdfPath: string,
  skillDir: string,
  onProgress: (p: T.ImportProgress) => void
): Promise<Extraction> {
  const dir = mkdtempSync(join(tmpdir(), "parallax-import-"));
  const book = join(dir, "book.json");
  try {
    await runPy(join(skillDir, "scripts", "extract.py"), [pdfPath, "--out", book], null, (line) => {
      const m = /(\d+)\s+blocks/.exec(line);
      onProgress({ stage: "extract", message: line, blocks: m ? +m[1] : undefined });
    });
    const j = JSON.parse(readFileSync(book, "utf8"));
    return {
      dir,
      book,
      title: j.meta?.title || basename(pdfPath, extname(pdfPath)),
      author: j.meta?.author ?? "",
      pages: j.meta?.pages ?? 0,
      ocrLayer: !!j.meta?.ocr_layer,
      blocks: j.blocks?.length ?? 0,
    };
  } catch (e: any) {
    discard({ dir });
    throw e instanceof Error ? e : new Error(String(e));
  }
}

export interface PagecheckOptions {
  /** layer = 글자는 텍스트 레이어가 정답, 구조만 이미지로 고친다. vision = 전 쪽 재판독. */
  trust: "layer" | "vision";
  /** vision = Claude 비전 모델(쪽당 과금). datalab = Datalab API 의 호스팅 Chandra
      OCR(쪽당 과금, GPU 불필요) — 항상 전 쪽 재판독으로 동작하며 trust 는 무시된다. */
  engine: "vision" | "datalab";
  /** Anthropic 키. datalab 엔진에는 필요 없다 — 빈 문자열이면 넘기지 않는다. */
  apiKey: string;
  /** Datalab 키. datalab 엔진일 때만 쓴다. */
  datalabKey?: string;
  /** "1-20" 처럼 일부만. 시험 삼아 돌려 볼 때 쓴다. */
  pages?: string;
}

const DATALAB_PLACEHOLDER = "your-datalab-api-key-here";

/** Datalab API 키 — 환경변수, 없으면 .env(앱 cwd → 스킬 폴더의 부모)에서 읽는다.
    파이썬 쪽(pagecheck.py)도 같은 순서로 찾지만, 패키징된 앱은 cwd 가 달라질 수
    있어 여기서 읽어 환경변수로 명시적으로 넘긴다. 자리표시자 값은 없는 것으로 친다. */
export function readDatalabKey(skillDir?: string | null): string | null {
  const clean = (v?: string | null) => {
    const s = (v ?? "").trim().replace(/^["']|["']$/g, "");
    return s && s !== DATALAB_PLACEHOLDER ? s : null;
  };
  const fromEnv = clean(process.env.DATALAB_API_KEY);
  if (fromEnv) return fromEnv;
  const cands = [join(process.cwd(), ".env")];
  if (skillDir) cands.push(join(skillDir, "..", ".env"));
  for (const f of cands) {
    try {
      const m = /^\s*DATALAB_API_KEY\s*=\s*(.+?)\s*$/m.exec(readFileSync(f, "utf8"));
      const v = clean(m?.[1]);
      if (v) return v;
    } catch { /* .env 는 없어도 된다 */ }
  }
  return null;
}

/**
 * book.json 을 제자리에서 고친다. 쪽 이미지를 모델에 보내므로 돈과 시간이 든다.
 *
 * 앱은 지금까지 extract.py 만 불렀다. 그래서 표지 조각이 목차에 섞이고 텍스트
 * 레이어의 OCR 오류가 그대로 남았다 — CLI 파이프라인을 거친 `.parallax` 와
 * 앱으로 연 PDF 의 품질이 달랐던 이유가 이것이다.
 */
export async function pagecheckPdf(
  ex: Extraction,
  pdfPath: string,
  skillDir: string,
  opts: PagecheckOptions,
  onProgress: (p: T.ImportProgress) => void
): Promise<void> {
  const args = [ex.book, "--pdf", pdfPath, "--engine", opts.engine];
  /* datalab 은 전 쪽 재판독 고정이라 --trust 가 무의미하다. */
  if (opts.engine === "vision") args.push("--trust", opts.trust);
  if (opts.pages) args.push("--pages", opts.pages);
  const env: Record<string, string> = {};
  if (opts.engine === "vision" && opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;
  if (opts.engine === "datalab" && opts.datalabKey) env.DATALAB_API_KEY = opts.datalabKey;
  await runPy(join(skillDir, "scripts", "pagecheck.py"), args, env, (line) => {
      /* _llm.progress() 가 내는 `[12/191] 6% pages read` */
      const m = /^\[(\d+)\/(\d+)\]/.exec(line);
      onProgress({
        stage: "pagecheck",
        message: line,
        page: m ? +m[1] : undefined,
        of: m ? +m[2] : undefined,
      });
    });
}

/** 검증까지 끝난 book.json 을 앱 블록으로 읽는다. */
export function readExtraction(ex: Extraction): {
  title: string; author: string; pages: number; blocks: RawBlock[];
  /** `--trust vision` 이 밀어낸 원 텍스트 레이어. 페이지 → 원문 조각들. */
  superseded: Record<string, unknown[]>;
  /** pagecheck 판정. 리포트 md 는 임시 폴더와 함께 지워지므로 이것이 유일한 사본. */
  pageCheck: T.PageCheck | null;
  /** Datalab 재판독이 잘라 보낸 그림. figure 블록의 src 가 여기 id 를 가리킨다. */
  assets: Record<string, { mime: string; w: number; h: number; alt?: string; b64: string }>;
} {
  let j: any;
  try {
    j = JSON.parse(readFileSync(ex.book, "utf8"));
  } catch (e: any) {
    throw new Error(`추출 결과를 읽지 못했습니다: ${e.message}`);
  }
  return {
    title: j.meta?.title || ex.title,
    author: j.meta?.author ?? "",
    pages: j.meta?.pages ?? 0,
    /* 재판독이 밀어낸 레이어 텍스트. 버리면 원문을 의심할 때 돌아갈 곳이 없다 —
       스킬의 export.py 도 같은 것을 .parallax 로 옮긴다. */
    superseded: j.superseded ?? {},
    pageCheck: j.page_check ?? null,
    assets: j.assets ?? {},
    blocks: j.blocks.map((b: any) => ({
      id: b.id,
      page: b.page ?? null,
      type: b.type,
      src: b.src,
      /* pagecheck 가 남기는 내력도 함께 옮긴다. 어느 블록이 판독 텍스트인지는
         나중에 원문을 의심할 때 유일한 단서다. 스킬의 `_parallax.py: flags_of`
         와 같은 대응이다 — 한쪽을 고치면 다른 쪽도 고쳐야 한다. */
      flags:
        (b.translate === false ? T.NO_TRANSLATE : 0) |
        (b.from_ocr ? T.FROM_OCR : 0) |
        (b.rebuilt ? T.REBUILT : 0) |
        (b.stitched ? T.STITCHED : 0) |
        (b.needs_review ? T.NEEDS_REVIEW : 0) |
        (b.dropped ? T.DROPPED : 0),
    })),
  };
}

/** 임시 작업 폴더를 통째로 지운다 — 쪽 이미지가 수백 MB 까지 간다. */
export function discard(ex: Pick<Extraction, "dir">) {
  try { rmSync(ex.dir, { recursive: true, force: true }); } catch { /* 남아도 임시 폴더다 */ }
}
