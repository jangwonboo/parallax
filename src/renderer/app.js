/* Parallax 리더 — renderer.
   preload 가 노출한 window.parallax 외의 능력은 없다. 네트워크·파일시스템 직접 접근 없음. */

const api = window.parallax;
const root = document.documentElement;
const doc = document.getElementById("doc");
const handle = document.getElementById("handle");
const toc = document.getElementById("toc");
const tocBtn = document.getElementById("tocBtn");
const welcome = document.getElementById("welcome");
const statusEl = document.getElementById("status");

/* ── 서체 ────────────────────────────────────────────── */
const SUIT = ["SUIT Variable", '"SUIT Variable",-apple-system,sans-serif',
  "https://cdn.jsdelivr.net/gh/sun-typeface/SUIT@2.0.5/fonts/variable/woff2/SUIT-Variable.css", 400];

const FACES_SRC = [SUIT,
  ["Literata (전자책용)", '"Literata",Georgia,serif', "Literata:wght@400;700", 400],
  ["EB Garamond", '"EB Garamond",Garamond,serif', "EB+Garamond:wght@400;700", 400],
  ["Lora", '"Lora",Georgia,serif', "Lora:wght@400;700", 400],
  ["Crimson Pro", '"Crimson Pro",Georgia,serif', "Crimson+Pro:wght@400;700", 400],
  ["Libre Baskerville", '"Libre Baskerville",Baskerville,serif', "Libre+Baskerville:wght@400;700", 400],
  ["Source Serif 4", '"Source Serif 4",Georgia,serif', "Source+Serif+4:wght@400;700", 400],
  ["Spectral", '"Spectral",Georgia,serif', "Spectral:wght@400;700", 400],
  ["Newsreader", '"Newsreader",Georgia,serif', "Newsreader:wght@400;700", 400],
  ["Merriweather", '"Merriweather",Georgia,serif', "Merriweather:wght@400;700", 400],
  ["PT Serif", '"PT Serif",Georgia,serif', "PT+Serif:wght@400;700", 400],
  ["Inter (산세리프)", '"Inter",-apple-system,sans-serif', "Inter:wght@400;700", 400],
  ["Source Sans 3 (산세리프)", '"Source Sans 3",-apple-system,sans-serif', "Source+Sans+3:wght@400;700", 400],
  /* 로컬 설치 서체 — 웹폰트 없음(spec null). 이 PC 에는 사용자 폰트로 Avenir
     일가가 깔려 있고 Medium 은 weight 500 으로 잡힌다. 없으면 SUIT 로 물러난다. */
  ["Avenir Medium", '"Avenir Medium","Avenir Next","Avenir","SUIT Variable",-apple-system,sans-serif', null, 500]];

const FACES_KO = [SUIT,
  ["본명조 (Noto Serif KR)", '"Noto Serif KR",serif', "Noto+Serif+KR:wght@400;700", 400],
  ["나눔명조", '"Nanum Myeongjo",serif', "Nanum+Myeongjo:wght@400;700", 400],
  ["고운바탕", '"Gowun Batang",serif', "Gowun+Batang:wght@400;700", 400],
  ["송명", '"Song Myung",serif', "Song+Myung", 400],
  ["함렛", '"Hahmlet",serif', "Hahmlet:wght@400;700", 400],
  ["디필레이아", '"Diphylleia",serif', "Diphylleia", 400],
  ["본고딕 (Noto Sans KR)", '"Noto Sans KR",sans-serif', "Noto+Sans+KR:wght@400;700", 400],
  ["나눔고딕", '"Nanum Gothic",sans-serif', "Nanum+Gothic:wght@400;700", 400],
  ["고딕 A1", '"Gothic A1",sans-serif', "Gothic+A1:wght@400;700", 400],
  ["IBM Plex Sans KR", '"IBM Plex Sans KR",sans-serif', "IBM+Plex+Sans+KR:wght@400;700", 400],
  ["고운돋움", '"Gowun Dodum",sans-serif', "Gowun+Dodum", 400],
  ["해바라기", '"Sunflower",sans-serif', "Sunflower:wght@300;500;700", 500]];

const loadedFonts = Object.create(null);
function loadWebfont(spec) {
  if (!spec || loadedFonts[spec]) return;
  loadedFonts[spec] = true;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = /^https?:/.test(spec) ? spec
    : "https://fonts.googleapis.com/css2?family=" + spec + "&display=swap";
  document.head.appendChild(l);
}
loadWebfont(SUIT[2]);
/* UI 서체(Adobe Clean). 로컬에 없으면 이 웹폰트("adobe-clean")가 받는다 —
   helpx.adobe.com 이 쓰는 킷이라 300/400/700/800/900 이 들어 있다. */
loadWebfont("https://use.typekit.net/pps7abe.css");

/* ── 설정 ────────────────────────────────────────────── */
let settings = {};
const setVar = (k, v) => root.style.setProperty(k, v);
async function saveSetting(k, v) {
  settings[k] = v;
  await api.settings.set({ [k]: v });
}

/* ── 문서 상태 ───────────────────────────────────────── */
let meta = null;
let total = 0;
let outline = [];
let heights = Object.create(null);   // id -> px (실측 캐시)
let loaded = new Map();              // id -> block
let mounted = new Map();             // id -> row element
/* 마운트되지 않은 블록의 높이 추정치. 아래 BASE 조판에서 뽑은 값이고,
   조판이 바뀌면 recomputeEstimates() 가 비례해 고쳐 쓴다. */
/* p·h2·h3 은 191쪽 문서에서 각각 487·40·20 개를 실측해 BASE 조판으로 역산한 값이다.
   표본이 한둘뿐이던 quote·footnote·figcaption·table_raw 는 손대지 않았다. */
const BASE_EST = { h1: 90, h2: 65, h3: 42, p: 174, quote: 120, footnote: 60, figcaption: 50, table_raw: 80 };
const BASE = { size: 16, leading: 1.78, colw: 660 };
const HEAD = new Set(["h1", "h2", "h3"]);
let estimates = { ...BASE_EST };
let index = [];                      // [{id,type,h}] 전체 순서. 높이 계산용
let firstMounted = 0, lastMounted = -1;
const WINDOW_PAD = 2.5;              // 화면 배수만큼 위아래로 더 마운트

const FROM_OCR = 1, NEEDS_REVIEW = 8, NO_TRANSLATE = 16, DROPPED = 32;

/* 그림 목록(id → {mime,w,h,alt}). 데이터는 스크롤이 닿을 때 asset:get 으로. */
let assetMeta = new Map();
const assetData = new Map();         // id -> Promise<dataURI|null>

function estimateOf(it) {
  /* 그림은 상수 추정이 필요 없다 — 픽셀 크기를 아니까 표시 폭에서 정확히 나온다.
     CSS 의 max-width 60%(칸 기준, 축소만·비율 유지)와 같은 식이어야 한다. */
  if (it.type === "figure") {
    const a = assetMeta.get(loaded.get(it.id)?.src);
    if (a?.w && a?.h) {
      const cell = doc.querySelector(".cell.src");
      const paneW = cell ? cell.getBoundingClientRect().width
                         : Math.max(160, doc.clientWidth / 2);
      const scale = Math.min((paneW * 0.6) / a.w, 1);
      return Math.round(a.h * scale);
    }
  }
  return estimates[it.type] || 140;
}

/* 실측할 수 없는(마운트되지 않은) 블록의 높이를 조판에서 되짚는다.

   본문 — 줄 수는 폭에 반비례하고 글자 크기에 비례하며, 줄 하나의 높이는
   size × leading 이다. 따라서 높이 ∝ size² × leading / 폭.
   제목 — line-height 가 1.35 로 고정이라(reader.css) 줄간격을 타지 않고,
   대개 한두 줄이라 줄 수도 거의 안 변한다. 크기에만 비례시킨다. */
