/* Parallax 리더 — renderer.
   preload 가 노출한 window.parallax 외의 능력은 없다. 네트워크·파일시스템 직접 접근 없음. */

const api = window.parallax;
const root = document.documentElement;
const doc = document.getElementById("doc");
const handle = document.getElementById("handle");
const toc = document.getElementById("toc");
const tocBtn = document.getElementById("tocBtn");
const welcome = document.getElementById("welcome");

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
const BASE_EST = { h1: 90, h2: 65, h3: 42, p: 174, quote: 120, footnote: 60,
                   figcaption: 50, table_raw: 80, equation: 70 };
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

  /* 행 높이는 좌우 두 칸 중 **큰 쪽**이다. 실측이 곧 덮어쓰는 값이라 근사면 된다. */
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

/* ── 수식 ────────────────────────────────────────────
   판독기가 `<math>` 로 감싸 준 LaTeX 를 파이프라인이 `$…$`(인라인)·`$$…$$`
   (별행)로 남긴다. 여기서는 그것을 KaTeX 로 그린다.

   **`$` 가 보인다고 다 수식은 아니다.** 본문에 `$5 million to $10` 같은 돈
   표기가 흔하고(실측: signals 에 10곳), 그것을 수식으로 넘기면 문장이 깨진다.
   그래서 안쪽에 LaTeX 다운 신호(역슬래시·위첨자·아래첨자·중괄호)나 수학 기호가
   있을 때만 수식으로 본다. 애매하면 글자 그대로 두는 쪽이 안전하다 — 수식이
   글로 보이는 것은 읽을 수 있지만, 문장이 수식으로 깨지면 못 읽는다. */
const MATH_SPLIT = /(\$\$[^$]+?\$\$|\$[^$\n]+?\$)/g;
const MATH_SIGNAL = /[\\^_{}]|[α-ωΑ-Ω∑∫√≈≠≤≥±×÷∞∂]/;
/* LaTeX 신호가 없어도 수식인 것들이 있다 — `$-1$` · `$dx$` · `$yz$` · `$ik'$` ·
   `$|$` 처럼 판독기가 기울임 변수·값에 붙여 준 것. 이것까지 글자로 두면 본문에
   `$dx$` 가 그대로 보인다(실측: 파인만 3권 표본에서 12곳).

   돈 표기와 가르는 기준은 **공백**이다. `$5 million and the next one $` 는
   사이에 낱말과 공백이 있고, 진짜 수식 조각(`dx` · `ik'` · `\|`)에는 없다.
   길이 상한도 둔다 — 길수록 문장일 확률이 높다.

   공백이 있어도 낱말이 없으면(`- 1` · `+ 1/2`) 수식으로 본다. */
const MATH_BARE = (s) =>
  s.length <= 16 && (!/\s/.test(s) || !/[A-Za-z]{2,}/.test(s));

/**
 * 문자열을 el 에 넣는다. 수식이 섞여 있으면 그 조각만 KaTeX 로 그린다.
 *
 * 넣으면서 **오프셋 지도**(`el.__map`)를 같이 만든다. 형광펜의 좌표는 원문
 * 문자열의 문자 오프셋인데, 화면의 DOM 은 그것과 글자수가 다르다 — KaTeX 가
 * `$x^2$` 다섯 글자를 여러 요소로 그려 놓기 때문이다. 지도가 없으면 원문
 * 좌표에서 DOM 자리를 찾을 방법이 없다.
 *
 * 지도의 항목은 둘 중 하나다.
 *   { node, from, to }            보통 텍스트 — 가운데를 잘라 칠할 수 있다
 *   { node, from, to, atomic }    수식 — 통째로만 칠한다. 안을 쪼개면 마크업이
 *                                 깨지고 식이 사라진다
 */
