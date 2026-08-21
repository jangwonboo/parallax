import {
  app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell, nativeTheme,
} from "electron";
import { join, basename } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { Doc } from "./db";
import { Scheduler } from "./translate/scheduler";
import * as Imp from "./importers";
import * as T from "../shared/types";
import { docTitle, renderMarkdown, renderHighlightMarkdown } from "./exporter";
import { hardWords } from "./hardwords";

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

/* 설정은 조용히 사라질 수 있는 자리다 — 실제로 그랬다(2026-08-15).
   예전 readSettings 는 **어떤 오류든** `{}` 를 돌려줬고 settings:set 은 그 위에
   패치를 병합했다. 그래서 파일이 한 번만 못 읽히면 그 다음 저장이 나머지를
   통째로 날렸다. 로그도 없고 사용자는 글꼴·테마가 저절로 바뀐 것으로 본다.

   두 겹으로 막는다. ① 쓰기를 원자적으로 — 임시 파일에 쓰고 rename 이라
   도중에 죽어도 본체가 잘리지 않는다(강제 종료가 원인이었다).
   ② 못 읽으면 덮어쓰지 말고 **옆으로 치운다** — 잃더라도 되돌릴 길은 남긴다. */
type Settings = Record<string, unknown>;

/** 값과 함께 «이 값을 믿어도 되는가»를 돌려준다. 파일이 아직 없는 것과
 *  깨진 것은 다르다 — 앞은 빈 설정이 정답이고, 뒤는 덮어쓰면 안 된다. */
function readSettingsSafe(): { data: Settings; trusted: boolean } {
  const p = settingsPath();
  if (!existsSync(p)) return { data: {}, trusted: true };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed as Settings, trusted: true };
    }
    return { data: {}, trusted: false };   // JSON 이지만 객체가 아니다
  } catch {
    return { data: {}, trusted: false };
  }
}

function readSettings(): Settings {
  return readSettingsSafe().data;
}

function writeSettings(s: Settings) {
  const p = settingsPath();
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, p);            // 같은 볼륨이라 원자적이다
}