function recomputeEstimates() {
  const cs = getComputedStyle(root);
  const cell = doc.querySelector(".cell.src");
  /* --size 는 pt 로 들어온다. 실측 fontSize 를 읽으면 단위와 무관하게 px 이다. */
  const size = cell ? parseFloat(getComputedStyle(cell).fontSize) || BASE.size : BASE.size;
  const leading = parseFloat(cs.getPropertyValue("--leading")) || BASE.leading;
  const colw = cell ? cell.getBoundingClientRect().width : BASE.colw;
  /* 단락 여백은 줄 수와 무관하게 블록마다 한 번 더해진다. 줄 높이의 배수다. */
  const gap = (parseFloat(cs.getPropertyValue("--para-k")) || 0) * leading * size;

  /* 좌우로 놓으면 행 높이는 두 칸 중 **큰 쪽**이고, 위아래로 쌓으면 **합**이다.
     칸 폭도 함께 넓어지므로(폭이 두 배면 줄 수는 절반) 대략 상쇄되지만, 단락
     여백과 제목 여백은 두 번 들어간다. 실측이 곧 덮어쓰는 값이라 근사면 된다. */
  const stacked = layout === "tb" || layout === "bt";
  const body = (size / BASE.size) ** 2 * (leading / BASE.leading) * (BASE.colw / Math.max(160, colw));
  const head = size / BASE.size;
  for (const k of Object.keys(BASE_EST)) {
    const h = BASE_EST[k] * (HEAD.has(k) ? head : body) + (HEAD.has(k) ? 0 : gap);
    estimates[k] = Math.round(stacked ? h + (HEAD.has(k) ? head * 12 : gap) : h);
  }
}

/* ── 창 계산 ─────────────────────────────────────────── */
function offsets() {
  const tops = new Array(index.length + 1);
  tops[0] = 0;
  for (let i = 0; i < index.length; i++) tops[i + 1] = tops[i] + index[i].h;
  return tops;
}
let tops = [0];

function rebuildTops() {
  tops = offsets();
  const top = document.getElementById("spacerTop");
  const bot = document.getElementById("spacerBottom");
  if (top && bot) {
    top.style.height = tops[firstMounted] + "px";
    bot.style.height = Math.max(0, tops[index.length] - tops[lastMounted + 1]) + "px";
  }
}

function findIndexAt(y) {
  let lo = 0, hi = index.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= y) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/* ── 행 렌더 ─────────────────────────────────────────── */
const TAG = { h1: "h1", h2: "h2", h3: "h3", quote: "blockquote" };

function fetchAsset(id) {
  if (!assetData.has(id)) {
    assetData.set(id, api.asset.get(id).then(
      (a) => (a ? `data:${a.mime};base64,${a.b64}` : null)));
  }
  return assetData.get(id);
}

function makeRow(b) {
  const row = document.createElement("div");
  row.className = `row row-${b.type}`;
  row.dataset.id = b.id;

  /* 그림 — 원문·번역 양쪽 칸에 같은 그림을 하나씩 둔다. 한쪽에만 두거나 행을
     통째로 쓰면 반대쪽 대역을 읽던 눈이 그림을 놓친다. src 는 asset id 이고,
     데이터는 한 번만 받아(fetchAsset 캐시) 두 <img> 가 나눠 쓴다. */
  if (b.type === "figure") {
    const a = assetMeta.get(b.src);
    const uriP = fetchAsset(b.src);
    for (const side of ["src", "ko"]) {
      const cell = document.createElement("div");
      cell.className = `cell ${side} fig`;
      const img = document.createElement("img");
      img.alt = a?.alt || "";
      uriP.then((uri) => {
        if (uri) img.src = uri;
        img.onload = () => { measure(); rebuildTops(); };
      });
      cell.appendChild(img);
      row.appendChild(cell);
    }
    return row;
  }

  const tag = TAG[b.type] || "p";
  const cls = b.type === "footnote" || b.type === "figcaption" ? ` class="${b.type}"` : "";

  const src = document.createElement("div");
  src.className = "cell src" + (b.flags & FROM_OCR ? " read" : "");
  src.innerHTML = `<${tag}${cls}></${tag}>`;
  src.firstChild.textContent = b.src;

  const ko = document.createElement("div");
  ko.className = "cell ko" + (b.flags & NEEDS_REVIEW ? " review" : "");
  if (b.ko) {
    ko.innerHTML = `<${tag}${cls}></${tag}>`;
    ko.firstChild.textContent = b.ko;
  } else {
    ko.innerHTML = `<${tag}${cls}><span class="pending"></span><span class="pending"></span></${tag}>`;
  }

  row.append(src, ko);
  return row;
}

let spacerTop, spacerBottom;

function resetDoc() {
  doc.innerHTML = "";
  spacerTop = document.createElement("div");
  spacerTop.className = "spacer";
  spacerTop.id = "spacerTop";
  spacerBottom = document.createElement("div");
  spacerBottom.className = "spacer";
  spacerBottom.id = "spacerBottom";
  doc.append(spacerTop, spacerBottom, handle);
  /* 상하 배치에는 나눌 세로선이 없다 — 문서를 새로 열 때도 그대로 지킨다. */
  handle.hidden = layout === "tb" || layout === "bt";
  mounted.clear();
  firstMounted = 0;
  lastMounted = -1;
}

async function ensureLoaded(from, to) {
  const missing = [];
  for (let i = from; i <= to; i++) if (!loaded.has(index[i].id)) missing.push(i);
  if (!missing.length) return;
  const lo = Math.max(0, Math.min(...missing) - 20);
  const hi = Math.min(index.length - 1, Math.max(...missing) + 20);
  const rows = await api.blocks.range(lo, hi - lo + 1);
  for (const b of rows) loaded.set(b.id, b);
}

let renderPending = false;
async function renderWindow() {
  if (!index.length || renderPending) return;
  renderPending = true;
  try {
    const vh = window.innerHeight;
    const y = window.scrollY - doc.offsetTop;
    const from = Math.max(0, findIndexAt(y - vh * WINDOW_PAD));
    const to = Math.min(index.length - 1, findIndexAt(y + vh * (1 + WINDOW_PAD)));

    await ensureLoaded(from, to);

    for (const [id, el] of mounted) {
      const i = index.findIndex((x) => x.id === id);
      if (i < from || i > to) { el.remove(); mounted.delete(id); }
    }

    const frag = document.createDocumentFragment();
    for (let i = from; i <= to; i++) {
      const b = loaded.get(index[i].id);
      if (!b || mounted.has(b.id)) continue;
      const row = makeRow(b);
      mounted.set(b.id, row);
      frag.appendChild(row);
    }
    if (frag.childNodes.length) spacerBottom.before(frag);

    // 마운트 순서를 ord 순으로 정렬
    const sorted = [...mounted.entries()].sort(
      (a, b) => index.findIndex((x) => x.id === a[0]) - index.findIndex((x) => x.id === b[0])
    );
    for (const [, el] of sorted) spacerBottom.before(el);

    firstMounted = from;
    lastMounted = to;
    measure();
    rebuildTops();
    placeHandle();
    updateFocus();      // 새로 마운트된 행에도 물림을 입힌다
    paintRange();       // 낭독 영역 표시도 마운트를 따라 되살린다
    queueTranslation(from, to);
  } finally {
    renderPending = false;
  }
}

/* 실측 높이를 캐시하고 스페이서에 반영한다 */
let heightDirty = [];
function measure() {
  let changed = false;
  for (const [id, el] of mounted) {
    const h = Math.round(el.getBoundingClientRect().height);
    if (h > 0 && heights[id] !== h) {
      heights[id] = h;
      heightDirty.push([id, h]);
      const i = index.findIndex((x) => x.id === id);
      if (i >= 0) index[i].h = h;
      changed = true;
    }
  }
  if (changed && heightDirty.length > 40) flushHeights();
}
function flushHeights() {
  if (!heightDirty.length) return;
  api.blocks.setHeights(heightDirty.splice(0, heightDirty.length));
}
setInterval(flushHeights, 4000);

/* ── 번역 요청 ───────────────────────────────────────── */
let scrollIdle = null;
function queueTranslation(from, to) {
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(async () => {
    const vh = window.innerHeight;
    const y = window.scrollY - doc.offsetTop;
    const vf = findIndexAt(y), vt = findIndexAt(y + vh);
    const p0 = [], p1 = [];
    for (let i = from; i <= to; i++) {
      const b = loaded.get(index[i].id);
      if (!b || b.ko) continue;
      /* 번역 제외 블록(그림·색인·머리글)은 요청 자체를 보내지 않는다 */
      if (b.flags & (NO_TRANSLATE | DROPPED)) continue;
      (i >= vf && i <= vt ? p0 : p1).push(b.id);
    }
    if (p0.length) api.translate.request(p0, 0);
    if (p1.length) api.translate.request(p1, 1);
  }, 150);
}