function setTextWithMath(el, text) {
  const map = [];
  el.__map = map;
  let at = 0;                       // 원문 문자열에서 지금까지 소비한 길이
  /* 목록은 블록 하나에 담긴 채 줄로만 나뉘어 온다(`split_inline_lists`).
     HTML 은 줄바꿈을 접으므로 표시해 두고 CSS 로 살린다 — 항목마다 블록을
     쪼개면 원문·번역이 항목 단위로 짝지어지는데, 번역이 항목 수를 그대로
     지킨다는 보장이 없다. */
  if (text && text.includes("\n")) el.classList.add("list");

  const plain = () => {
    el.textContent = text || "";
    if (el.firstChild) map.push({ node: el.firstChild, from: 0, to: (text || "").length });
  };
  if (!text || !text.includes("$")) return plain();

  const parts = String(text).split(MATH_SPLIT);
  if (parts.length === 1) return plain();

  el.textContent = "";
  for (const part of parts) {
    if (!part) continue;
    const display = part.startsWith("$$") && part.endsWith("$$") && part.length > 4;
    const inline = !display && part.startsWith("$") && part.endsWith("$") && part.length > 2;
    const tex = display ? part.slice(2, -2) : inline ? part.slice(1, -1) : null;

    if (tex === null || !(MATH_SIGNAL.test(tex) || MATH_BARE(tex))) {
      const t = document.createTextNode(part);         // 돈 표기 등 — 글자 그대로
      el.appendChild(t);
      map.push({ node: t, from: at, to: at + part.length });
      at += part.length;
      continue;
    }
    const span = document.createElement("span");
    span.className = display ? "math math-display" : "math";
    try {
      /* trust 는 기본값(false) 그대로 둔다 — \href·\includegraphics 를 막는다.
         throwOnError:false 라 깨진 LaTeX 도 렌더를 멈추지 않고 붉게 보여 준다. */
      span.innerHTML = window.katex.renderToString(tex, {
        displayMode: display, throwOnError: false, output: "html",
      });
    } catch {
      span.textContent = part;      // KaTeX 가 아직 안 왔거나 손을 못 대는 것
    }
    el.appendChild(span);
    map.push({ node: span, from: at, to: at + part.length, atomic: true });
    at += part.length;
  }
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
      /* 원본 쪽에서 차지하던 비율대로 그린다. 상한만 걸면 쪽 귀퉁이의 작은
         아이콘도 큰 도판과 같은 폭이 되어, 원서의 크기 관계가 사라진다.

         `min()` 의 두 번째 항이 **확대를 막는다** — 비율로는 크게 나와도
         제 픽셀 크기를 넘지 않는다(확대는 뭉개진다). wfrac 이 없는 옛 파일은
         CSS 의 상한(90%)만 받는다. */
      if (a?.wfrac > 0) {
        img.style.width = `min(${(a.wfrac * 100).toFixed(1)}%, ${a.w}px)`;
      }
      uriP.then((uri) => {
        if (uri) img.src = uri;
        img.onload = () => { measure(); rebuildTops(); };
      });
      cell.appendChild(img);
      row.appendChild(cell);
    }
    return row;
  }

  /* 별행 수식 — 그림과 같은 취급이다. 수식에는 언어가 없으므로 번역 칸을
     비워 두면 한쪽 대역만 읽는 눈이 식을 놓치고, 「번역 대기」 자리표시가
     영원히 남는다. 양쪽에 같은 것을 그린다. */
  if (b.type === "equation") {
    for (const side of ["src", "ko"]) {
      const cell = document.createElement("div");
      cell.className = `cell ${side} eq`;
      const p = document.createElement("div");
      setTextWithMath(p, b.src);
      cell.appendChild(p);
      row.appendChild(cell);
    }
    return row;
  }

  const tag = TAG[b.type] || "p";
  const cls = b.type === "footnote" || b.type === "figcaption" ? ` class="${b.type}"` : "";

  const src = document.createElement("div");
  src.className = "cell src" + (b.flags & FROM_OCR ? " read" : "");
  src.innerHTML = `<${tag}${cls}></${tag}>`;
  setTextWithMath(src.firstChild, b.src);

  const ko = document.createElement("div");
  ko.className = "cell ko" + (b.flags & NEEDS_REVIEW ? " review" : "");
  if (b.ko) {
    ko.innerHTML = `<${tag}${cls}></${tag}>`;
    setTextWithMath(ko.firstChild, b.ko);
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
    /* 행은 스크롤할 때마다 새로 만들어진다 — 칠도 그때마다 다시 그린다.
       DOM 에 남겨 두는 방식이었다면 여기서 사라졌을 것이다. */
    paintHighlights();
    queueTranslation();
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
/* 「따라가기」(스크롤 창만 따라 번역)는 2026-08-06 에 뺐다. 남은 둘:
   현재 장 — 눈이 머무는 장을 통째로 요청한다. 장 경계는 h1·h2 (부·장 제목).
   전체    — 스케줄러가 이미 다 물고 있으므로 보이는 블록의 우선순위만 올린다. */
let trMode = "chapter";
const isChapterHead = (it) => it.type === "h1" || it.type === "h2";
let scrollIdle = null;
function queueTranslation() {
  clearTimeout(scrollIdle);
  scrollIdle = setTimeout(async () => {
    const vh = window.innerHeight;
    const y = window.scrollY - doc.offsetTop;
    const vf = findIndexAt(y), vt = findIndexAt(y + vh);
    let lo = vf, hi = vt;
    if (trMode === "chapter") {
      while (lo > 0 && !isChapterHead(index[lo])) lo--;
      while (hi + 1 < index.length && !isChapterHead(index[hi + 1])) hi++;
    }
    const p0 = [], p1 = [];
    for (let i = lo; i <= hi; i++) {
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
   lr 원문 왼쪽 · rl 번역 왼쪽. 자리만 바꾸는 것이라 블록도 스크롤 위치도
   건드리지 않는다 — 높이만 다시 잡으면 된다.

   상하 배치(tb·bt)는 2026-08-15 사용자 지시로 걷어냈다. 함께 지운 것:
   `recomputeEstimates` 의 stacked 분기, 상하 전용 손잡이 숨김, 읽는 쌍만
   남기고 물리던 `updateFocus()`(+ `.row.dim`/`.row.near` CSS), 상하 그리드
   규칙. 되살리려면 git 히스토리. 저장된 옛 값은 아래 boot 에서 lr 로 옮긴다 —
   고르는 손잡이가 없는데 저장값만 살아 있으면 손잡이 없는 화면에 갇힌다. */
let layout = "lr";
function setLayout(v) {
  layout = v === "rl" ? "rl" : "lr";
  doc.dataset.layout = layout;
  saveSetting("layout", layout);
  handle.hidden = !index.length;
  invalidateHeights();
  requestAnimationFrame(placeHandle);
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
  /* 저장하지 않는다 — 드래그로 틀어진 비율이 실행마다 되살아나면 시작 화면이
     늘 비뚤다(실제로 46.9% 로 굳어 있었다). 조절은 그 세션 안에서만 산다. */
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

/* ── 목차 이동·강조 ──────────────────────────────────
   툴바는 붙박이라 목표 블록을 그냥 화면 맨 위로 보내면 바 뒤에 숨는다.
   높이는 실측한다 — --bar-h 는 rem 이라 parseFloat 로는 px 이 안 나온다. */
const LANDING_GAP = 8;   // 바 아래 숨 쉴 자리
const barEl = document.querySelector(".bar");
const barH = () => (barEl ? barEl.getBoundingClientRect().height : 0);

/* tops[] 의 0 은 doc 의 위쪽이 아니라 **안여백을 지난** 첫 행의 위쪽이다
   (.doc 의 padding-top 2.5rem). doc.offsetTop 만 더하면 그만큼 늘 어긋난다 —
   예전 `-80` 이 어정쩡했던 까닭의 절반이 이것이었다. */
function docTop() {
  return doc.getBoundingClientRect().top + scrollY
    + (parseFloat(getComputedStyle(doc).paddingTop) || 0);
}

/**
 * 목차 항목이 가리키는 블록을 툴바 바로 아래에 세운다.
 *
 * 한 번에 못 간다. tops[] 는 마운트되지 않은 블록에 대해 조판에서 되짚은
 * **추정치**라(§가상 스크롤, 실측 오차 ±6%) 먼 장으로 뛰면 도착점이 이미
 * 어긋나 있고, 도착한 뒤 renderWindow → measure → rebuildTops 가 실측으로
 * 덮어쓰면서 목표가 **스크롤이 끝난 뒤에 또 움직인다**. 그래서 뛰고-실측하고-
 * 남은 차이만큼 다시 뛰기를 자리가 굳을 때까지 되풀이한다.
 *
 * 마지막 한 걸음은 추정치가 아니라 **마운트된 행의 실제 위치**로 잰다. 일단
 * 가까이만 가면 목표 행이 DOM 에 올라오므로, 그때부터는 추정 오차도 안여백
 * 계산도 끼어들 자리가 없다.
 *
 * behavior 는 "auto" 다. 추정치 위로 부드럽게 미끄러진 뒤 보정하면 두 번
 * 움직이는 것이 그대로 보인다 — 한 번에 제자리로 가는 편이 낫다.
 */
let landing = 0;
async function gotoBlock(id) {
  const i = index.findIndex((x) => x.id === id);
  if (i < 0) return;
  landing++;
  try {
    for (let pass = 0; pass < 5; pass++) {
      const el = mounted.get(id);
      const y = el
        ? scrollY + el.getBoundingClientRect().top     // 실측 — 정확하다
        : docTop() + tops[i];                          // 아직 멀다 — 추정으로 다가간다
      const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      const want = Math.min(max, Math.max(0, y - barH() - LANDING_GAP));
      if (Math.abs(scrollY - want) < 1) break;
      scrollTo({ top: want, behavior: "auto" });
      await renderWindow();          // 도착지 둘레를 실제로 마운트해 실측한다
      /* 스크롤 이벤트 쪽이 먼저 물고 있으면 위 호출은 아무것도 안 하고 돌아온다.
         그 경우에만 한 박자 쉬고 다시 부른다 — 아니면 추정치로 헛돈다. */
      if (renderPending) {
        await new Promise((r) => setTimeout(r, 32));
        await renderWindow();
      }
    }
  } finally {
    landing--;
  }
  updateTocMark();
}

/* ── 목차 트리 ───────────────────────────────────────
   레벨(h1/h2/h3)은 outline 에 이미 실려 온다 — 수사·제목 병합과 본문 오탐
   거르기는 main 의 `Doc.outline()` 이 끝내고 보낸다. 여기서는 그리기만 한다.

   깊이는 레벨 숫자가 아니라 **스택으로 정한다.** h1 다음에 곧바로 h3 가 오는
   책에서 레벨을 그대로 들여쓰면 쓰지도 않는 단계만큼 밀린다. */
function tocTree(items) {
  const root = { level: 0, children: [] };
  const stack = [root];
  for (const h of items) {
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
    const node = { ...h, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

/* 처음에는 깊이 0 만 펼친다(= 두 단계까지 보인다). signals 는 절이 249개라
   다 펼치면 목차가 318줄이고, 그러면 계층을 만든 뜻이 없다. */
const TOC_OPEN_DEPTH = 0;

function setBranch(li, open) {
  li.dataset.open = open ? "true" : "false";
  const tw = li.querySelector(":scope > .item > .twist");
  if (tw) {
    tw.setAttribute("aria-expanded", String(open));
    tw.setAttribute("aria-label", open ? "접기" : "펼치기");
  }
}

function tocList(nodes, depth) {
  const ul = document.createElement("ul");
  ul.className = "tree";
  for (const n of nodes) {
    const li = document.createElement("li");
    const item = document.createElement("div");
    item.className = "item";

    const a = document.createElement("a");
    a.href = "#";
    a.dataset.id = n.id;
    a.dataset.level = String(n.level);
    a.textContent = n.text;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      markToc(a);                    // 착지를 기다리지 않고 곧바로 응답한다
      gotoBlock(n.id);
      if (!tocPushes.matches) setToc(false);
    });

    if (n.children.length) {
      const sub = tocList(n.children, depth + 1);
      sub.id = `tocsub-${n.id}`;
      const tw = document.createElement("button");
      tw.type = "button";
      tw.className = "twist";
      tw.setAttribute("aria-controls", sub.id);
      /* 손잡이는 항목을 여는 것이 아니라 가지를 접는 것이다 — 클릭이 위로
         새어 나가 본문이 따라 움직이면 안 된다. */
      tw.addEventListener("click", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        setBranch(li, li.dataset.open !== "true");
      });
      item.append(tw, a);
      li.append(item, sub);
      setBranch(li, depth <= TOC_OPEN_DEPTH);
    } else {
      item.append(a);
      li.append(item);
    }
    ul.append(li);
  }
  return ul;
}

function renderToc(items) {
  toc.textContent = "";
  if (!items.length) {
    const p = document.createElement("p");
    p.textContent = "목차 없음";
    toc.append(p);
    return;
  }
  toc.append(tocList(tocTree(items).children, 0));
}

/* outline 은 문서 순이지만 담고 있는 것은 블록 id 다. 스크롤 위치로 훑으려면
   index 안의 자리로 바꿔 둬야 한다 — 문서를 열 때 한 번 만든다. */
let outlinePos = [];
let tocLinks = [];
let tocMarked = null;

function buildTocIndex() {
  /* index 에 없는 항목은 아예 뺀다 — 자리로 -1 이 섞이면 아래 이분 탐색이
     기대는 오름차순이 깨진다. */
  tocLinks = []; outlinePos = []; tocMarked = null;
  const pos = new Map(index.map((x, i) => [x.id, i]));
  for (const a of toc.querySelectorAll("a[data-id]")) {
    const p = pos.get(a.dataset.id);
    if (p === undefined) continue;
    tocLinks.push(a); outlinePos.push(p);
  }
}

function markToc(a) {
  if (tocMarked === a) return;
  tocMarked?.removeAttribute("aria-current");
  tocMarked = a || null;
  if (!a) return;
  a.setAttribute("aria-current", "true");
  /* 접힌 가지 안이면 펼친다 — 읽고 있는 자리가 목차에서 사라지면 안 된다.
     펼치기만 하고 접지는 않는다. 지나온 가지를 도로 닫으면 손으로 펼쳐 둔
     것까지 쓸려 나가고, 스크롤을 되돌릴 때마다 목차가 여닫힌다. */
  for (let li = a.closest("li")?.parentElement?.closest("li"); li;
       li = li.parentElement?.closest("li")) {
    if (li.dataset.open === "false") setBranch(li, true);
  }
  /* 목차를 열어둔 채 읽으므로 강조가 패널 밖으로 나가면 따라 올린다. 늘
     가운데로 끌면 목차를 눈으로 훑는 동안 발밑이 움직인다 — 벗어날 때만. */
  if (toc.dataset.open !== "true") return;
  const ar = a.getBoundingClientRect(), tr = toc.getBoundingClientRect();
  if (ar.top < tr.top + 4 || ar.bottom > tr.bottom - 4) {
    toc.scrollTop += ar.top - tr.top - tr.height / 3;
  }
}

/**
 * 화면 맨 위(툴바 아래)에 걸린 블록이 속한 제목을 강조한다.
 *
 * 걸린 블록은 tops[] 로 역산하지 않고 **마운트된 행의 실제 위치**에서 찾는다.
 * tops[] 는 창 밖 블록에 대해 추정치라 문서 끝으로 갈수록 오차가 쌓여, 실측
 * 에서 마지막 구간의 강조가 한 장 뒤처졌다. 창 안은 어차피 다 DOM 에 있으니
 * 훑으면 그만이다(30~40행 — measure() 가 이미 같은 수를 읽는다). */
function updateTocMark() {
  if (landing || !tocLinks.length || !index.length) return;
  const line = barH() + LANDING_GAP + 1;
  let i = -1;
  for (let k = firstMounted; k <= lastMounted; k++) {
    const el = mounted.get(index[k].id);
    if (el && el.getBoundingClientRect().bottom > line) { i = k; break; }
  }
  /* 창이 아직 없거나 전부 판정선 위에 있으면 추정으로 물러난다 */
  if (i < 0) i = lastMounted >= 0 ? lastMounted : findIndexAt(scrollY - docTop() + line);
  /* 자리가 i 이하인 마지막 제목. outlinePos 는 오름차순이라 이분 탐색. */
  let lo = 0, hi = outlinePos.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (outlinePos[mid] <= i) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  markToc(best >= 0 ? tocLinks[best] : null);
}

/* 문서 열기는 앱 메뉴(파일 → 열기…, Ctrl+O)로만 한다. 빈 화면의 버튼은
   문서가 아직 없을 때의 유일한 진입점이라 남긴다. */
document.getElementById("openBtn2").onclick = () => api.doc.open();

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

/* 조회 순번 — 낱말을 잇달아 짚으면 먼저 보낸 조회가 **뒤에 도착해** 지금
   보고 있는 표제어를 덮어썼다(실측: `here` 를 짚었는데 앞서 짚은 `don't` 가
   떠 있었다). 늦게 온 응답은 버린다. */
let dictSeq = 0;

async function showDict(word, rect) {
  const seq = ++dictSeq;
  dWord.textContent = word; dIpa.textContent = "";
  dKo.className = "ko-gloss spin"; dKo.textContent = "…";
  dEn.className = "spin"; dEn.textContent = "…";
  setLinks(word);
  place(rect);

  const e = await api.dict.lookup(word);
  if (seq !== dictSeq) return;          // 그 사이에 다른 낱말을 짚었다
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

/* 사전은 **더블클릭**으로 연다. 고르기만 하면 뜨던 시절에는 글을 짚어 보려는
   선택마다 사전이 함께 떠 본문을 가렸다. 더블클릭은 낱말을 고르는 동작 그
   자체라 손이 더 가지도 않는다. */
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

    /* ① 먼저 **안쪽으로 줄인다.** 크로미엄의 낱말 선택은 뒤따르는 공백까지
       물고 오는 일이 잦다(실측: `Common` 더블클릭 → `Common `). 그 상태로
       ②를 돌리면 끝이 공백 바로 뒤 글자에서 출발해 **다음 낱말을 통째로
       삼킨다** — 사전이 `Common Marketing` 을 찾던 까닭이 이것이다. */
    if (ec.nodeType === 3) {
      const floor = sc === ec ? range.startOffset : 0;
      let eo = range.endOffset;
      while (eo > floor && !WORD.test(ec.nodeValue.charAt(eo - 1))) eo--;
      if (eo > floor) range.setEnd(ec, eo);
    }
    if (sc.nodeType === 3) {
      const ceil = sc === ec ? range.endOffset : sc.nodeValue.length;
      let so = range.startOffset;
      while (so < ceil && !WORD.test(sc.nodeValue.charAt(so))) so++;
      if (so < ceil) range.setStart(sc, so);
    }

    /* ② 그 다음에야 낱말 경계까지 **바깥으로 편다** — 선택이 낱말 가운데를
       자른 경우를 살린다. 이제 양 끝이 낱말 문자에 붙어 있어 공백을 건너뛸
       일이 없다. */
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

    /* 화면의 칠도 실제로 고른 낱말에 맞춘다 — 범위만 고치고 두면 선택이
       공백·다음 낱말까지 덮인 채로 남는다. */
    sel.removeAllRanges();
    sel.addRange(range);
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

/* ── 기능 설명(도움말 → 기능 설명, F1) ───────────────
   메뉴가 IPC 로 부르면 뜬다. 내용은 index.html 에 있다 — 붙박이 글이라
   렌더러가 만들 것이 없고, 번역·조판과 달리 상태도 없다. */
const help = document.getElementById("help");
const helpScrim = document.getElementById("helpScrim");
function setHelp(open) {
  help.dataset.open = open ? "true" : "false";
  helpScrim.hidden = !open;
  if (open) { help.scrollTop = 0; help.focus(); }
}
document.getElementById("helpClose").onclick = () => setHelp(false);
helpScrim.addEventListener("mousedown", () => setHelp(false));
api.on("help:show", () => setHelp(help.dataset.open !== "true"));

/* Esc — 위에 떠 있는 것부터 하나씩 닫는다. 한 번에 다 닫으면 사전을 닫으려다
   목차까지 잃는다. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (help.dataset.open === "true") return setHelp(false);
  if (dict.dataset.open === "true") return closeDict();
  /* 선택 모드는 패널보다 안쪽이다 — 한 번에 둘 다 닫으면 체크를 물리려다
     목록까지 잃는다. */
  if (hlPicking) return setHlPicking(false);
  if (hlPane.dataset.open === "true") return setHlPane(false);
  if (typePanel.dataset.open === "true") { setTypePanel(false); return typeBtn.focus(); }
  setToc(false);
});
addEventListener("scroll", () => { if (dict.dataset.open === "true") closeDict(); }, { passive: true });

/* ── 짝 강조 ─────────────────────────────────────────── */
let marked = [];
function clearMate() {
  marked.forEach((n) => n.classList.remove("mate"));
  marked = [];
}
doc.addEventListener("mouseover", (e) => {
  const cell = e.target.closest?.(".cell");
  const id = cell?.parentNode?.dataset?.id;
  if (!id) return;
  clearMate();
  marked = [...doc.querySelectorAll(`.row[data-id="${id}"] .cell`)];
  marked.forEach((n) => n.classList.add("mate"));
});
/* 본문을 벗어나면 푼다. 없으면 커서가 툴바·목차로 간 뒤에도 마지막 단락이
   켜진 채로 남는다 — `:hover` 는 저절로 풀리므로 커서 쪽 칸만 꺼지고 **반대쪽
   칸만 남아** 짝이 아닌 것이 짝처럼 보인다. 사라지는 페이드가 가장 잘 보여야
   할 순간이 바로 여기다. */
doc.addEventListener("mouseleave", clearMate);

/* ── 형광펜 ──────────────────────────────────────────
   글을 긁고 Alt+H. 원문 칸과 번역 칸은 서로를 모른다 — spec §6.2 가 낱말 단위
   좌우 연동을 접은 것과 같은 이유다. 정렬 정보가 없으므로 한쪽에 그은 것을
   반대쪽 어디에 옮길지 알 방법이 없다. 그래서 아예 옮기지 않는다.

   좌표는 DOM 이 아니라 **블록 원문 문자열의 문자 오프셋**이다. 리더가 가상
   스크롤이라 행은 스크롤할 때마다 지워졌다 다시 만들어진다 — DOM 에 칠해 두면
   스크롤 한 번에 사라진다. 칠은 늘 데이터에서 다시 그린다. */

/* 아이콘은 인라인 SVG 다. 이모지(🗑)는 OS 가 제 색으로 그려서 테마를 따라오지
   못하고 크기도 서체마다 다르다. SVG 는 currentColor 를 받는다. */
const ICON = {
  trash: "M3 5h10M6.5 5V3.5h3V5M4.5 5l.6 8.5h5.8L11.5 5M6.6 7.3v4M9.4 7.3v4",
  export: "M8 2.5v7.5M5 7l3 3 3-3M3 12.5h10",
};
function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICON[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.3");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

const HL_NAME = "parallax-hl";
let hlRows = [];                 // DB 의 조각들(ord 순)
let hlGroups = [];               // 화면 목록 — 조각을 groupId 로 묶은 것
const hlByBlock = new Map();     // blockId -> 조각[]

/** 블록의 한쪽 글. 조각의 좌표가 가리키는 바로 그 문자열이다. */
function sideText(b, side) {
  if (!b) return null;
  return side === "src" ? (b.src || "") : (b.ko || "");
}

/** 조각이 아직 제자리인가. 번역은 재번역·deslop 으로 바뀐다. */
function hlFresh(f) {
  const t = sideText(loaded.get(f.blockId), f.side);
  return t != null && t.slice(f.start, f.end) === f.text;
}

function reindexHighlights() {
  hlByBlock.clear();
  for (const f of hlRows) {
    if (!hlByBlock.has(f.blockId)) hlByBlock.set(f.blockId, []);
    hlByBlock.get(f.blockId).push(f);
  }
  /* 목록은 그룹 단위다. 한 번의 드래그가 세 단락에 걸쳤어도 사용자에게는
     하나이므로 한 줄이고, 삭제도 한 번이어야 한다. */
  const seen = new Map();
  for (const f of hlRows) {
    if (!seen.has(f.groupId)) {
      seen.set(f.groupId, {
        groupId: f.groupId, side: f.side, page: f.page, ord: f.ord,
        parts: [], stale: false,
      });
    }
    const g = seen.get(f.groupId);
    g.parts.push(f.text);
    if (!hlFresh(f)) g.stale = true;
  }
  hlGroups = [...seen.values()];
}

async function loadHighlights() {
  hlRows = await api.highlight.list();
  reindexHighlights();
  paintHighlights();
  renderHlPane();
}

/* ── 칠하기 ──────────────────────────────────────────
   텍스트 노드를 <mark> 로 쪼개지 않는다. 쪼개면 setTextWithMath 가 만들어 둔
   오프셋 지도가 그 자리에서 무효가 되고, 같은 블록의 다음 형광펜이 어긋난다.
   CSS Custom Highlight API 는 DOM 을 건드리지 않고 Range 만 칠한다. */

/** 원문 오프셋 [from,to) 를 el 안의 Range 들로. 수식은 통째로만 잡는다. */
function rangesFor(el, from, to) {
  const out = [];
  for (const m of el.__map || []) {
    if (m.to <= from || m.from >= to) continue;
    const r = document.createRange();
    if (m.atomic) {
      r.selectNode(m.node);            // 안을 쪼개면 식이 깨진다
    } else {
      r.setStart(m.node, Math.max(0, from - m.from));
      r.setEnd(m.node, Math.min(m.node.nodeValue.length, to - m.from));
    }
    out.push(r);
  }
  return out;
}

function paintHighlights() {
  if (!window.CSS?.highlights || typeof Highlight === "undefined") return;
  const ranges = [];
  for (const [id, row] of mounted) {
    const frags = hlByBlock.get(id);
    if (!frags) continue;
    for (const f of frags) {
      if (!hlFresh(f)) continue;       // 번역이 바뀐 자리 — 칠하지 않는다
      const el = row.querySelector(`.cell.${f.side}`)?.firstChild;
      if (el) ranges.push(...rangesFor(el, f.start, f.end));
    }
  }
  if (ranges.length) CSS.highlights.set(HL_NAME, new Highlight(...ranges));
  else CSS.highlights.delete(HL_NAME);
}

/* ── 선택 → 원문 오프셋 ──────────────────────────────── */

/** DOM 자리(node, offset)가 el 의 원문 문자열에서 몇 번째 글자인가. */
function srcOffsetOf(el, node, offset) {
  const map = el.__map || [];
  for (const m of map) {
    if (m.node === node) {
      return m.atomic ? (offset > 0 ? m.to : m.from) : m.from + offset;
    }
    /* 수식 안쪽을 짚은 경우 — KaTeX 가 만든 자손이다. 통째로 친다. */
    if (m.atomic && m.node.contains?.(node)) return m.from;
  }
  /* el 자신을 짚었다면 offset 은 자식 번호다. */
  if (node === el) {
    const child = el.childNodes[offset];
    const hit = map.find((m) => m.node === child);
    if (hit) return hit.from;
    return map.length ? map[map.length - 1].to : 0;
  }
  return null;
}

/** 지금 선택이 걸친 칸마다 조각 하나. 칸을 못 읽으면 건너뛴다. */
function fragmentsFromSelection(sel) {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
  const range = sel.getRangeAt(0);
  const out = [];
  for (const [id, row] of mounted) {
    for (const side of ["src", "ko"]) {
      const cell = row.querySelector(`.cell.${side}`);
      const el = cell?.firstChild;
      if (!el || !el.__map || !range.intersectsNode(cell)) continue;

      const whole = sideText(loaded.get(id), side);
      if (whole == null || !whole.length) continue;

      let start = 0, end = whole.length;
      if (cell.contains(range.startContainer)) {
        const v = srcOffsetOf(el, range.startContainer, range.startOffset);
        if (v != null) start = v;
      }
      if (cell.contains(range.endContainer)) {
        const v = srcOffsetOf(el, range.endContainer, range.endOffset);
        if (v != null) end = v;
      }
      if (end <= start) continue;
      const text = whole.slice(start, end);
      if (!text.trim()) continue;          // 공백만 긁힌 칸
      out.push({ blockId: id, side, start, end, text });
    }
  }
  if (!out.length) return [];

  /* 한 그룹은 한쪽 칸에만 있어야 한다. 목록 항목에 「원문」이나 「번역」 딱지를
     하나만 다는데 조각이 두 칸에 걸쳐 있으면 그 딱지가 거짓이 된다.

     마우스로는 일어나지 않는다 — CSS 가 시작한 쪽 대역만 잡히게 막는다
     (`body.sel-src .cell.ko { user-select: none }`). 그래도 걸러 둔다.
     막아 주는 것이 다른 파일의 CSS 한 줄뿐이면 언젠가 뚫린다. */
  const anchor = out.find((f) =>
    document.querySelector(`.row[data-id="${f.blockId}"] .cell.${f.side}`)
      ?.contains(sel.anchorNode));
  const side = anchor?.side ?? out[0].side;
  const kept = out.filter((f) => f.side === side);

  /* 읽기 순서대로 — 목록의 미리보기가 긁은 순서대로 이어진다. */
  const pos = new Map(index.map((x, i) => [x.id, i]));
  kept.sort((a, b) => (pos.get(a.blockId) ?? 0) - (pos.get(b.blockId) ?? 0));
  return kept;
}

async function addHighlightFromSelection() {
  const sel = getSelection();
  const frags = fragmentsFromSelection(sel);
  if (!frags.length) return;
  await api.highlight.add(frags);
  sel.removeAllRanges();               // 칠이 보이도록 파란 선택을 걷는다
  await loadHighlights();
  if (hlPane.dataset.open !== "true") setHlPane(true);
}

async function removeHighlights(groupIds) {
  if (!groupIds.length) return;
  await api.highlight.remove(groupIds);
  await loadHighlights();
}

/* ── 오른쪽 패널 ─────────────────────────────────────── */

const hlPane = document.getElementById("hlPane");
const hlList = document.getElementById("hlList");
const hlBtn = document.getElementById("hlBtn");
const hlCount = document.getElementById("hlCount");
const hlPick = document.getElementById("hlPick");
const hlBulk = document.getElementById("hlBulk");
const hlDelBtn = document.getElementById("hlDelBtn");
const hlAllBtn = document.getElementById("hlAllBtn");
const hlExpBtn = document.getElementById("hlExpBtn");
hlDelBtn.appendChild(icon("trash"));
hlExpBtn.appendChild(icon("export"));

let hlPicking = false;               // 선택 모드인가
const hlChecked = new Set();

function setHlPane(open) {
  hlPane.dataset.open = open ? "true" : "false";
  hlBtn.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("hl-open", open);
  /* 본문 폭이 바뀐다 — 목차를 열 때와 같은 처리가 필요하다. 안 하면 손잡이가
     엉뚱한 자리에 서고 가상 스크롤의 높이 추정이 어긋난다. */
  setTimeout(() => { invalidateHeights(); placeHandle(); }, 260);
  if (!open) setHlPicking(false);
}

function setHlPicking(on) {
  hlPicking = on;
  hlChecked.clear();
  hlPane.dataset.picking = on ? "true" : "false";
  hlPick.textContent = on ? "취소" : "선택";
  hlBulk.hidden = !on;
  renderHlPane();
}


function renderHlPane() {
  hlCount.textContent = hlGroups.length ? String(hlGroups.length) : "";
  hlList.textContent = "";

  if (!hlGroups.length) {
    const empty = document.createElement("p");
    empty.className = "hl-empty";
    empty.textContent = "글을 긁고 Alt+H 를 누르면 여기 쌓입니다.";
    hlList.appendChild(empty);
    hlPick.hidden = true;
    return;
  }
  hlPick.hidden = false;

  for (const g of hlGroups) {
    const li = document.createElement("div");
    li.className = "hl-item" + (g.stale ? " stale" : "");
    li.dataset.group = g.groupId;

    if (hlPicking) {
      /* radio 가 아니라 checkbox 다. radio 는 한 그룹에서 하나만 골라지므로
         「복수 선택 후 일괄삭제」와 애초에 맞지 않는다. */
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "hl-check";
      box.checked = hlChecked.has(g.groupId);
      box.setAttribute("aria-label", "선택");
      box.addEventListener("change", () => {
        if (box.checked) hlChecked.add(g.groupId); else hlChecked.delete(g.groupId);
        syncBulk();
      });
      li.appendChild(box);
    }

    const main = document.createElement("button");
    main.className = "hl-main";
    main.type = "button";
    /* 「원문 p.7」 같은 위치줄은 달지 않는다. 항목마다 한 줄씩 먹는데,
       어느 쪽 글인지는 서체(영문·한글)가 이미 말해 준다. */
    const body = document.createElement("span");
    body.className = "hl-text";
    body.dataset.side = g.side;      // 본문과 같은 서체를 고르는 근거
    body.textContent = g.parts.join(" … ");
    main.append(body);
    if (g.stale) {
      const warn = document.createElement("span");
      warn.className = "hl-warn";
      warn.textContent = "번역이 바뀌었습니다";
      main.appendChild(warn);
    }
    /* 선택 모드에서는 이동이 아니라 체크다 — 두 동작이 같은 자리를 다투면
       무엇이 일어날지 손이 알 수 없다. */
    main.addEventListener("click", () => {
      if (hlPicking) {
        const box = li.querySelector(".hl-check");
        box.checked = !box.checked;
        box.dispatchEvent(new Event("change"));
        return;
      }
      const first = hlRows.find((f) => f.groupId === g.groupId);
      if (first) gotoBlock(first.blockId);
    });
    li.appendChild(main);

    /* 🗑 은 선택 모드에서 감춘다 — 체크해 둔 것이 있는데 다른 항목의 🗑 을
       누르면 무엇이 지워져야 하는지 답이 없다. 모드가 두 길을 배타로 만든다. */
    if (!hlPicking) {
      const del = document.createElement("button");
      del.className = "hl-del";
      del.type = "button";
      del.title = "이 형광펜 지우기";
      del.setAttribute("aria-label", "지우기");
      del.appendChild(icon("trash"));
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        removeHighlights([g.groupId]);
      });
      li.appendChild(del);
    }
    hlList.appendChild(li);
  }
  syncBulk();
}

function syncBulk() {
  const n = hlChecked.size;
  hlDelBtn.disabled = !n;
  hlExpBtn.disabled = !n;
  /* 개수는 아이콘 옆 글자가 아니라 툴팁으로 — 아이콘 버튼의 폭이 고른 수에
     따라 들썩이면 손이 겨눈 자리가 자꾸 달라진다. */
  hlDelBtn.title = n ? `고른 ${n}개 지우기` : "고른 것 지우기";
  hlExpBtn.title = n ? `고른 ${n}개 내보내기` : "고른 것을 파일로 내보내기";
  hlAllBtn.textContent = n === hlGroups.length && n > 0 ? "모두 해제" : "모두";
}

hlBtn.addEventListener("click", () => setHlPane(hlPane.dataset.open !== "true"));
document.getElementById("hlClose").addEventListener("click", () => setHlPane(false));
hlPick.addEventListener("click", () => setHlPicking(!hlPicking));
hlAllBtn.addEventListener("click", () => {
  if (hlChecked.size === hlGroups.length) hlChecked.clear();
  else hlGroups.forEach((g) => hlChecked.add(g.groupId));
  renderHlPane();
});
hlDelBtn.addEventListener("click", async () => {
  await removeHighlights([...hlChecked]);
  setHlPicking(false);
});
hlExpBtn.addEventListener("click", async () => {
  /* 내보낸 뒤 선택 모드를 풀지 않는다 — 삭제와 달리 목록이 그대로 남으므로,
     같은 것을 다른 형식으로 한 번 더 내보내려던 손이 처음부터 다시 고르게 된다. */
  const r = await api.highlight.export([...hlChecked]);
  if (r?.error) alert(r.error);
});


/* Alt+H. 메뉴 accelerator 와 겹치지 않는다(CmdOrCtrl+O 와 F1 뿐이다). */
document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  if ((e.key || "").toLowerCase() !== "h") return;
  e.preventDefault();
  addHighlightFromSelection();
});

/* 우하단 진행 위젯은 2026-08-06 에 뺐다(사용자 지시) — 진행·지출 집계는
   main 의 스케줄러가 계속 물고 있으므로 되살릴 일이 생기면 stats 이벤트만
   다시 받으면 된다. */

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

  renderToc(outline);
  /* 형광펜은 문서에 딸린 것이라 문서를 바꾸면 통째로 갈린다. 목록·칠·개수
     표시가 모두 이 한 번에서 나온다. */
  setHlPicking(false);
  await loadHighlights();

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

  buildTocIndex();
  updateTocMark();
});

