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
     CSS(max-width 100% · max-height 78vh)와 같은 식이어야 한다. */
  if (it.type === "figure") {
    const a = assetMeta.get(loaded.get(it.id)?.src);
    if (a?.w && a?.h) {
      const pad = parseFloat(getComputedStyle(doc).paddingLeft) || 0;
      const availW = Math.max(160, doc.clientWidth - pad * 2);
      /* CSS 의 max-width 100% · max-height 78vh 와 같은 축소 규칙(비율 유지) */
      const scale = Math.min(availW / a.w, (innerHeight * 0.78) / a.h, 1);
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

  const body = (size / BASE.size) ** 2 * (leading / BASE.leading) * (BASE.colw / Math.max(160, colw));
  const head = size / BASE.size;
  for (const k of Object.keys(BASE_EST)) {
    estimates[k] = Math.round(BASE_EST[k] * (HEAD.has(k) ? head : body) + (HEAD.has(k) ? 0 : gap));
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

  /* 그림 — 번역 상대가 없으므로 행을 좌우로 가르지 않는다. src 는 asset id. */
  if (b.type === "figure") {
    const cell = document.createElement("div");
    cell.className = "cell fig";
    const img = document.createElement("img");
    const a = assetMeta.get(b.src);
    if (a?.w && a?.h) { img.width = a.w; img.height = a.h; }
    img.alt = a?.alt || "";
    fetchAsset(b.src).then((uri) => {
      if (uri) img.src = uri;
      img.onload = () => { measure(); rebuildTops(); };
    });
    cell.appendChild(img);
    row.appendChild(cell);
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
  handle.hidden = false;
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
function placeHandle() {
  /* 그림 행은 한 칸짜리다 — 표지 그림이 첫 행이면 손잡이가 사라진다 */
  const row = doc.querySelector(".row:not(.row-figure)");
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

document.addEventListener("mouseup", (e) => {
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

/* ── 스크롤 ──────────────────────────────────────────── */
let ticking = false;
addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const h = document.documentElement.scrollHeight - innerHeight;
    document.getElementById("prog").style.width = (h > 0 ? (scrollY / h) * 100 : 0) + "%";
    renderWindow();
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
})();