/* ── 분할 손잡이 ─────────────────────────────────────── */
/* ── 배치 ────────────────────────────────────────────
   lr 원문 왼쪽 · rl 번역 왼쪽 · tb 원문 위 · bt 번역 위. 자리만 바꾸는 것이라
   블록도 스크롤 위치도 건드리지 않는다 — 높이만 다시 잡으면 된다. */
let layout = "lr";
function setLayout(v) {
  layout = ["lr", "rl", "tb", "bt"].includes(v) ? v : "lr";
  doc.dataset.layout = layout;
  saveSetting("layout", layout);
  /* 손잡이는 좌우로 놓았을 때만 뜻이 있다. 상하에서는 나눌 세로선이 없다. */
  handle.hidden = layout === "tb" || layout === "bt" || !index.length;
  invalidateHeights();
  updateFocus();
  requestAnimationFrame(placeHandle);
}

/**
 * 상하 배치에서 지금 읽는 쌍을 고르고 나머지를 물린다.
 * 기준은 화면 한가운데다 — 커서나 클릭을 따르면 스크롤만 하는 동안 초점이
 * 굳어 있고, 맨 위를 기준으로 하면 다음 쌍으로 넘어가는 순간이 너무 이르다.
 */
function updateFocus() {
  const on = layout === "tb" || layout === "bt";
  if (!on) {
    for (const el of mounted.values()) el.classList.remove("dim", "near");
    return;
  }
  const mid = innerHeight / 2;
  const rows = [...mounted.values()];
  let best = null, bestD = Infinity;
  for (const el of rows) {
    const r = el.getBoundingClientRect();
    /* 가운데를 품은 행이 있으면 그것, 없으면(빈 틈) 가장 가까운 행 */
    const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
    if (d < bestD) { bestD = d; best = el; }
  }
  for (const el of rows) {
    const near = el !== best
      && (el.previousElementSibling === best || el.nextElementSibling === best);
    el.classList.toggle("near", near);
    el.classList.toggle("dim", el !== best && !near);
  }
}

function placeHandle() {
  const row = doc.querySelector(".row");
  if (!row || row.children.length < 2) { handle.style.display = "none"; return; }
  const a = row.children[0].getBoundingClientRect();
  const c = row.children[1].getBoundingClientRect();
  if (c.left < a.right) { handle.style.display = "none"; return; }
  handle.style.display = "";
  handle.style.left = (a.right + c.left) / 2 - doc.getBoundingClientRect().left + "px";
}

let split = 50;
function setSplit(pct) {
  split = Math.min(80, Math.max(20, pct));
  setVar("--split", (split / 100).toFixed(4));
  handle.setAttribute("aria-valuenow", String(Math.round(split)));
  saveSetting("split", split);
  requestAnimationFrame(() => { invalidateHeights(); placeHandle(); });
  return split;
}
function pctFromX(x) {
  const r = doc.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(doc).paddingLeft) || 0;
  const inner = r.width - pad * 2;
  return inner > 0 ? ((x - r.left - pad) / inner) * 100 : 50;
}
function startDrag(e) {
  e.preventDefault();
  handle.classList.add("drag");
  document.body.classList.add("dragging");
  const move = (ev) => setSplit(pctFromX(ev.touches ? ev.touches[0].clientX : ev.clientX));
  const end = () => {
    handle.classList.remove("drag");
    document.body.classList.remove("dragging");
    removeEventListener("mousemove", move); removeEventListener("mouseup", end);
    removeEventListener("touchmove", move); removeEventListener("touchend", end);
  };
  addEventListener("mousemove", move); addEventListener("mouseup", end);
  addEventListener("touchmove", move, { passive: false }); addEventListener("touchend", end);
}
handle.addEventListener("mousedown", startDrag);
handle.addEventListener("touchstart", startDrag, { passive: false });
handle.addEventListener("dblclick", () => setSplit(50));
handle.addEventListener("keydown", (e) => {
  const s = e.shiftKey ? 5 : 1;
  if (e.key === "ArrowLeft") { e.preventDefault(); setSplit(split - s); }
  else if (e.key === "ArrowRight") { e.preventDefault(); setSplit(split + s); }
  else if (e.key === "Home") { e.preventDefault(); setSplit(50); }
});
document.getElementById("evenBtn").onclick = () => setSplit(50);

/* 서체·크기·폭이 바뀌면 높이 캐시가 전부 무효가 된다.
   앵커 블록을 잡아 스크롤 위치를 되살린다. */
function anchor() {
  const y = window.scrollY;
  for (const [id, el] of mounted) {
    const r = el.getBoundingClientRect();
    if (r.bottom > 0) return { id, offset: (0 - r.top) / Math.max(1, r.height) };
  }
  return null;
}
function restore(a) {
  if (!a) return;
  const el = mounted.get(a.id);
  if (!el) return;
  const r = el.getBoundingClientRect();
  window.scrollBy(0, r.top + a.offset * r.height);
}
let invalidateTimer = null;
function invalidateHeights() {
  clearTimeout(invalidateTimer);
  const a = anchor();
  invalidateTimer = setTimeout(async () => {
    heights = Object.create(null);
    api.blocks.clearHeights();
    recomputeEstimates();
    for (const it of index) it.h = estimateOf(it);
    measure();
    rebuildTops();
    await renderWindow();
    restore(a);
  }, 120);
}

/* ── 툴바 ────────────────────────────────────────────── */
/* 서체는 라벨로 저장한다 — 인덱스로 저장하면 목록에 서체를 하나 넣을 때마다
   예전 설정이 엉뚱한 서체로 되살아난다(sizePt 를 pt 로 저장하는 것과 같은
   원칙). 숫자로 저장된 예전 설정은 지금 목록의 그 자리 라벨로 한 번 옮긴다. */
function wireFace(selId, faces, faceVar, weightVar, key, dfltLabel) {
  const sel = document.getElementById(selId);
  faces.forEach((f, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = f[0];
    sel.appendChild(o);
  });
  let saved = settings[key];
  if (typeof saved === "number" || /^\d+$/.test(saved ?? "")) saved = faces[Number(saved)]?.[0];
  let i = faces.findIndex((f) => f[0] === saved);
  if (i < 0) i = Math.max(0, faces.findIndex((f) => f[0] === dfltLabel));
  sel.value = String(i);
  const apply = (idx) => {
    const f = faces[idx];
    loadWebfont(f[2]);
    setVar(faceVar, f[1]);
    setVar(weightVar, String(f[3]));
    invalidateHeights();
  };
  apply(i);
  sel.addEventListener("change", () => { apply(Number(sel.value)); saveSetting(key, faces[Number(sel.value)][0]); });
}

function wireRange(id, outId, apply, key, dflt) {
  const r = document.getElementById(id), o = document.getElementById(outId);
  r.value = settings[key] ?? dflt;
  const run = () => { apply(Number(r.value), o); invalidateHeights(); };
  run();
  r.addEventListener("input", () => { run(); saveSetting(key, Number(r.value)); });
}

/* 조판 축은 연속값이 아니라 정해진 단계로 고른다. 저장하는 값은 단계 번호라
   단계표를 바꿔도 예전 설정이 엉뚱한 크기로 되살아나지 않는다. */
function wireSteps(id, outId, steps, apply, key, dflt) {
  const r = document.getElementById(id), o = document.getElementById(outId);
  r.min = "0"; r.max = String(steps.length - 1); r.step = "1";
  let i = Number(settings[key]);
  if (!Number.isInteger(i) || i < 0 || i >= steps.length) i = dflt;
  r.value = String(i);
  const run = () => { apply(steps[Number(r.value)], o); invalidateHeights(); };
  run();
  r.addEventListener("input", () => { run(); saveSetting(key, Number(r.value)); });
}

/** 줄간격 — 글자 크기에 대한 배수라 크기를 바꾸면 저절로 따라간다. */
const LEAD_STEPS = [1.0, 1.2, 1.5, 1.8, 2.0];