api.on("block:updated", async ({ ids }) => {
  const rows = await api.blocks.byIds(ids);
  for (const b of rows) {
    loaded.set(b.id, b);
    const el = mounted.get(b.id);
    if (!el) continue;
    const ko = el.querySelector(".cell.ko");
    if (!ko || b.type === "figure" || b.type === "equation") continue;  // 번역 칸이 없다
    const tag = TAG[b.type] || "p";
    ko.innerHTML = `<${tag}></${tag}>`;
    setTextWithMath(ko.firstChild, b.ko || "");
  }
  measure();
  rebuildTops();
  /* 번역이 다시 쓰였다 — 번역 칸 형광펜의 사본이 아직 맞는지 다시 따진다.
     안 맞으면 지우지 않고 목록에 「번역이 바뀌었습니다」로 남긴다. */
  reindexHighlights();
  paintHighlights();
  renderHlPane();
});
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
    renderWindow();
    updateTocMark();    // renderWindow 는 창이 바뀔 때만 돈다 — 강조는 매 프레임 따라간다
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
  /* 시작은 늘 절반씩 — 예전 저장값(settings.split)은 읽지 않는다 */
  setSplit(50);

  const themeBtn = document.getElementById("themeBtn");
  const applyTheme = (t) => {
    root.dataset.theme = t;
    themeBtn.setAttribute("aria-pressed", String(t === "night"));
  };
  applyTheme(settings.theme === "night" ? "night" : "light");
  themeBtn.addEventListener("click", () => {
    const t = root.dataset.theme === "night" ? "light" : "night";
    applyTheme(t);
    saveSetting("theme", t);
  });

  /* 번역 범위 UI 는 2026-08-06 에 뺐고 모드는 「현재 장」 고정이다.
     저장값을 읽지 않는 것이 의도다 — 고르는 손잡이가 없는데 옛 저장값
     "all" 이 몰래 살아나면 문서를 열 때마다 전량 번역이 돌아 돈이 샌다.
     전량 번역은 스킬 CLI(translate.py)가 맡는다. */

  /* 옛 저장값 "tb"·"bt" 는 "lr" 로 옮긴다(2026-08-15 상하 배치 제거).
     그대로 두면 셀렉트가 빈 값이 되고 손잡이 없는 화면에 갇힌다 —
     "viewport" → "chapter" 이관과 같은 처리다. */
  const layoutSel = document.getElementById("layoutSel");
  layoutSel.value = settings.layout === "rl" ? "rl" : "lr";
  setLayout(layoutSel.value);
  layoutSel.addEventListener("change", () => setLayout(layoutSel.value));
})();
