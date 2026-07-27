import {
  app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell, nativeTheme,
} from "electron";
import { join, basename, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { Doc } from "./db";
import { Scheduler } from "./translate/scheduler";
import * as Imp from "./importers";
import * as T from "../shared/types";
import { renderHtml, renderMarkdown } from "./exporter";

const DEV = process.argv.includes("--dev");
let win: BrowserWindow | null = null;

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
        { type: "separator" },
        { label: "Markdown 내보내기", click: () => doExport("md") },
        { label: "HTML 내보내기", click: () => doExport("html") },
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
  try {
    await openPath(r.filePaths[0]);
  } catch (e: any) {
    dialog.showErrorBox("열 수 없습니다", e.message ?? String(e));
  }
}

async function openPath(path: string) {
  const ext = path.toLowerCase().split(".").pop();
  emit("import:progress", { stage: "read", message: basename(path) });

  if (ext === "parallax") {
    attach(Doc.open(path));
  } else {
    const target = join(dataDir(), `${basename(path).replace(/\W+/g, "_")}_${Date.now()}.parallax`);
    if (ext === "pdf") {
      const script = Imp.findSidecar(readSettings().skillDir as string | undefined);
      if (!script) {
        throw new Error(
          "PDF 추출기를 찾지 못했습니다.\n\n" +
            "pdf-ko-translate 스킬이 필요합니다:\n" +
            "  ~/.claude/skills/pdf-ko-translate\n\n" +
            "또는 환경변수 PARALLAX_SKILL_DIR 로 경로를 지정하세요.\n" +
            "이미 변환된 .parallax 나 .md 는 그대로 열 수 있습니다."
        );
      }
      const r = await Imp.importPdf(path, script, (p) => emit("import:progress", p));
      attach(
        Doc.create(
          target,
          { title: r.title, author: r.author, sourcePath: path, sourceKind: "pdf", pages: r.pages },
          r.blocks
        )
      );
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

async function doExport(fmt: "md" | "html") {
  if (!doc) return;
  const m = doc.meta();
  const r = await dialog.showSaveDialog({
    defaultPath: `${(m.title_ko || m.title || "book").replace(/[\\/:*?"<>|]/g, "_")}.${fmt}`,
  });
  if (r.canceled || !r.filePath) return;
  const blocks = doc.range(0, doc.count());
  writeFileSync(r.filePath, fmt === "md" ? renderMarkdown(m, blocks) : renderHtml(m, blocks));
  shell.showItemInFolder(r.filePath);
}

/* ── IPC ─────────────────────────────────────────────── */
function wireIpc() {
  ipcMain.handle("doc:open", async (_e, path?: string) =>
    path ? openPath(path) : pickAndOpen()
  );
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
  ipcMain.handle("export", (_e, fmt: "md" | "html") => doExport(fmt));
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
    win!.webContents.once("did-finish-load", () => openPath(fileArg).catch(() => {}));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("open-file", (e, path) => {
  e.preventDefault();
  if (win) openPath(path).catch((err) => dialog.showErrorBox("열 수 없습니다", String(err)));
});

app.on("window-all-closed", () => {
  doc?.close();
  if (process.platform !== "darwin") app.quit();
});