/** 단락 간격 — 줄 하나의 높이(= 크기 × 줄간격)에 대한 배수.
 *
 * em(글자 크기)으로 잡으면 줄간격을 넓혔을 때 단락 사이가 상대적으로 좁아 보여
 * 단락 경계가 흐려진다. 줄 높이의 배수로 잡으면 크기와 줄간격 양쪽에 함께
 * 비례하고, 여백이 줄 높이의 정수배라 좌우 대역의 행이 계속 같은 그리드에
 * 놓인다 — 0 은 여백 없음, 0.5 는 반 줄, 1 은 빈 줄 하나다. */
const PARA_STEPS = [
  { label: "없음", k: 0 }, { label: "반 줄", k: 0.5 }, { label: "한 줄", k: 1 },
];

/* 툴바 높이는 CSS 의 --bar-h 로 고정한다 — 예전에는 실측해 덮어썼지만, 글꼴
   크기를 움직일 때마다 툴바가 따라 커져 본문이 위아래로 밀렸다. */

function setToc(open) {
  toc.dataset.open = open ? "true" : "false";
  tocBtn.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("toc-open", open);
  requestAnimationFrame(placeHandle);
  setTimeout(() => { invalidateHeights(); placeHandle(); }, 260);
}
tocBtn.onclick = () => setToc(toc.dataset.open !== "true");

/* 조판 패널 — 바에 있던 컨트롤 일곱 개가 여기로 내려왔다. 열려 있는 동안에도
   본문은 그대로 있으므로 슬라이더를 움직이며 결과를 볼 수 있다. */
const typePanel = document.getElementById("typePanel");
const typeBtn = document.getElementById("typeBtn");
function setTypePanel(open) {
  typePanel.dataset.open = open ? "true" : "false";
  typeBtn.setAttribute("aria-expanded", String(open));
}
typeBtn.onclick = (e) => {
  e.stopPropagation();
  setTypePanel(typePanel.dataset.open !== "true");
};
/* 패널 밖을 누르면 닫는다. 사전 창을 띄우는 본문 선택과 겹치지 않도록
   패널·버튼 안쪽 클릭만 통과시킨다. */
document.addEventListener("mousedown", (e) => {
  if (typePanel.dataset.open !== "true") return;
  if (typePanel.contains(e.target) || typeBtn.contains(e.target)) return;
  setTypePanel(false);
});
/* Esc 는 아래쪽 전역 처리기(사전·목차)에서 함께 받는다 — 겹쳐 등록하면
   한 번 눌렀을 때 셋이 동시에 닫힌다. */

/* 드래그 선택은 시작한 대역만 — 시작 셀의 열을 body 클래스로 표시하면 CSS 가
   반대쪽 열의 user-select 를 끈다. 셀 밖(여백)에서 시작하면 제약 없음. */
document.addEventListener("mousedown", (e) => {
  const cell = e.target.closest?.(".cell");
  document.body.classList.toggle("sel-src", !!cell && cell.classList.contains("src"));
  document.body.classList.toggle("sel-ko", !!cell && cell.classList.contains("ko"));
});

/* 넓은 화면에서 목차는 본문을 밀어낼 뿐 덮지 않는다 — 항목을 눌러도 열어둔 채로
   본문만 옮긴다. 겹쳐 뜨는 좁은 화면에서만 닫는다. */
const tocPushes = matchMedia("(min-width: 900px)");

/* 문서 열기는 앱 메뉴(파일 → 열기…, Ctrl+O)로만 한다. 빈 화면의 버튼은
   문서가 아직 없을 때의 유일한 진입점이라 남긴다. */
document.getElementById("openBtn2").onclick = () => api.doc.open();
document.getElementById("modeSel").addEventListener("change", (e) =>
  api.translate.setMode(e.target.value));

/* ── 사전 ────────────────────────────────────────────── */
const dict = document.getElementById("dict");
const dWord = document.getElementById("dWord"), dIpa = document.getElementById("dIpa");
const dKo = document.getElementById("dKo"), dEn = document.getElementById("dEn");
const dLinks = document.getElementById("dLinks");
let lastRect = null;

function closeDict() { dict.dataset.open = "false"; lastRect = null; }
document.getElementById("dClose").onclick = closeDict;

function place(rect) {
  if (!rect) return;
  lastRect = rect;
  dict.dataset.open = "true";
  const m = 10, vw = innerWidth, vh = innerHeight;
  const maxH = Math.min(24 * 16, vh * 0.6);
  const w = dict.offsetWidth;
  let top;
  if (rect.bottom + 8 + maxH <= vh - m) top = rect.bottom + 8;
  else if (rect.top - 8 - maxH >= m) top = rect.top - 8 - maxH;
  else top = Math.max(m, vh - maxH - m);
  dict.style.left = Math.min(Math.max(m, rect.left), vw - w - m) + "px";
  dict.style.top = top + "px";
}

function setLinks(word) {
  const q = encodeURIComponent(word);
  dLinks.textContent = "";
  [["네이버 영한", "https://en.dict.naver.com/#/search?query=" + q],
   ["케임브리지", "https://dictionary.cambridge.org/dictionary/english/" + q],
   ["메리엄웹스터", "https://www.merriam-webster.com/dictionary/" + q]].forEach(([t, href]) => {
    const a = document.createElement("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = t;
    dLinks.appendChild(a);
  });
}

async function showDict(word, rect) {
  dWord.textContent = word; dIpa.textContent = "";
  dKo.className = "ko-gloss spin"; dKo.textContent = "…";
  dEn.className = "spin"; dEn.textContent = "…";
  setLinks(word);
  place(rect);

  const e = await api.dict.lookup(word);
  dWord.textContent = e.word || word;
  dIpa.textContent = e.ipa || "";
  dKo.className = "ko-gloss" + (e.koOk ? "" : " muted");
  dKo.textContent = e.koOk ? e.ko : "대역을 받지 못했습니다. 네이버 사전에서 확인하세요.";
  dEn.textContent = "";
  if (e.defs.length) {
    dEn.className = "";
    for (const d of e.defs) {
      const p = document.createElement("p");
      p.className = "def";
      const pos = document.createElement("span");
      pos.className = "pos"; pos.textContent = d.pos;
      p.append(pos, document.createTextNode(d.text));
      dEn.appendChild(p);
    }
  } else {
    dEn.className = "muted";
    dEn.textContent = "표제어를 찾지 못했습니다. 아래 링크에서 확인하세요.";
  }
  place(lastRect);
}

/* 사전은 **더블클릭**으로 연다. 예전에는 고르기만 하면 떴는데, 낭독이 「낱말 하나를
   짚으면 여기부터」를 쓰면서 자리를 정할 때마다 사전이 함께 떠 본문을 가렸다.
   더블클릭은 낱말을 고르는 동작 그 자체라 손이 더 가지도 않는다. */
document.addEventListener("dblclick", (e) => {
  if (dict.contains(e.target)) return;
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return closeDict();
  const node = sel.anchorNode;
  const host = node && (node.nodeType === 1 ? node : node.parentNode);
  if (!host?.closest?.(".cell.src")) return closeDict();

  const range = sel.getRangeAt(0);
  const WORD = /[A-Za-z\u2019'\-]/;
  try {
    const sc = range.startContainer, ec = range.endContainer;
    if (sc.nodeType === 3) {
      let so = range.startOffset;
      while (so > 0 && WORD.test(sc.nodeValue.charAt(so - 1))) so--;
      range.setStart(sc, so);
    }
    if (ec.nodeType === 3) {
      let eo = range.endOffset;
      while (eo < ec.nodeValue.length && WORD.test(ec.nodeValue.charAt(eo))) eo++;
      range.setEnd(ec, eo);
    }
  } catch { /* 요소를 넘나드는 선택 */ }

  const clean = range.toString().trim().replace(/\s+/g, " ")
    .replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "");
  if (!clean || clean.length > 40 || clean.split(" ").length > 4) return closeDict();
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return closeDict();
  showDict(clean, rect);
});

/* 예전에는 다음 클릭이 곧 다음 mouseup 이라 사전이 저절로 닫혔다. 여는 동작을
   더블클릭으로 옮겼으니 닫는 길을 따로 둔다 — 밖을 한 번 누르면 닫힌다.
   (더블클릭의 첫 누름까지 닫아 버리지 않도록 detail 이 1 일 때만 본다.) */
document.addEventListener("mousedown", (e) => {
  if (dict.dataset.open !== "true" || e.detail > 1) return;
  if (!dict.contains(e.target)) closeDict();
});

/* Esc — 위에 떠 있는 것부터 하나씩 닫는다. 한 번에 다 닫으면 사전을 닫으려다
   목차까지 잃는다. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (dict.dataset.open === "true") return closeDict();
  if (typePanel.dataset.open === "true") { setTypePanel(false); return typeBtn.focus(); }
  setToc(false);
});
addEventListener("scroll", () => { if (dict.dataset.open === "true") closeDict(); }, { passive: true });

/* ── 짝 강조 ─────────────────────────────────────────── */
let marked = [];
doc.addEventListener("mouseover", (e) => {
  const cell = e.target.closest?.(".cell");
  const id = cell?.parentNode?.dataset?.id;
  if (!id) return;
  marked.forEach((n) => n.classList.remove("mate"));
  marked = [...doc.querySelectorAll(`.row[data-id="${id}"] .cell`)];
  marked.forEach((n) => n.classList.add("mate"));
});

/* ── 상태 표시줄 ─────────────────────────────────────── */
function renderStats(s) {
  if (!s) return;
  statusEl.hidden = false;
  document.getElementById("stMode").textContent =
    { viewport: "따라가기", chapter: "현재 장", all: "전체" }[s.mode] || s.mode;
  const pct = s.translatable ? (s.done / s.translatable) * 100 : 0;
  document.getElementById("stFill").style.width = pct.toFixed(1) + "%";
  document.getElementById("stCount").innerHTML =
    `<b>${s.done.toLocaleString()}</b> / ${s.translatable.toLocaleString()}` +
    (s.inFlight ? ` · 진행 ${s.inFlight}` : "");
  document.getElementById("stSpend").textContent = "$" + s.spendUsd.toFixed(2);
}

/* ── API 키 ──────────────────────────────────────────── */
const keyDlg = document.getElementById("keyDlg");
const keyInput = document.getElementById("keyInput");
const keyErr = document.getElementById("keyErr");

/** 키 값 자체는 renderer 로 오지 않는다 — 있는지/어디서 왔는지만 보여준다. */
function showKeyState(st) {
  document.getElementById("keyState").textContent =
    st.saved ? "저장된 키가 있습니다. 새 키를 넣으면 덮어씁니다."
    : st.fromEnv ? "ANTHROPIC_API_KEY 환경변수를 쓰고 있습니다."
    : "등록된 키가 없습니다.";
  document.getElementById("keyClear").hidden = !st.saved;
}

async function openKeyDialog(st) {
  showKeyState(st || (await api.keys.status()));
  keyInput.value = "";
  keyErr.hidden = true;
  keyDlg.showModal();
  keyInput.focus();
}

document.getElementById("keySave").onclick = async () => {
  const r = await api.keys.set(keyInput.value);
  if (!r.ok) { keyErr.textContent = r.reason; keyErr.hidden = false; return; }
  keyInput.value = "";
  keyDlg.close();
  document.querySelector(".notice")?.remove();
};
document.getElementById("keyClear").onclick = async () => {
  showKeyState(await api.keys.clear());
  keyInput.value = "";
};
document.getElementById("keyCancel").onclick = () => { keyInput.value = ""; keyDlg.close(); };
keyDlg.addEventListener("close", () => { keyInput.value = ""; });
keyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); document.getElementById("keySave").click(); }
});

