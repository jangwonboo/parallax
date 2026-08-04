import {
  app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell, nativeTheme,
} from "electron";
import { join, basename, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Doc } from "./db";
import { Scheduler } from "./translate/scheduler";
import * as Imp from "./importers";
import * as T from "../shared/types";
import { docTitle, renderMarkdown } from "./exporter";
import { Tts } from "./tts";
import * as TtsAssets from "./tts/assets";

const DEV = process.argv.includes("--dev");
let win: BrowserWindow | null = null;
const tts = new Tts((channel, payload) => emit(channel, payload));

/* ── 앱 데이터 ───────────────────────────────────────── */
const dataDir = () => {
  const d = join(app.getPath("userData"), "docs");
  mkdirSync(d, { recursive: true });
  return d;
};
const settingsPath = () => join(app.getPath("userData"), "settings.json");
const keysPath = () => join(app.getPath("userData"), "keys.bin");

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}
function writeSettings(s: Record<string, unknown>) {
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

/* API 키는 safeStorage 로만 저장하고 renderer 로는 존재 여부만 나간다 */
function readKey(): string | null {
  try {
    if (!existsSync(keysPath())) return process.env.ANTHROPIC_API_KEY || null;
    const buf = readFileSync(keysPath());
    if (!safeStorage.isEncryptionAvailable()) return process.env.ANTHROPIC_API_KEY || null;
    return safeStorage.decryptString(buf);
  } catch {
    return process.env.ANTHROPIC_API_KEY || null;
  }
}
function writeKey(key: string) {
  /* 암호화가 안 되는 환경(리눅스 키링 부재 등)에서 평문으로 떨어뜨리지 않는다 —
     저장에 실패했다는 사실을 renderer 로 돌려보내고 파일은 만들지 않는다. */
  if (!safeStorage.isEncryptionAvailable()) return false;
  writeFileSync(keysPath(), safeStorage.encryptString(key));
  return true;
}
function clearKey() {
  try { if (existsSync(keysPath())) rmSync(keysPath()); } catch {}
}
/** 저장된 키가 없을 때 환경변수로 물러나므로, 지운 뒤에도 키가 남아 있을 수 있다. */
function keyStatus() {
  const saved = existsSync(keysPath());
  return { anthropic: !!readKey(), saved, fromEnv: !saved && !!process.env.ANTHROPIC_API_KEY };
}

/* ── 열려 있는 문서 ──────────────────────────────────── */
let doc: Doc | null = null;
let sched: Scheduler | null = null;

function emit(channel: string, payload: unknown) {
  win?.webContents.send(channel, payload);
}

function attach(d: Doc) {
  doc?.close();
  sched?.dispose();
  doc = d;
  sched = new Scheduler(
    d,
    (ids) => emit("block:updated", { ids }),
    () => emit("stats", sched!.stats())
  );
  sched.setKey(readKey());
}

/* ── 창 ──────────────────────────────────────────────── */
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 720,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#15171B" : "#FCFBF8",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 에서 ipcRenderer 를 쓰기 위해
    },
  });
  win.loadFile(join(__dirname, "../renderer/index.html"));
  if (DEV) win.webContents.openDevTools({ mode: "detach" });
  win.on("closed", () => (win = null));
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "파일",
      submenu: [
        { label: "열기…", accelerator: "CmdOrCtrl+O", click: () => pickAndOpen() },
        { type: "separator" },
        { label: "Anthropic API 키…", accelerator: "CmdOrCtrl+K",
          click: () => emit("keys:prompt", keyStatus()) },
        { label: "PDF 열 때 페이지 검증 묻기", type: "checkbox",
          checked: readSettings().pagecheck !== "off",
          click: (item) => {
            writeSettings({ ...readSettings(), pagecheck: item.checked ? "ask" : "off" });
          } },
        { type: "separator" },
        { label: "Markdown 내보내기 (영·한 두 파일)", click: () => doExport() },
        { label: "페이지 검증 리포트", click: () => showPagecheckReport() },
        { type: "separator" },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    { role: "editMenu" },
    {
      label: "보기",
      submenu: [
        { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    {
      label: "도움말",
      submenu: [
        { label: "문서 형식 설명", click: () => shell.openExternal("https://sqlite.org") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ── 페이지 검증 리포트 ──────────────────────────────── */

/**
 * page_check 테이블에서 리포트를 되살려 기본 편집기로 연다.
 *
 * pagecheck 가 만들던 md 파일은 임시 폴더와 함께 지워진다 — 문서에 남긴 판정
 * 행이 유일한 사본이라 여기서 다시 조립한다. 이상 없는 쪽(내용 없는 행)은
 * 표에서 뺀다.
 */
function showPagecheckReport() {
  if (!doc) {
    dialog.showErrorBox("페이지 검증 리포트", "열려 있는 문서가 없습니다.");
    return;
  }
  const rows = doc.pageCheck();
  if (!rows.length) {
    dialog.showErrorBox("페이지 검증 리포트",
      "이 문서에는 검증 기록이 없습니다.\n(PDF 를 열 때 페이지 검증을 건너뛰었거나, 검증 이전에 만든 문서입니다.)");
    return;
  }
  const summary = rows.find((r) => r.page === 0)?.notes ?? "";
  const pages = rows.filter((r) => r.page !== 0);
  const flagged = pages.filter((r) => r.notes);
  const lines = [
    `# 페이지 검증 리포트 — ${docTitle(doc.meta())}`, "",
    summary, "",
    `검사한 쪽 ${pages.length} · 이상 ${flagged.length}`, "",
    "| 쪽 | 일치율 | 단 | 사유·메모 |", "|---|---|---|---|",
    ...(flagged.length
      ? flagged.map((r) =>
          `| ${r.page} | ${r.coverage == null ? "—" : Math.round(r.coverage * 100) + "%"} ` +
          `| ${r.columns ?? "—"} | ${r.notes} |`)
      : ["| — | — | — | 이상 없음 |"]),
  ];
  const out = join(app.getPath("temp"), "parallax-pagecheck-report.md");
  writeFileSync(out, lines.join("\n"), "utf8");
  shell.openPath(out);
}

/* ── 열기 ────────────────────────────────────────────── */
async function pickAndOpen() {
  const r = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "읽을 수 있는 문서", extensions: ["parallax", "pdf", "md", "markdown", "txt"] },
      { name: "Parallax 문서", extensions: ["parallax"] },
      { name: "PDF", extensions: ["pdf"] },
      { name: "텍스트", extensions: ["md", "markdown", "txt"] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return;
  await openPath(r.filePaths[0]).catch(reportOpenError);
}

/** 사용자가 스스로 멈춘 것은 실패가 아니다 — 상자를 띄우지 않는다. */
function reportOpenError(e: any) {
  emit("import:progress", { stage: "error" });
  if (e instanceof Imp.Cancelled) return;
  dialog.showErrorBox("열 수 없습니다", e?.message ?? String(e));
}

/* 쪽당 대략적인 비전 호출 비용(claude-haiku, 150dpi). pagecheck.py 가 CLI 에서
   찍는 것과 같은 어림수다 — 정확한 청구액이 아니라 자릿수를 보여 주는 값이다. */
const VISION_USD_PER_PAGE = 0.0075;

/**
 * 추출한 PDF 를 페이지 검증까지 돌릴지 정한다.
 *
 * 추출이 끝난 **뒤에** 묻는다. 그래야 쪽수를 알고 비용을 실제 값으로 보여 줄 수
 * 있고, 텍스트 레이어가 OCR 인지도 그때 알 수 있다. 묻지 않고 돌리는 일은
 * 없다 — 쪽마다 돈이 나가는 작업이다.
 */
async function planPagecheck(
  skill: string,
  ex: Imp.Extraction
): Promise<Imp.PagecheckOptions | null> {
  if (readSettings().pagecheck === "off") return null;
  if (!Imp.hasPagecheck(skill) || !ex.pages) return null;
  const apiKey = readKey();
  if (!apiKey) return null;   // 키가 없으면 물어봐야 할 것도 없다

  /* 어느 쪽을 권할지는 알려 주되 고르는 것은 감추지 않는다. 두 모드가 하는 일이
     다르고, 잘못 고르면 되돌릴 수 없다 — 재판독은 멀쩡한 원문의 고어 철자를
     현대화하고 저자의 의도적 오기를 고쳐 버린다. */
  const usd = (ex.pages * VISION_USD_PER_PAGE).toFixed(2);
  const r = await dialog.showMessageBox(win!, {
    type: "question",
    buttons: ["건너뛰기", "구조만 대조", "전 쪽 재판독"],
    defaultId: ex.ocrLayer ? 2 : 1,
    cancelId: 0,
    checkboxLabel: "다음부터 묻지 말고 건너뛰기",
    message: "페이지 검증을 실행할까요?",
    detail:
      `${ex.pages}쪽 · 블록 ${ex.blocks}개 · 예상 비용 약 $${usd}\n\n` +
      (ex.ocrLayer
        ? "이 PDF 의 텍스트 레이어는 판독 산출물로 보입니다 — 글자 자체가 이미 추측이므로 " +
          "「전 쪽 재판독」을 권합니다.\n\n"
        : "이 PDF 의 텍스트 레이어는 문서가 가진 제 글자로 보입니다 — 「구조만 대조」를 " +
          "권합니다.\n\n") +
      "구조만 대조: 글자는 텍스트 레이어 그대로 두고 제목·순서·누락만 쪽 이미지로 고칩니다.\n" +
      "전 쪽 재판독: 모든 쪽을 이미지에서 다시 받아씁니다. 표지 조각과 판독 오류를 " +
      "걷어내지만, 판독 모델은 고어 철자를 현대화하고 저자의 의도적 오기를 고칩니다.\n\n" +
      "건너뛰면 추출한 그대로 열립니다. 몇 분 걸리며 도중에 멈출 수 있습니다.",
  });

  /* 체크는 「묻지 않기」가 아니라 「묻지 말고 건너뛰기」다. 묻지 않기로 해 두고
     매번 돈이 나가는 쪽이 기본값이 되면 안 된다. 메뉴에서 되돌릴 수 있다. */
  if (r.checkboxChecked) {
    writeSettings({ ...readSettings(), pagecheck: "off" });
    buildMenu();
  }
  if (r.response === 0) return null;
  return { trust: r.response === 2 ? "vision" : "layer", apiKey };
}

async function openPath(path: string) {
  const ext = path.toLowerCase().split(".").pop();
  emit("import:progress", { stage: "read", message: basename(path) });

  if (ext === "parallax") {
    attach(Doc.open(path));
  } else {
    const target = join(dataDir(), `${basename(path).replace(/\W+/g, "_")}_${Date.now()}.parallax`);
    if (ext === "pdf") {
      const skill = Imp.findSkillDir(readSettings().skillDir as string | undefined);
      if (!skill) {
        throw new Error(
          "PDF 추출기를 찾지 못했습니다.\n\n" +
            "pdf-ko-translate 스킬이 필요합니다:\n" +
            "  ~/.claude/skills/pdf-ko-translate\n\n" +
            "또는 환경변수 PARALLAX_SKILL_DIR 로 경로를 지정하세요.\n" +
            "이미 변환된 .parallax 나 .md 는 그대로 열 수 있습니다."
        );
      }
      const prog = (p: T.ImportProgress) => emit("import:progress", p);
      const ex = await Imp.extractPdf(path, skill, prog);
      try {
        const plan = await planPagecheck(skill, ex);
        if (plan) {
          try {
            await Imp.pagecheckPdf(ex, path, skill, plan, prog);
          } catch (e: any) {
            /* 검증에서 멈추거나 넘어져도 추출본은 멀쩡하다 — 문서는 연다.
               pagecheck 는 다 끝난 뒤에야 book.json 을 덮어쓰므로 중간에
               죽어도 남아 있는 것은 추출 직후 상태 그대로다. */
            if (!(e instanceof Imp.Cancelled)) {
              dialog.showErrorBox("페이지 검증에 실패했습니다",
                `${e.message ?? String(e)}\n\n추출한 상태 그대로 엽니다.`);
            }
          }
        }
        const r = Imp.readExtraction(ex);
        attach(
          Doc.create(
            target,
            { title: r.title, author: r.author, sourcePath: path, sourceKind: "pdf", pages: r.pages },
            r.blocks,
            r.superseded,
            r.pageCheck
          )
        );
      } finally {
        Imp.discard(ex);
      }
    } else if (ext === "md" || ext === "markdown") {
      const r = Imp.importMarkdown(path);
      attach(Doc.create(target, { title: r.title, sourcePath: path, sourceKind: "md" }, r.blocks));
    } else {
      const r = Imp.importText(path);
      attach(Doc.create(target, { title: r.title, sourcePath: path, sourceKind: "txt" }, r.blocks));
    }
  }

  emit("import:progress", { stage: "done" });
  const meta = doc!.meta();
  emit("doc:opened", {
    meta,
    outline: doc!.outline(),
    heights: doc!.heights(),
    sourceChanged: doc!.sourceChanged(),
    hasKey: sched!.hasKey(),
  });
}

/** 영문·한글을 파일 하나씩 낸다: `<이름>.en.md` / `<이름>.ko.md`. */
async function doExport() {
  if (!doc) return;
  const m = doc.meta();
  const r = await dialog.showSaveDialog({
    defaultPath: `${docTitle(m).replace(/[\\/:*?"<>|]/g, "_")}.md`,
  });
  if (r.canceled || !r.filePath) return;
  const base = r.filePath.replace(/\.md$/i, "");
  const blocks = doc.range(0, doc.count());
  writeFileSync(`${base}.en.md`, renderMarkdown(blocks, "src"));
  writeFileSync(`${base}.ko.md`, renderMarkdown(blocks, "ko"));
  shell.showItemInFolder(`${base}.ko.md`);
}

/* ── IPC ─────────────────────────────────────────────── */
function wireIpc() {
  ipcMain.handle("doc:open", async (_e, path?: string) =>
    path ? openPath(path).catch(reportOpenError) : pickAndOpen()
  );
  ipcMain.handle("doc:cancelImport", () => Imp.cancelImport());
  ipcMain.handle("doc:meta", () => doc?.meta() ?? null);
  ipcMain.handle("blocks:count", () => doc?.count() ?? 0);
  ipcMain.handle("blocks:range", (_e, off: number, lim: number) => doc?.range(off, lim) ?? []);
  ipcMain.handle("blocks:byIds", (_e, ids: string[]) => doc?.byIds(ids) ?? []);
  ipcMain.handle("blocks:outline", () => doc?.outline() ?? []);
  ipcMain.handle("blocks:setHeights", (_e, pairs: [string, number][]) => doc?.setHeights(pairs));
  ipcMain.handle("blocks:clearHeights", () => doc?.clearHeights());
  ipcMain.handle("blocks:reset", (_e, ids: string[]) => {
    doc?.resetBlocks(ids);
    emit("block:updated", { ids });
  });

  ipcMain.handle("tr:request", (_e, ids: string[], p: T.Priority) => sched?.request(ids, p));
  ipcMain.handle("tr:mode", (_e, m: T.Mode) => sched?.setMode(m));
  ipcMain.handle("tr:pause", (_e, v: boolean) => sched?.pause(v));
  ipcMain.handle("tr:stats", () => sched?.stats() ?? null);
  ipcMain.handle("tr:deslop", (_e, ids: string[]) => sched?.deslop(ids));

  ipcMain.handle("settings:get", () => readSettings());
  ipcMain.handle("settings:set", (_e, patch: Record<string, unknown>) => {
    writeSettings({ ...readSettings(), ...patch });
  });

  ipcMain.handle("keys:status", () => keyStatus());
  ipcMain.handle("keys:set", (_e, key: string) => {
    const k = String(key ?? "").trim();
    if (!k) return { ok: false, reason: "빈 키입니다.", ...keyStatus() };
    if (!writeKey(k)) {
      return { ok: false, reason: "이 환경에서는 안전한 저장소를 쓸 수 없습니다. ANTHROPIC_API_KEY 환경변수를 쓰세요.", ...keyStatus() };
    }
    sched?.setKey(k);
    return { ok: true, ...keyStatus() };
  });
  ipcMain.handle("keys:clear", () => {
    clearKey();
    sched?.setKey(readKey());   // 환경변수가 있으면 그리로 물러난다
    return { ok: true, ...keyStatus() };
  });

  ipcMain.handle("dict:lookup", (_e, word: string) => lookup(word));
  ipcMain.handle("export", () => doExport());

  /* ── 낭독 (spec-tts.md §7.1) ─────────────────────────
     렌더러는 오디오를 IPC 로만 받는다. 네트워크에도 파일시스템에도 나가지
     않는 기존 원칙(dict:lookup 을 main 이 대신하는 것과 같다) 그대로다. */
  ipcMain.handle("tts:status", () => tts.status());
  ipcMain.handle("tts:install", () => tts.install());
  ipcMain.handle("tts:voices", () => TtsAssets.VOICES);
  ipcMain.handle("tts:stop", () => { tts.cancel(); });

  /* ── 재생 — 청크 단위로 넘긴다 ────────────────────────
     한 번에 다 합성하고 재생을 시작하면 긴 대목에서 한참 기다린다. 조각으로 나눠
     첫 조각이 나오는 대로 소리를 내고 나머지는 뒤에서 만든다. 0.24배속이라
     합성이 재생보다 네 배 빨라, 한 번 시작하면 따라잡힌다(spec-tts.md §6.1). */
  type Job = { chunks: string[]; lang: "ko" | "en" };
  const jobs = new Map<string, Job>();

  const applyVoice = (voice?: string) => {
    const saved = (readSettings().tts ?? {}) as Partial<import("./tts").TtsSettings>;
    tts.setSettings({ ...saved, ...(voice ? { voice } : {}) });
  };

  ipcMain.handle("tts:plan", async (_e, req: { text: string; lang: "ko" | "en"; voice?: string }) => {
    const text = (req?.text ?? "").trim();
    if (!text) return null;
    applyVoice(req.voice);
    try {
      const chunks = await tts.chunks(text, req.lang, true);
      const jobId = randomUUID();
      jobs.set(jobId, { chunks, lang: req.lang });
      /* 이어 읽기는 블록마다 계획하므로 조금 더 들고 있는다. */
      while (jobs.size > 8) jobs.delete(jobs.keys().next().value!);
      /* 조각 글도 함께 돌려준다 — 렌더러가 원문 어디를 읽는 중인지 알아야
         소리에 맞춰 낱말을 짚을 수 있다. */
      return { jobId, count: chunks.length, chunks };
    } catch (e: any) {
      emit("tts:state", { phase: "error", message: e?.message ?? String(e) });
      return null;
    }
  });

  ipcMain.handle("tts:chunk", async (_e, req: { jobId: string; i: number }) => {
    const job = jobs.get(req.jobId);
    const text = job?.chunks[req.i];
    if (!job || text === undefined) return null;
    try {
      const r = await tts.speak(text, job.lang);
      return { wav: r.wav, seconds: r.seconds };
    } catch (e: any) {
      if (e?.name !== "Cancelled") emit("tts:state", { phase: "error", message: e?.message ?? String(e) });
      return null;
    }
  });

  /* ── mp3 내보내기 ────────────────────────────────────
     쪼개는 기준은 합성 청크가 아니라 **제목**이다. 청크는 엔진 사정(문장 몇 개)이라
     20초짜리 파일이 수십 개 나오고, 그건 사람이 듣는 단위가 아니다. 제목 경계로
     끊으면 트랙 하나가 장 하나가 되어 오디오북처럼 쓰인다. */
  const KBPS = 64;   // 모노 낭독은 64kbps 면 충분하다. 32분에 15MB.

  const safeName = (s: string, max: number) =>
    s.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim()
      .slice(0, max).replace(/[.,;:!?\s]+$/, "");
  const head3 = (s: string) => safeName(s.trim().split(/\s+/).slice(0, 3).join(" "), 24);

  ipcMain.handle("tts:export", async (_e, req: {
    segments: { type: string; text: string }[]; lang: "ko" | "en"; voice?: string;
  }) => {
    if (!doc) return null;
    const segs = (req?.segments ?? []).filter((s) => s.text.trim());
    if (!segs.length) return null;
    const isHead = (t: string) => /^h[123]$/.test(t);

    /* 제목이 하나뿐이면 나눌 이유가 없다 — 트랙 한 개짜리 앨범이 된다. */
    let tracks: { title: string | null; text: string }[];
    if (segs.filter((s) => isHead(s.type)).length < 2) {
      tracks = [{ title: null, text: segs.map((s) => s.text).join("\n\n") }];
    } else {
      const acc: { title: string | null; parts: string[] }[] = [];
      for (const s of segs) {
        if (isHead(s.type) || !acc.length) acc.push({ title: isHead(s.type) ? s.text : null, parts: [] });
        acc[acc.length - 1].parts.push(s.text);
      }
      tracks = acc.map((t) => ({ title: t.title, text: t.parts.join("\n\n") }));
    }

    const book = safeName(docTitle(doc.meta()), 40) || "parallax";
    const width = String(tracks.length).length;
    const names = tracks.map((t, i) =>
      tracks.length === 1
        ? `${book}_${head3(t.text)}.mp3`
        : `${book}_${String(i + 1).padStart(width, "0")}_${safeName(t.title ?? head3(t.text), 40)}.mp3`);

    /* 한 개면 이름까지 고르게 하고, 여러 개면 폴더만 고르게 한다 — 파일 이름을
       하나 받아 나머지를 옆에 흩뿌리면 무엇이 어디 생기는지 알 수 없다. */
    let dir: string;
    if (tracks.length === 1) {
      const r = await dialog.showSaveDialog({
        defaultPath: names[0], filters: [{ name: "MP3", extensions: ["mp3"] }],
      });
      if (r.canceled || !r.filePath) return null;
      dir = dirname(r.filePath);
      names[0] = basename(r.filePath).replace(/(\.mp3)?$/i, ".mp3");
    } else {
      const r = await dialog.showOpenDialog({
        title: `mp3 ${tracks.length}개를 저장할 폴더`,
        properties: ["openDirectory", "createDirectory"],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }

    applyVoice(req.voice);
    const written: string[] = [];
    try {
      for (let i = 0; i < tracks.length; i++) {
        const chunks = await tts.chunks(tracks[i].text, req.lang, false);
        const { mp3, seconds } = await tts.render(chunks, req.lang, KBPS, (done, total) =>
          emit("tts:progress", {
            phase: "export", track: i + 1, tracks: tracks.length,
            done, total, name: names[i],
          }));
        writeFileSync(join(dir, names[i]), Buffer.from(mp3));
        written.push(names[i]);
        emit("tts:progress", {
          phase: "export", track: i + 1, tracks: tracks.length,
          done: chunks.length, total: chunks.length, name: names[i], seconds,
        });
      }
    } catch (e: any) {
      if (e?.name !== "Cancelled") emit("tts:state", { phase: "error", message: e?.message ?? String(e) });
      /* 중간에 멈춰도 이미 쓴 파일은 남긴다 — 지우면 40분을 다시 기다려야 한다. */
      if (written.length) shell.showItemInFolder(join(dir, written[written.length - 1]));
      return { files: written, cancelled: true };
    }
    shell.showItemInFolder(join(dir, written[0]));
    return { files: written, cancelled: false };
  });
}

/* ── 사전 — renderer 는 네트워크에 직접 나가지 않는다 ── */
const dictCache = new Map<string, T.DictEntry>();

function lemmas(w: string): string[] {
  const out = [w];
  const add = (x: string) => {
    if (x.length > 2 && !out.includes(x)) out.push(x);
  };
  add(w.replace(/[’']s$/, ""));
  if (/ies$/.test(w)) add(w.slice(0, -3) + "y");
  if (/(ses|xes|zes|ches|shes)$/.test(w)) add(w.slice(0, -2));
  if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
  if (/ing$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -3) + "e"); }
  if (/ed$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (/ly$/.test(w)) add(w.slice(0, -2));
  return out.slice(0, 4);
}

async function lookup(word: string): Promise<T.DictEntry> {
  const key = word.toLowerCase();
  const hit = dictCache.get(key);
  if (hit) return hit;

  const entry: T.DictEntry = { word, ipa: "", ko: "", koOk: false, defs: [] };

  await Promise.all([
    (async () => {
      for (const cand of lemmas(word)) {
        try {
          const r = await fetch(
            `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cand)}`
          );
          if (!r.ok) continue;
          const j: any = await r.json();
          if (!Array.isArray(j) || !j.length) continue;
          entry.word = cand;
          entry.ipa = j[0].phonetic || (j[0].phonetics ?? []).map((p: any) => p.text).find(Boolean) || "";
          for (const m of (j[0].meanings ?? []).slice(0, 3)) {
            for (const d of (m.definitions ?? []).slice(0, 2)) {
              entry.defs.push({ pos: m.partOfSpeech ?? "", text: d.definition ?? "" });
            }
          }
          return;
        } catch { /* 다음 후보 */ }
      }
    })(),
    (async () => {
      try {
        const r = await fetch(
          `https://api.mymemory.translated.net/get?langpair=en|ko&q=${encodeURIComponent(word)}`
        );
        const j: any = await r.json();
        const t = j?.responseData?.translatedText?.trim();
        if (t && t.toLowerCase() !== word.toLowerCase()) {
          entry.ko = t;
          entry.koOk = true;
        }
      } catch { /* 링크로 물러난다 */ }
    })(),
  ]);

  if (!entry.defs.length && !entry.koOk) entry.error = "조회하지 못했습니다.";
  dictCache.set(key, entry);
  return entry;
}

/* ── 수명주기 ────────────────────────────────────────── */
/* 이름을 명시해 둔다 — package.json 의 productName 에 기대지 않고, 윈도우
   작업표시줄이 Electron 기본값이 아니라 이 앱으로 묶이도록 AUMID 도 준다. */
app.setName("Parallax");
if (process.platform === "win32") app.setAppUserModelId("fo.parallax.reader");

app.whenReady().then(() => {
  wireIpc();
  buildMenu();
  createWindow();

  const fileArg = process.argv.slice(1).find((a) => a.endsWith(".parallax"));
  if (fileArg && existsSync(fileArg)) {
    win!.webContents.once("did-finish-load", () => openPath(fileArg).catch(reportOpenError));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("open-file", (e, path) => {
  e.preventDefault();
  if (win) openPath(path).catch(reportOpenError);
});

app.on("window-all-closed", () => {
  doc?.close();
  if (process.platform !== "darwin") app.quit();
});
