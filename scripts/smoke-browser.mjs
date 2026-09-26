/* Chrome 단일 HTML 또는 Electron에서 작은 .parallax 문서를 읽는다. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import electronBinary from "electron";

const electronMode = process.argv.includes("--electron");
const liveDictionary = process.argv.includes("--live");
const chrome = process.env.PARALLAX_CHROME || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find(existsSync);
if (!chrome && !electronMode) throw new Error("Chrome 또는 Edge 실행 파일을 찾지 못했습니다.");
const fixture = resolve("work/reader-smoke.parallax");
if (!existsSync(fixture)) throw new Error("먼저 python scripts/make-reader-fixture.py 를 실행하세요.");
const profile = resolve(`work/browser-smoke-profile-${process.pid}`);
const marker = join(profile, "DevToolsActivePort");
const portForElectron = 9227;
const browser = electronMode
  ? spawn(electronBinary, [
      ".", fixture, `--remote-debugging-port=${portForElectron}`,
      "--headless=new", "--disable-gpu", "--no-sandbox",
    ], { windowsHide: true, stdio: "ignore" })
  : spawn(chrome, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      pathToFileURL(resolve("html/parallax.html")).href,
    ], { windowsHide: true, stdio: "ignore" });

try {
  let port = electronMode ? portForElectron : null;
  let pages = [];
  for (let i = 0; i < 100; i++) {
    if (!electronMode && existsSync(marker)) {
      port = Number(readFileSync(marker, "utf8").split(/\r?\n/)[0]);
    }
    if (port) {
      try { pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); }
      catch { /* 아직 디버그 서버가 열리지 않았다 */ }
      if (pages.some((item) => item.type === "page" && item.url.includes(electronMode ? "index.html" : "parallax.html"))) break;
    }
    await delay(100);
  }
  if (!port) throw new Error("브라우저 디버그 포트를 열지 못했습니다.");
  const page = pages.find((item) => item.type === "page" && item.url.includes(electronMode ? "index.html" : "parallax.html"));
  if (!page) throw new Error("HTML 뷰어 탭을 찾지 못했습니다.");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { socket.onopen = ok; socket.onerror = bad; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params) => new Promise((ok) => {
    const id = ++nextId;
    pending.set(id, ok);
    socket.send(JSON.stringify({ id, method, params }));
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const check = await send("Runtime.evaluate", {
      expression: "document.readyState === 'complete' && !!window.parallax && !!window.parallaxReader",
      returnByValue: true,
    });
    if (check.result?.result?.value) { ready = true; break; }
    await delay(100);
  }
  if (!ready) {
    const diagnostic = await send("Runtime.evaluate", {
      expression: "({state:document.readyState, api:typeof window.parallax, reader:typeof window.parallaxReader, url:location.href})",
      returnByValue: true,
    });
    throw new Error(`뷰어 초기화 실패: ${JSON.stringify(diagnostic.result?.result?.value)}`);
  }
  const base64 = electronMode ? "" : readFileSync(fixture).toString("base64");
  const openBook = electronMode ? "" : `const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), c => c.charCodeAt(0));
    await window.parallax.doc.open(new File([bytes], "reader-smoke.parallax"));`;
  const expression = `(async () => {
    ${openBook}
    await new Promise(ok => setTimeout(ok, 800));
    ${electronMode ? "" : `document.getElementById("bookmarkBtn").click();
    await new Promise(ok => setTimeout(ok, 100));`}
    return {
      title: document.title,
      headings: document.querySelectorAll(".row-h1").length,
      equations: document.querySelectorAll(".row-equation").length,
      figures: document.querySelectorAll(".row-figure img").length,
      highlights: (await window.parallax.highlight.list()).length,
      bookmarks: ${electronMode ? "null" : "(await window.parallax.bookmark.list()).length"},
      bookmarkRows: ${electronMode ? "null" : "document.querySelectorAll('#bookmarkList .bookmark-row').length"},
    };
  })()`;
  const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
  const result = reply.result?.result?.value;
  if (!electronMode) {
    if (!liveDictionary) {
      const mockReply = await send("Runtime.evaluate", {
        expression: `window.fetch = async (url) => {
          if (String(url).includes('datamuse.com')) return {
            ok: true, json: async () => [{ word: 'figure', defs: ['n\\tA drawing or diagram.'] }],
          };
          if (String(url).includes('mymemory.translated.net')) return {
            ok: true, json: async () => ({ responseData: { translatedText: '그림' } }),
          };
          throw new Error('Unexpected dictionary endpoint: ' + url);
        }`,
      });
      if (mockReply.result?.exceptionDetails) throw new Error(JSON.stringify(mockReply.result.exceptionDetails));
    }
    const targetReply = await send("Runtime.evaluate", {
      expression: `(() => {
        const cell = document.querySelector('.row-p .cell.src');
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const start = node.textContent.indexOf('figure');
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + 6);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        throw new Error('Dictionary target word is not rendered');
      })()`,
      returnByValue: true,
    });
    if (targetReply.result?.exceptionDetails) throw new Error(JSON.stringify(targetReply.result.exceptionDetails));
    const { x, y } = targetReply.result.result.value;
    for (const clickCount of [1, 2]) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
    }
    if (liveDictionary) {
      for (let i = 0; i < 100; i++) {
        const waiting = await send("Runtime.evaluate", {
          expression: "document.getElementById('dKo').classList.contains('spin')",
          returnByValue: true,
        });
        if (!waiting.result?.result?.value) break;
        await delay(100);
      }
    } else await delay(100);
    const dictReply = await send("Runtime.evaluate", {
      expression: "({ open: document.getElementById('dict').dataset.open, word: document.getElementById('dWord').textContent, selected: getSelection()?.toString(), ko: document.getElementById('dKo').textContent, en: document.getElementById('dEn').textContent })",
      returnByValue: true,
    });
    if (dictReply.result?.exceptionDetails) throw new Error(JSON.stringify(dictReply.result.exceptionDetails));
    result.dictionary = dictReply.result.result.value;
    assert.equal(result.dictionary.open, "true");
    assert.equal(result.dictionary.word, "figure");
    if (!liveDictionary) {
      assert.equal(result.dictionary.ko, "그림");
      assert.match(result.dictionary.en, /A drawing or diagram/);
    } else {
      assert.match(result.dictionary.en, /drawing or diagram/i);
    }
  }
  socket.close();
  if (!electronMode) assert.match(result.title, /reader-smoke\.parallax/);
  assert.equal(result.headings, 1);
  assert.equal(result.equations, 1);
  assert.equal(result.figures, 2); // 양쪽 칸에 같은 그림을 한 번씩 표시한다.
  assert.equal(result.highlights, 1);
  if (!electronMode) {
    assert.equal(result.bookmarks, 1);
    assert.equal(result.bookmarkRows, 1);
  }
  console.log(electronMode ? "electron smoke:" : "browser smoke:", result);
} finally {
  browser.kill();
}