api.on("keys:prompt", (st) => openKeyDialog(st));

/* ── 이벤트 ──────────────────────────────────────────── */
api.on("doc:opened", async (e) => {
  meta = e.meta;
  outline = e.outline;
  heights = e.heights || {};
  total = meta.blockCount;
  loaded.clear();

  assetMeta = new Map((e.assets || []).map((a) => [a.id, a]));
  assetData.clear();
  const all = await api.blocks.range(0, total);
  for (const b of all) loaded.set(b.id, b);
  index = all.map((b) => ({ id: b.id, type: b.type, h: heights[b.id] || estimateOf(b) }));

  toc.innerHTML = outline.length
    ? outline.map((h) => `<a href="#" data-id="${h.id}" data-level="${h.level}">${
        h.text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</a>`).join("")
    : "<p>목차 없음</p>";
  toc.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const i = index.findIndex((x) => x.id === a.dataset.id);
      if (i >= 0) scrollTo({ top: doc.offsetTop + tops[i] - 80, behavior: "smooth" });
      toc.querySelectorAll("a[aria-current]").forEach((x) => x.removeAttribute("aria-current"));
      a.setAttribute("aria-current", "true");
      if (!tocPushes.matches) setToc(false);
    });
  });

  welcome.remove?.();
  resetDoc();
  /* 창 제목은 늘 앱 이름이다. 문서 제목은 목차 문서에서 확인한다 — 본문 위에
     붙어 따라오던 booktitle 은 자리만 차지해서 없앴다. */

  if (e.sourceChanged || !e.hasKey) {
    const n = document.createElement("div");
    n.className = "notice";
    n.innerHTML = [
      e.sourceChanged ? "<b>원본 파일이 변경되었습니다.</b> 현재 번역본은 이전 원본을 기준으로 합니다." : "",
      !e.hasKey ? "<b>API 키가 없습니다.</b> 번역을 시작하려면 ANTHROPIC_API_KEY 환경변수를 설정하거나 키를 등록하세요." : "",
    ].filter(Boolean).join("<br>");
    if (!e.hasKey) {
      const b = document.createElement("button");
      b.textContent = "키 등록…";
      b.onclick = () => openKeyDialog();
      n.append(b);
    }
    doc.prepend(n);
  }

  rebuildTops();
  await renderWindow();

  /* 첫 렌더로 칸 폭이 정해진 뒤라야 추정치를 제대로 계산할 수 있다.
     실측된 블록은 건드리지 않는다. */
  recomputeEstimates();
  for (const it of index) if (!heights[it.id]) it.h = estimateOf(it);
  rebuildTops();

  renderStats(await api.translate.stats());
});

api.on("block:updated", async ({ ids }) => {
  const rows = await api.blocks.byIds(ids);
  for (const b of rows) {
    loaded.set(b.id, b);
    const el = mounted.get(b.id);
    if (!el) continue;
    const ko = el.querySelector(".cell.ko");
    if (!ko) continue; // 그림 행에는 번역 칸이 없다
    const tag = TAG[b.type] || "p";
    ko.innerHTML = `<${tag}></${tag}>`;
    ko.firstChild.textContent = b.ko || "";
  }
  measure();
  rebuildTops();
  renderStats(await api.translate.stats());
});

api.on("stats", renderStats);
/* 여는 중 표시 — 페이지 검증은 쪽마다 모델을 부르므로 몇 분씩 간다. 어디까지
   갔는지와 멈추는 버튼이 없으면 멈춘 것과 구분되지 않는다. */
const importing = document.getElementById("importing");
const impWhat = document.getElementById("impWhat");
const impMsg = document.getElementById("impMsg");
const IMPORT_STAGE = {
  read: "여는 중", extract: "추출 중", pagecheck: "페이지 검증 중",
  structure: "구조 정리 중", write: "저장 중",
};
document.getElementById("impCancel").onclick = () => {
  impWhat.textContent = "멈추는 중";
  api.doc.cancelImport();
};

api.on("import:progress", (p) => {
  if (p.stage === "done" || p.stage === "error") {
    importing.hidden = true;
    return;
  }
  importing.hidden = false;
  impWhat.textContent = IMPORT_STAGE[p.stage] || "여는 중";
  impMsg.textContent =
    p.stage === "pagecheck" && p.page && p.of ? `${p.page} / ${p.of}쪽` : p.message || "";

  if (p.stage === "extract" && p.message) {
    const w = document.getElementById("welcome");
    if (w) w.querySelector("p").textContent = p.message;
  }
});

/* ── 낭독 ────────────────────────────────────────────
   본문에서 무언가를 고르면 **준비**되고, 재생은 툴바에서 누른다. 고르는 순간
   소리가 나면 글을 짚어 보려던 선택마다 놀라게 된다 — 고르는 것은 「무엇을」이고
   누르는 것이 「지금」이다.

   고른 길이가 세 낱말 이하면 그것은 범위가 아니라 **자리**로 읽는다: 거기서부터
   문서 끝까지 이어 읽는다. 한 문장만 듣고 싶으면 그 문장을 고르면 되고, 여기서부터
   듣고 싶으면 한 낱말만 짚으면 된다. */