/** 깨진 설정 파일을 시간 도장을 찍어 옆으로 옮긴다. */
function quarantineSettings(): void {
  const p = settingsPath();
  if (!existsSync(p)) return;
  const dest = `${p}.bad-${Date.now()}`;
  try {
    renameSync(p, dest);
    console.warn(`settings.json 을 읽을 수 없어 ${basename(dest)} 로 옮겼습니다. ` +
                 "설정은 기본값으로 시작합니다 — 되살리려면 그 파일을 여세요.");
  } catch (e) {
    console.warn("settings.json 격리 실패:", e);
  }
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
  /* 번역 범위는 「현재 장」 고정이다(2026-08-06, 범위 UI 제거와 함께).
     저장된 옛 모드("all"·"viewport")를 되살리지 않는다 — 고르는 손잡이가
     없는데 전량 번역이 몰래 돌면 문서를 열 때마다 돈이 샌다. */
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
      /* API 키·페이지 검증 항목은 2026-08-06 에 뺐다 — 앱은 이제 스킬이 만든
         .parallax 를 여는 리더다. 변환·검증은 스킬 CLI 몫. */
      submenu: [
        { label: "열기…", accelerator: "CmdOrCtrl+O", click: () => pickAndOpen() },
        { type: "separator" },
        { label: "Markdown 내보내기 (영·한 두 파일)", click: () => doExport() },
        { type: "separator" },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    /* role: "editMenu" 는 라벨이 영어("Edit")로 뜬다 — 항목별 role 은 살리고
       라벨만 우리말로 단다. */
    {
      label: "편집",
      submenu: [
        { role: "undo", label: "실행 취소" },
        { role: "redo", label: "다시 실행" },
        { type: "separator" },
        { role: "cut", label: "잘라내기" },
        { role: "copy", label: "복사" },
        { role: "paste", label: "붙여넣기" },
        /* 「모두 선택」은 뺐다(2026-08-21). 본문이 가상 스크롤이라 Ctrl+A 는
           **마운트된 행만** 잡는다 — 눈에 보이는 만큼만 골라 놓고 「모두」라고
           말하는 셈이라 애초에 거짓이었다. 그 자리는 형광펜이 쓴다. */
      ],
    },
    {
      label: "보기",
      submenu: [
        { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    {
      /* 설명은 렌더러가 패널로 띄운다 — dialog.showMessageBox 는 OS 룩이라
         테마(밝게·어둡게)를 따라오지 못하고, 글이 길어 스크롤도 안 된다. */
      label: "도움말",
      submenu: [
        {
          label: "기능 설명", accelerator: "F1",
          click: () => win?.webContents.send("help:show"),
        },
        { type: "separator" },
        { label: "문서 형식 설명", click: () => shell.openExternal("https://sqlite.org") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ── 열기 ────────────────────────────────────────────── */
/* .parallax 전용이다(2026-08-06). PDF·md·txt 직접 가져오기(추출·페이지 검증
   대화상자 포함)는 앱에서 뺐다 — 변환은 스킬 CLI 가 하고 앱은 결과를 읽는다.
   되살릴 일이 생기면 git 히스토리의 planPagecheck·showPagecheckReport 와
   openPath 의 확장자 분기를 꺼내면 된다. */
async function pickAndOpen() {
  const r = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Parallax 문서", extensions: ["parallax"] }],
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

async function openPath(path: string) {
  const ext = path.toLowerCase().split(".").pop();
  emit("import:progress", { stage: "read", message: basename(path) });

  if (ext !== "parallax") {
    throw new Error(
      ".parallax 문서만 열 수 있습니다.\n\n" +
        "PDF·md·txt 는 pdf2parallax 스킬로 변환한 뒤 여세요."
    );
  }
  attach(Doc.open(path));

  emit("import:progress", { stage: "done" });
  const meta = doc!.meta();
  emit("doc:opened", {
    meta,
    outline: doc!.outline(),
    heights: doc!.heights(),
    /* 그림 목록(데이터 제외) — 렌더러가 마운트 전 높이를 실제 비율로 추정한다.
       데이터는 blocks 처럼 스크롤이 닿을 때 asset:get 으로 받는다. */
    assets: doc!.assetsMeta(),
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

/** 고른 형광펜을 Markdown 한 파일로. 읽은 순서대로, 쪽 번호를 달아 낸다. */
async function exportHighlights(groupIds: string[]) {
  if (!doc || !groupIds.length) return { error: "고른 형광펜이 없습니다." };
  const rows = doc.highlights().filter((h) => groupIds.includes(h.groupId));
  if (!rows.length) return { error: "고른 형광펜이 없습니다." };

  const m = doc.meta();
  const r = await dialog.showSaveDialog({
    defaultPath: `${docTitle(m).replace(/[\/:*?"<>|]/g, "_")} — 형광펜.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };

  const md = renderHighlightMarkdown(rows, m.title_ko || m.title,
                                     await glossHighlights([...new Set(rows.map((h) => h.groupId))]));
  writeFileSync(r.filePath, md, "utf8");
  shell.showItemInFolder(r.filePath);
  return { ok: true, count: groupIds.length };
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
  ipcMain.handle("asset:get", (_e, id: string) => doc?.asset(id) ?? null);
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
    const { data, trusted } = readSettingsSafe();
    /* 못 읽은 것을 빈 설정으로 치고 그 위에 쓰면 나머지가 증발한다. 깨진
       파일은 옆으로 치우고 새로 시작하되, 원본은 남겨 되살릴 수 있게 한다. */
    if (!trusted) quarantineSettings();
    writeSettings({ ...data, ...patch });
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

  /* 형광펜. 읽기는 목록 하나로 끝난다 — 한 권에 수백 개를 넘길 일이 없어
     구간 질의를 둘 이유가 없다. */
  ipcMain.handle("hl:list", () => doc?.highlights() ?? []);
  ipcMain.handle("hl:add", (_e, frags: any[]) => doc?.addHighlight(frags) ?? null);
  ipcMain.handle("hl:remove", (_e, groupIds: string[]) =>
    doc?.removeHighlights(groupIds) ?? 0);
  ipcMain.handle("hl:export", (_e, groupIds: string[]) => exportHighlights(groupIds));
  ipcMain.handle("hl:undo", () => doc?.undoHighlight() ?? false);
  ipcMain.handle("hl:undoDepth", () => doc?.undoDepth() ?? 0);
  ipcMain.handle("hl:gloss", (_e, groupIds: string[]) => glossHighlights(groupIds));

  ipcMain.handle("dict:lookup", (_e, word: string) => lookup(word));
  ipcMain.handle("export", () => doExport());
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
  /* 뜻은 문서에도 남긴다 — 형광펜 주석이 다음 실행에도, 네트워크 없이도 뜬다.
     spec §7 이 「cache.db 에 넣는다」고 적은 자리인데, 형광펜이 붙으면서
     책과 함께 다녀야 할 이유가 생겼다. */
  if (entry.defs.length || entry.koOk) {
    try { doc?.putDefs(key, { ipa: entry.ipa, ko: entry.ko, defs: entry.defs }); } catch {}
  }
  return entry;
}

/**
 * 고른 형광펜마다 「어려운 낱말 + 영영 뜻」.
 *
 * 원문 칸만 본다 — 번역 칸에는 영어 낱말이 없다. 판정은 순수 함수이고
 * (`hardwords.ts`), 뜻은 캐시를 먼저 보고 없는 것만 밖에 나가 받아 온다.
 * 캐시는 문서 안에 있으므로 두 번째부터는 오프라인에서도 뜬다.
 */
async function glossHighlights(groupIds: string[]) {
  if (!doc || !groupIds.length) return {};
  const texts = doc.groupTexts(groupIds);
  const terms = doc.glossaryTerms();

  /* 한 낱말만 그었으면 어렵든 쉽든 찾는다 — 그 낱말이 궁금해서 그은 것이다.
     여러 낱말이면 그 안에서 어려운 것만 고른다. */
  const perGroup = new Map<string, { words: string[]; single: boolean }>();
  const need = new Set<string>();
  for (const [g, text] of texts) {
    const one = text.trim().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    const single = one.length > 1 && /^[\p{L}'’-]+$/u.test(one);
    const ws = single ? [one.toLowerCase()] : hardWords(text, terms);
    if (!ws.length) continue;
    perGroup.set(g, { words: ws, single });
    ws.forEach((w) => need.add(w));
  }
  if (!need.size) return {};

  const have = doc.cachedDefs([...need]);
  const missing = [...need].filter((w) => !have.has(w));
  /* 한 번에 여러 낱말을 받는다. 형광펜 하나에 셋뿐이라 몰려도 몇 개다. */
  await Promise.all(missing.map(async (w) => {
    const e = await lookup(w);
    if (e.defs.length || e.koOk) have.set(w, { ipa: e.ipa, ko: e.ko, defs: e.defs });
  }));

  const out: Record<string, T.Gloss[]> = {};
  for (const [g, { words, single }] of perGroup) {
    const items = words.flatMap((w): T.Gloss[] => {
      const d = have.get(w);
      if (!d || (!d.defs.length && !d.ko)) return [];
      /* 표제어를 되풀이하는 뜻은 피한다 — 무료 사전은 「indubitable: That
         which is indubitable」 같은 것을 첫 뜻으로 내놓는 일이 잦고, 그것은
         모르는 사람에게 아무것도 알려주지 않는다. */
      const stem = w.slice(0, Math.max(5, w.length - 3));
      const ranked = [...d.defs].sort(
        (a, b) => Number(a.text.toLowerCase().includes(stem)) -
                  Number(b.text.toLowerCase().includes(stem)));
      /* 한 낱말을 그었으면 뜻 둘까지, 영한도 함께. 여럿 안에서 고른 낱말은
         하나만 — 사전을 통째로 옮기면 목록이 본문보다 길어진다. */
      return [{
        word: w, ipa: d.ipa,
        ko: single ? d.ko : "",
        defs: ranked.slice(0, single ? 2 : 1),
      }];
    });
    if (items.length) out[g] = items;
  }
  return out;
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