const sayBar = document.getElementById("sayBar");
const sayPlay = document.getElementById("sayPlay");
const sayStop = document.getElementById("sayStop");
const sayState = document.getElementById("sayState");
const sayVoice = document.getElementById("sayVoice");
const saySpeed = document.getElementById("saySpeed");
const sayExport = document.getElementById("sayExport");

/* NO_TRANSLATE·DROPPED 는 파일 위쪽(문서 상태)에서 선언된 것을 쓴다. */
/* 소리로 들으면 흐름이 끊기는 것들. 표 원본과 도판 설명은 글로는 읽히지만
   낭독에는 자리가 없고, 색인·참고문헌도 읽을 것이 못 된다. */
const speakable = (b) =>
  !(b.flags & (NO_TRANSLATE | DROPPED)) && b.type !== "table_raw" && b.type !== "figcaption";

let sayAudio = null, sayUrl = null;
let sayGen = 0;                 // 요청 세대. 늦게 온 답을 버리는 데 쓴다.
let sayPhase = "idle";          // idle | loading | ready | playing | paused | done | export | error
let source = null;              // 읽을거리 (makeSource)
let queue = [];                 // 계획은 됐고 아직 안 튼 조각
let ahead = null;               // { key, p } — 미리 만들어 둔 다음 조각
let cur = null;                 // 지금 트는 조각 { blockId, words, total }

/* ── 읽을거리 ──────────────────────────────────────── */
function makeSource(side, lang, mode, startIdx, items) {
  return { side, lang, mode, i: startIdx, items: items || [], it: 0, spoken: startIdx };
}

/** 다음에 읽을 블록 하나. 없으면 null. */
async function nextBlock(s) {
  if (s.mode === "sel") {
    while (s.it < s.items.length) {
      const seg = s.items[s.it++];
      if (seg.text.trim()) return seg;
    }
    return null;
  }
  /* 이어 읽기 — 문서 순서를 따라가며 읽을 수 있는 블록을 찾는다. 번역이 아직
     없는 블록은 건너뛴다(원문으로 바꿔 읽으면 언어가 문장 중간에 튄다). */
  while (s.i < index.length) {
    const at = s.i++;
    let b = loaded.get(index[at].id);
    if (!b) {
      await ensureLoaded(at, Math.min(index.length - 1, at + 40));
      b = loaded.get(index[at].id);
    }
    if (!b || !speakable(b)) continue;
    const text = (s.side === "ko" ? b.ko : b.src) || "";
    if (!text.trim()) continue;
    s.spoken = at;
    return { blockId: b.id, type: b.type, text: text.trim() };
  }
  return null;
}

const WEIGHT = (w) => w.length + (/[.!?…][)\]"'’”]*$/.test(w) ? 4 : /[,;:]$/.test(w) ? 2 : 0);

/** 조각 안의 낱말과 그 자리(블록 글 기준). 소리에 맞춰 짚으려면 자리가 필요하다. */
function wordsOf(text, base) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({ a: base + m.index, b: base + m.index + m[0].length, w: WEIGHT(m[0]) });
  }
  return out;
}

/** 큐에 조각이 둘은 있게 채운다.

    **겹쳐 부르면 안 된다.** 고르는 순간 한 번(미리 만들어 두려고), 재생을 누를 때
    또 한 번 불리는데, 첫 번째가 아직 `plan` 을 기다리는 동안 두 번째가 들어오면
    `nextBlock` 이 조각을 한 번 더 꺼내 간다. 고른 것이 한 덩어리면 두 번째 호출이
    빈손으로 돌아오고 재생은 시작하자마자 「끝」이 된다 — 모델이 처음 뜨는 1.4초
    동안 재생을 누르면 늘 이렇게 됐다(설치본 첫 실행에서 잡았다). 진행 중인 것이
    있으면 그것을 기다린다. */
let filling = null;
function fillQueue() {
  if (filling) return filling;
  filling = fillQueueOnce().finally(() => { filling = null; });
  return filling;
}

async function fillQueueOnce() {
  const s = source;
  while (s && s === source && queue.length < 2) {
    const seg = await nextBlock(s);
    if (!seg) return queue.length > 0;
    const plan = await api.tts.plan({ text: seg.text, lang: s.lang, voice: sayVoice.value });
    if (!plan || !plan.chunks || !plan.chunks.length) return queue.length > 0;
    /* 조각이 블록 글의 어디인지 되찾는다. chunkText 는 문장을 홑공백으로 이으므로
       대개 그대로 들어 있다 — 못 찾으면 낱말 짚기만 포기하고 소리는 낸다. */
    let at = 0;
    for (let i = 0; i < plan.chunks.length; i++) {
      const text = plan.chunks[i];
      const found = seg.text.indexOf(text, at);
      if (found >= 0) at = found + text.length;
      queue.push({
        jobId: plan.jobId, i, text, blockId: seg.blockId,
        words: found >= 0 ? wordsOf(text, (seg.base || 0) + found) : [],
      });
    }
  }
  return queue.length > 0;
}

/* ── 낱말 짚기 ─────────────────────────────────────
   Supertonic 의 duration_predictor 는 발화 **전체 길이 하나**만 내준다
   (`dims: [1]`, 실측 확인). 토큰별 길이가 없어 진짜 정렬은 만들 수 없다.
   그래서 조각(문장) 경계는 **정확히** 맞추고 그 안에서만 글자 수로 나눈다 —
   문장마다 다시 맞물리므로 어긋남이 한 문장 안에 갇힌다. */
const HL_OK = typeof Highlight === "function" && typeof CSS !== "undefined" && CSS.highlights;
const hlRange = HL_OK ? new Highlight() : null;   // 읽을 영역 — 옅게
const hlWord = HL_OK ? new Highlight() : null;    // 지금 읽는 낱말 — 조금 진하게
if (HL_OK) {
  /* 낱말이 영역 위에 얹혀야 한다. 우선순위가 같으면 등록 순서로 갈리지만
     명시해 두는 편이 읽는 사람에게 분명하다. */
  hlRange.priority = 1;
  hlWord.priority = 2;
  CSS.highlights.set("say-range", hlRange);
  CSS.highlights.set("say-word", hlWord);
}

/** 읽을 영역 — [{blockId, a, b}]. 가상 스크롤이 행을 지웠다 만들므로 자리로만 들고 있다. */
let sayRange = [];

function clearHL() {
  hlWord?.clear();
  hlRange?.clear();
}

/** 블록 글의 [a,b) 를 살아 있는 DOM 범위로. 마운트돼 있지 않으면 null. */
function domRange(blockId, a, b) {
  const row = mounted.get(blockId);
  const cell = row?.querySelector(source?.side === "ko" ? ".cell.ko" : ".cell.src");
  const node = cell?.firstElementChild?.firstChild;
  if (!node || node.nodeType !== 3) return null;
  const n = node.length;
  if (a >= n || b <= a) return null;
  const r = document.createRange();
  r.setStart(node, Math.max(0, a));
  r.setEnd(node, Math.min(n, b));
  return r;
}

/** 영역 표시를 다시 그린다. 스크롤로 행이 새로 붙을 때마다 불러야 한다. */
function paintRange() {
  if (!hlRange) return;
  hlRange.clear();
  for (const r of sayRange) {
    const rg = domRange(r.blockId, r.a, r.b);
    if (rg) hlRange.add(rg);
  }
}

function markWord(blockId, a, b) {
  if (!hlWord) return;
  const rg = domRange(blockId, a, b);
  hlWord.clear();
  if (rg) hlWord.add(rg);
}

/** 재생 위치 → 낱말. 조각 안에서 누적 가중치로 나눈다.

    Supertonic 의 duration_predictor 는 발화 **전체 길이 하나**만 내준다
    (`dims: [1]`, 실측 확인). 토큰별 길이가 없어 진짜 정렬은 만들 수 없다.
    그래서 조각(문장) 경계는 **정확히** 맞추고 그 안에서만 글자 수로 나눈다 —
    문장마다 다시 맞물리므로 어긋남이 한 문장 안에 갇힌다. */
function paintWord() {
  if (!cur || !cur.words.length || !sayAudio || !sayAudio.duration) return;
  const t = Math.min(1, sayAudio.currentTime / sayAudio.duration);
  let acc = 0;
  for (const w of cur.words) {
    acc += w.w;
    if (acc / cur.total >= t) return markWord(cur.blockId, w.a, w.b);
  }
  const last = cur.words[cur.words.length - 1];
  markWord(cur.blockId, last.a, last.b);
}

/* ── 따라 스크롤 ───────────────────────────────────
   손으로 스크롤하면 3초 억제한다. 없으면 앞 문단을 되짚어 보려 할 때마다
   재생 위치로 끌려가 읽을 수가 없다(spec-tts.md §6.2). */
let scrollHold = 0;
addEventListener("wheel", () => { scrollHold = Date.now() + 3000; }, { passive: true });
addEventListener("keydown", (e) => {
  if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End", " "].includes(e.key)) {
    scrollHold = Date.now() + 3000;
  }
});

function follow(blockId) {
  if (Date.now() < scrollHold) return;
  const row = mounted.get(blockId);
  if (row) {
    const r = row.getBoundingClientRect();
    if (r.top >= 80 && r.bottom <= innerHeight - 40) return;   // 이미 보인다
  }
  const i = index.findIndex((x) => x.id === blockId);
  if (i < 0 || !tops || tops[i] === undefined) return;
  scrollTo({ top: doc.offsetTop + tops[i] - 120, behavior: "smooth" });
}

/* ── 상태 ─────────────────────────────────────────── */
const PHASE_TEXT = { idle: "", loading: "준비 중…", paused: "멈춤", done: "끝" };

function paintSay(msg) {
  let text = msg !== undefined ? msg : (PHASE_TEXT[sayPhase] || "");
  if (msg === undefined && sayPhase === "playing") {
    text = source && source.mode === "tail" && index.length
      ? `읽는 중 ${Math.round((source.spoken / index.length) * 100)}%`
      : "읽는 중";
  }
  if (msg === undefined && sayPhase === "ready") {
    text = source && source.mode === "tail" ? "준비됨 · 여기부터" : "준비됨";
  }
  sayState.textContent = text;
  sayState.classList.toggle("err", sayPhase === "error");
  sayBar.dataset.ready = String(!!source);

  const playing = sayPhase === "playing";
  sayPlay.textContent = playing ? "❚❚" : "▶";
  sayPlay.setAttribute("aria-label", playing ? "일시정지" : "재생");
  sayPlay.disabled = !source || sayPhase === "loading" || sayPhase === "export";
  sayStop.disabled = !source || sayPhase === "export";
  sayExport.disabled = !source || sayPhase === "export";
}
const setSayPhase = (p, msg) => { sayPhase = p; paintSay(msg); };

/* ── 재생 ─────────────────────────────────────────── */
function dropAudio() {
  if (sayAudio) { sayAudio.onended = null; sayAudio.pause(); }
  if (sayUrl) { URL.revokeObjectURL(sayUrl); sayUrl = null; }
  clearHL();
}

function resetSay(keepSource) {
  sayGen++;
  api.tts.stop();
  dropAudio();
  queue = []; ahead = null; cur = null; filling = null;
  sayRange = [];
  if (!keepSource) source = null;
}

function stopSay() {
  resetSay(false);
  setSayPhase("idle");
}

/* 다음 조각을 지금 조각이 나오는 동안 만든다. 합성이 재생보다 네 배 빨라
   하나만 앞서면 끊기지 않는다 — 더 앞서 봐야 취소할 때 버리는 것만 는다. */
function prefetch(c) {
  ahead = c ? { key: c.jobId + "#" + c.i, p: api.tts.chunk({ jobId: c.jobId, i: c.i }) } : null;
}
function take(c) {
  const key = c.jobId + "#" + c.i;
  if (ahead && ahead.key === key) { const p = ahead.p; ahead = null; return p; }
  return api.tts.chunk({ jobId: c.jobId, i: c.i });
}

async function playNext(gen) {
  if (gen !== sayGen) return;
  if (!queue.length && !(await fillQueue())) {
    if (gen === sayGen) { clearHL(); setSayPhase("done"); }
    return;
  }
  if (gen !== sayGen) return;

  const c = queue.shift();
  const r = await take(c);
  if (gen !== sayGen) return;
  if (!r) return setSayPhase("error", "합성하지 못했습니다.");

  fillQueue().then(() => { if (gen === sayGen && queue.length) prefetch(queue[0]); });

  cur = { blockId: c.blockId, words: c.words, total: c.words.reduce((n, w) => n + w.w, 0) || 1 };
  /* 이어 읽기에는 경계가 없다(여기부터 끝까지) — 그때는 지금 읽는 블록이 영역이다.
     책 전체를 칠하면 표시가 아니라 배경이 된다. */
  if (source.mode === "tail") {
    const row = mounted.get(c.blockId);
    const cell = row?.querySelector(source.side === "ko" ? ".cell.ko" : ".cell.src");
    const len = cell?.textContent?.length ?? 0;
    sayRange = len ? [{ blockId: c.blockId, a: 0, b: len }] : [];
    paintRange();
  }
  follow(c.blockId);

  const url = URL.createObjectURL(new Blob([r.wav], { type: "audio/wav" }));
  if (!sayAudio) sayAudio = new Audio();
  sayAudio.onended = () => playNext(gen);
  sayAudio.playbackRate = Number(saySpeed.value);
  sayAudio.src = url;
  /* 새 src 를 걸고 나서 옛것을 놓는다 — 먼저 놓으면 재생 중인 소스가 사라진다. */
  if (sayUrl) URL.revokeObjectURL(sayUrl);
  sayUrl = url;
  try {
    await sayAudio.play();
    if (gen === sayGen) setSayPhase("playing");
  } catch {
    if (gen === sayGen) setSayPhase("error", "소리를 낼 수 없습니다.");
  }
}

function togglePlay() {
  if (!source) return;
  if (sayPhase === "playing") { sayAudio.pause(); return setSayPhase("paused"); }
  if (sayPhase === "paused" && sayAudio) { sayAudio.play(); return setSayPhase("playing"); }
  const gen = ++sayGen;
  setSayPhase("loading");
  playNext(gen);
}

/* 낱말 짚기와 진행률은 프레임마다가 아니라 자주-충분히. */
setInterval(() => { if (sayPhase === "playing") { paintWord(); paintSay(); } }, 120);

/* ── 고르면 준비된다 ───────────────────────────────── */
function segmentsFrom(sel, side, cell) {
  const frag = sel.getRangeAt(0).cloneContents();
  const cells = [...frag.querySelectorAll(`.cell.${side}`)];
  const typeOf = (el) => (el && el.className.match(/row-(\w+)/) || [, "p"])[1];
  /* 낱말을 짚으려면 **원문 어디**인지가 필요하다. 복제본이 들고 있는 것은 고른
     조각뿐이라 자리를 잃는다 — 살아 있는 셀에서 그 조각이 시작하는 자리를 찾아
     함께 들려 보낸다. 단락을 반만 골랐을 때 짚는 자리가 앞으로 밀리던 이유다. */
  const baseOf = (blockId, text) => {
    const live = blockId && mounted.get(blockId);
    const t = live ? (live.querySelector(`.cell.${side}`)?.textContent ?? "") : "";
    const at = t.indexOf(text);
    return at >= 0 ? at : 0;
  };

  if (!cells.length) {
    const blockId = cell?.parentElement?.dataset?.id ?? null;
    const text = sel.toString().trim();
    return [{ blockId, type: typeOf(cell?.parentElement), text, base: baseOf(blockId, text) }];
  }
  return cells
    .map((c) => {
      const blockId = c.parentElement?.dataset?.id ?? null;
      const text = c.textContent.trim();
      return { blockId, type: typeOf(c.parentElement), text, base: baseOf(blockId, text) };
    })
    .filter((s) => s.text);
}

function prepareFromSelection() {
  const sel = getSelection();
  const text = sel ? sel.toString().trim() : "";
  if (!text || sel.isCollapsed) return;

  const cellOf = (n) => ((n && n.nodeType === 1 ? n : n && n.parentElement) || null) &&
    (n.nodeType === 1 ? n : n.parentElement).closest(".cell");
  const cell = cellOf(sel.anchorNode) || cellOf(sel.focusNode)
            || cellOf(sel.getRangeAt(0).commonAncestorContainer);
  const side = cell ? (cell.classList.contains("ko") ? "ko" : "src")
             : document.body.classList.contains("sel-ko") ? "ko"
             : document.body.classList.contains("sel-src") ? "src" : null;
  if (!side) return;

  /* 오른쪽이라도 번역이 아직 없으면 원문이 그대로 보인다 — 한글이 실제로
     있는지까지 보지 않으면 한국어 음성으로 영문을 읽게 된다. */
  const ko = side === "ko" && /[가-힣]/.test(text);
  const lang = ko ? "ko" : "en";
  const words = text.split(/\s+/).length;

  resetSay(false);
  if (words <= 3) {
    /* 짧게 고른 것은 범위가 아니라 자리다 — 여기부터 끝까지. */
    const id = cell && cell.parentElement && cell.parentElement.dataset.id;
    const at = Math.max(0, index.findIndex((x) => x.id === id));
    source = makeSource(side, lang, "tail", at, null);
  } else {
    const segs = segmentsFrom(sel, side, cell);
    source = makeSource(side, lang, "sel", 0, segs);
    /* 고른 영역을 옅게 깔아 둔다 — 브라우저 선택은 다음 클릭에 사라지지만
       「무엇을 읽을 것인가」는 재생이 끝날 때까지 보여야 한다. */
    sayRange = segs.filter((g) => g.blockId)
      .map((g) => ({ blockId: g.blockId, a: g.base || 0, b: (g.base || 0) + g.text.length }));
    paintRange();
  }
  setSayPhase("ready");
  /* 첫 조각을 미리 만들어 둔다 — 누르는 순간 소리가 나야 한다. */
  fillQueue().then(() => { if (queue.length && !ahead) prefetch(queue[0]); });
}

/* 선택이 끝났을 때만 본다. selectionchange 는 드래그 내내 쏟아진다. */
let prepTimer = null;
document.addEventListener("mouseup", (e) => {
  if (!doc.contains(e.target)) return;
  clearTimeout(prepTimer);
  prepTimer = setTimeout(prepareFromSelection, 80);
});

sayPlay.addEventListener("click", togglePlay);
sayStop.addEventListener("click", stopSay);
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "t") return;
  e.preventDefault();
  togglePlay();
});

saySpeed.addEventListener("change", () => {
  if (sayAudio) sayAudio.playbackRate = Number(saySpeed.value);
  saveSetting("tts", { ...(settings.tts || {}), rate: Number(saySpeed.value) });
});
sayVoice.addEventListener("change", () => {
  saveSetting("tts", { ...(settings.tts || {}), voice: sayVoice.value });
  if (!source) return;
  /* 목소리는 다시 합성해야 바뀐다. 읽던 자리는 지키고 만들어 둔 것만 버린다. */
  const s = source, wasPlaying = sayPhase === "playing";
  resetSay(true);
  source = s;
  if (wasPlaying) togglePlay();
  else { setSayPhase("ready"); fillQueue(); }
});

/* ── mp3 내보내기 ─────────────────────────────────── */
sayExport.addEventListener("click", async () => {
  if (!source) return;
  const s = source;
  let segs;
  if (s.mode === "sel") {
    segs = s.items;
  } else {
    /* 여기부터 끝까지 — 제목마다 트랙이 하나씩 된다. */
    const rest = await api.blocks.range(s.i, index.length);
    segs = rest
      .filter((b) => speakable(b) && ((s.side === "ko" ? b.ko : b.src) || "").trim())
      .map((b) => ({ type: b.type, text: ((s.side === "ko" ? b.ko : b.src) || "").trim() }));
  }
  if (!segs.length) return;
  resetSay(true);
  source = s;
  setSayPhase("export", "내보내는 중…");
  const r = await api.tts.export({ segments: segs, lang: s.lang, voice: sayVoice.value });
  if (!r) return setSayPhase("ready");
  setSayPhase(r.cancelled ? "error" : "done",
    r.cancelled ? `${r.files.length}개만 저장하고 멈췄습니다` : `${r.files.length}개 저장했습니다`);
});

api.on("tts:state", (s) => {
  if (s.phase !== "error") return;
  console.error("[tts]", s.message);
  if (source) setSayPhase("error", s.message);
});

api.on("tts:progress", (p) => {
  if (p.phase !== "export" || sayPhase !== "export") return;
  const pct = Math.round(((p.track - 1) + p.done / Math.max(1, p.total)) / p.tracks * 100);
  sayState.textContent = p.tracks > 1
    ? `내보내는 중 ${p.track}/${p.tracks} · ${pct}%` : `내보내는 중 ${pct}%`;
});

/* ── 스크롤 ──────────────────────────────────────────── */
let ticking = false;
addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const h = document.documentElement.scrollHeight - innerHeight;
    document.getElementById("prog").style.width = (h > 0 ? (scrollY / h) * 100 : 0) + "%";
    renderWindow();
    updateFocus();      // renderWindow 는 창이 바뀔 때만 돈다 — 초점은 매 프레임 따라간다
    ticking = false;
  });
}, { passive: true });

addEventListener("resize", () => invalidateHeights());

/* ── 부팅 ────────────────────────────────────────────── */
(async function boot() {
  settings = (await api.settings.get()) || {};

  wireFace("faceSrc", FACES_SRC, "--face-src", "--weight-src", "faceSrc", "Avenir Medium");
  wireFace("faceKo", FACES_KO, "--face-ko", "--weight-ko", "faceKo", "본고딕 (Noto Sans KR)");
  /* 툴바 글자 크기는 본문을 따라가지 않는다 — reader.css 의 --ui-size 고정값. */
  wireRange("size", "sizeOut", (v, o) => {
    setVar("--size", v + "pt");
    o.textContent = v + "pt";
  }, "sizePt", 18);
  wireSteps("lead", "leadOut", LEAD_STEPS, (v, o) => {
    setVar("--leading", String(v));
    o.textContent = v.toFixed(1);
  }, "leadStep", 3);
  wireSteps("para", "paraOut", PARA_STEPS, (s, o) => {
    setVar("--para-k", String(s.k));
    /* 단락을 나누는 장치는 하나면 된다. 여백을 주면 첫 줄 들여쓰기는 뺀다 —
       둘을 겹치면 단락 머리가 두 번 표시돼 산만하다. */
    setVar("--indent", s.k > 0 ? "0" : "1em");
    o.textContent = s.label;
  }, "paraStep", 1);
  wireRange("width", "widthOut", (v, o) => {
    setVar("--maxw", v + "%");
    o.textContent = v + "%";
  }, "width", 100);
  setSplit(Number(settings.split ?? 50));

  const themeSel = document.getElementById("themeSel");
  root.dataset.theme = settings.theme || "light";
  themeSel.value = root.dataset.theme;
  themeSel.addEventListener("change", () => {
    root.dataset.theme = themeSel.value;
    saveSetting("theme", themeSel.value);
  });

  const modeSel = document.getElementById("modeSel");
  modeSel.value = settings.mode || "viewport";
  modeSel.addEventListener("change", () => saveSetting("mode", modeSel.value));

  const layoutSel = document.getElementById("layoutSel");
  layoutSel.value = settings.layout || "lr";
  setLayout(layoutSel.value);
  layoutSel.addEventListener("change", () => setLayout(layoutSel.value));

  /* ── 낭독 ──────────────────────────────────────────
     설정은 `tts` 한 덩어리로 저장한다. main 이 tts:plan·tts:export 에서 통째로
     읽어 utilityProcess 에 넘기므로, 축마다 최상위 키를 만들면 양쪽이 어긋난다. */
  const tts = settings.tts || {};

  const rate = String(tts.rate ?? 1);
  if ([...saySpeed.options].some((o) => o.value === rate)) saySpeed.value = rate;

  /* 목소리 목록은 main 이 갖고 있다(자산 리비전과 함께 움직인다). 자산이 아직
     없으면 목록도 비는데, 그때는 재생을 눌렀을 때 오류로 끝나며 이유를 말한다 —
     빈 선택지를 미리 채워 넣어 있는 척하지 않는다. */
  const voices = await api.tts.voices().catch(() => []);
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    sayVoice.append(o);
  }
  if (voices.includes(tts.voice)) sayVoice.value = tts.voice;
  paintSay();
})();
