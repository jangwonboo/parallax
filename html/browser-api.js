/* .parallax SQLite 문서와 기존 리더 사이의 브라우저 전용 경계. */
(() => {
  const FORMAT = "parallax-json";
  const DROPPED = 32;
  const listeners = new Map();
  let book = null;
  let visible = [];
  let blockById = new Map();
  let sourceDb = null;
  let sqlPromise = null;
  let fileHandle = null;
  let fileName = "book.parallax";
  let dirty = false;
  const undoStack = [];

  const emit = (name, payload) => {
    for (const fn of listeners.get(name) || []) fn(payload);
  };
  const setDirty = (value) => {
    dirty = value;
    document.dispatchEvent(new CustomEvent("parallax:dirty", {
      detail: { dirty, name: fileName },
    }));
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));

  const sqlRows = (db, query, params = []) => {
    const result = db.exec(query, params)[0];
    return result ? result.values.map((values) => Object.fromEntries(result.columns.map((name, i) => [name, values[i]]))) : [];
  };
  const hasTable = (db, name) => sqlRows(db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0;
  const hasColumn = (db, table, name) => sqlRows(db, `PRAGMA table_info(${table})`).some((row) => row.name === name);
  const sqlite = () => {
    if (!sqlPromise) {
      const raw = atob(window.PARALLAX_SQL_WASM);
      const wasmBinary = Uint8Array.from(raw, (char) => char.charCodeAt(0));
      sqlPromise = window.initSqlJs({ wasmBinary });
    }
    return sqlPromise;
  };
  const b64 = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(binary);
  };
  function makeOutline(blocks) {
    const headings = blocks.filter((block) => !(block.flags & DROPPED) &&
      /^h[123]$/.test(block.type) && block.src.length <= 120);
    return headings.map((block) => ({ id: block.id, ord: block.ord,
      level: Number(block.type[1]), text: block.src.trim() }));
  }
  function readSqlite(db) {
    if (!hasTable(db, "doc") || !hasTable(db, "block")) throw new Error("Parallax 문서가 아닙니다.");
    const doc = sqlRows(db, "SELECT * FROM doc LIMIT 1")[0];
    if (!doc || doc.schema_version > 2) throw new Error("지원하지 않는 Parallax 문서입니다.");
    const blocks = sqlRows(db, "SELECT * FROM block ORDER BY ord");
    const assets = hasTable(db, "asset") ? sqlRows(db,
      `SELECT id,mime,w,h,alt,${hasColumn(db, "asset", "wfrac") ? "wfrac" : "NULL AS wfrac"} FROM asset`) : [];
    const highlights = hasTable(db, "highlight") ? sqlRows(db,
      "SELECT id,group_id AS groupId,block_id AS blockId,side,start_off AS start,end_off AS end,text,created_at AS createdAt FROM highlight") : [];
    const bookmarks = hasTable(db, "bookmark") ? sqlRows(db,
      "SELECT id,block_id AS blockId,created_at AS createdAt FROM bookmark") : [];
    const dictCache = {};
    if (hasTable(db, "dict_cache")) {
      for (const row of sqlRows(db,
        `SELECT word,ipa,${hasColumn(db, "dict_cache", "ko") ? "ko" : "NULL AS ko"},defs FROM dict_cache`)) {
        try { dictCache[row.word] = { ipa: row.ipa || "", ko: row.ko || "", defs: JSON.parse(row.defs || "[]") }; }
        catch { dictCache[row.word] = { ipa: row.ipa || "", ko: row.ko || "", defs: [] }; }
      }
    }
    return { format: FORMAT, version: 1, doc, blocks, assets, highlights, bookmarks,
      outline: makeOutline(blocks), dictCache, glossary: [] };
  }

  function validate(value) {
    if (!value || value.format !== FORMAT || value.version !== 1 ||
        !value.doc || !Array.isArray(value.blocks) || !Array.isArray(value.assets) ||
        !Array.isArray(value.highlights)) {
      throw new Error("Parallax 문서가 아닙니다.");
    }
    if (!value.doc.id || value.blocks.some((b) => !b.id || typeof b.src !== "string")) {
      throw new Error("문서의 필수 데이터가 빠졌습니다.");
    }
  }

  async function chooseFile() {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: "Parallax 책", accept: {
            "application/octet-stream": [".parallax"], "application/json": [".json"] } }],
        });
        return handle ? { file: await handle.getFile(), handle } : null;
      } catch (e) {
        if (e.name === "AbortError") return null;
        // file:// 권한 정책 등으로 피커가 막히면 표준 파일 입력으로 연다.
      }
    }
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".parallax,.json";
      input.hidden = true;
      document.body.appendChild(input);
      const finish = (file) => {
        input.remove();
        resolve(file ? { file, handle: null } : null);
      };
      input.addEventListener("change", () => finish(input.files?.[0]));
      input.addEventListener("cancel", () => finish(null));
      input.click();
    });
  }

  async function openFile(selected) {
    if (dirty && !confirm("저장하지 않은 변경이 있습니다. 다른 책을 여시겠습니까?")) return;
    const picked = selected instanceof File ? { file: selected, handle: null } : await chooseFile();
    if (!picked) return;
    emit("import:progress", { stage: "read", message: picked.file.name });
    try {
      const bytes = new Uint8Array(await picked.file.arrayBuffer());
      let db = null;
      let value;
      if (new TextDecoder().decode(bytes.subarray(0, 16)).startsWith("SQLite format 3")) {
        const SQL = await sqlite();
        db = new SQL.Database(bytes);
        try { value = readSqlite(db); }
        catch (error) { db.close(); throw error; }
      } else {
        value = JSON.parse(new TextDecoder().decode(bytes));
        validate(value);
      }
      // 실패 시 이전 책을 잃지 않도록 파싱과 검증이 끝난 뒤 교체한다.
      sourceDb?.close();
      sourceDb = db;
      book = value;
      book.assets ||= [];
      book.outline ||= [];
      book.dictCache ||= {};
      book.glossary ||= [];
      book.bookmarks ||= [];
      visible = book.blocks.filter((b) => !(b.flags & DROPPED)).sort((a, b) => a.ord - b.ord);
      blockById = new Map(book.blocks.map((b) => [b.id, b]));
      fileHandle = picked.handle;
      fileName = picked.file.name;
      undoStack.length = 0;
      setDirty(false);
      emit("doc:opened", {
        meta: {
          ...book.doc,
          blockCount: visible.length,
          translated: visible.filter((b) => b.ko).length,
        },
        outline: book.outline,
        heights: {},
        assets: book.assets.map(({ b64, ...meta }) => meta),
        sourceChanged: false,
        hasKey: true,
      });
    } catch (error) {
      alert(error.message || String(error));
    } finally {
      emit("import:progress", { stage: "done" });
    }
  }

  function download(name, value, mime) {
    const url = URL.createObjectURL(new Blob([value], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function writeSqlite() {
    sourceDb.run("BEGIN TRANSACTION");
    try {
      sourceDb.run(`CREATE TABLE IF NOT EXISTS highlight (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, block_id TEXT NOT NULL,
        side TEXT NOT NULL, start_off INTEGER NOT NULL, end_off INTEGER NOT NULL,
        text TEXT NOT NULL, created_at INTEGER NOT NULL)`);
      sourceDb.run("DELETE FROM highlight");
      for (const h of book.highlights) sourceDb.run(
        "INSERT INTO highlight(id,group_id,block_id,side,start_off,end_off,text,created_at) VALUES (?,?,?,?,?,?,?,?)",
        [h.id, h.groupId, h.blockId, h.side, h.start, h.end, h.text, h.createdAt]);
      sourceDb.run(`CREATE TABLE IF NOT EXISTS bookmark (
        id TEXT PRIMARY KEY, block_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`);
      sourceDb.run("DELETE FROM bookmark");
      for (const entry of book.bookmarks) sourceDb.run(
        "INSERT INTO bookmark(id,block_id,created_at) VALUES (?,?,?)",
        [entry.id, entry.blockId, entry.createdAt]);
      sourceDb.run("COMMIT");
    } catch (error) {
      sourceDb.run("ROLLBACK");
      throw error;
    }
    return sourceDb.export();
  }

  async function save(asNew = false) {
    if (!book) return false;
    let handle = asNew ? null : fileHandle;
    if (!handle && window.showSaveFilePicker) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: sourceDb ? "Parallax 책" : "Parallax JSON",
            accept: sourceDb ? { "application/octet-stream": [".parallax"] } : { "application/json": [".json"] } }],
        });
      } catch (e) {
        if (e.name === "AbortError") return false;
        // 제한된 환경에서는 다운로드 복사본을 제공한다.
      }
    }
    const data = sourceDb ? writeSqlite() : JSON.stringify(book);
    const mime = sourceDb ? "application/octet-stream" : "application/json;charset=utf-8";
    if (handle) {
      const stream = await handle.createWritable();
      try {
        await stream.write(data);
        await stream.close();
      } catch (e) {
        await stream.abort().catch(() => {});
        throw e;
      }
      fileHandle = handle;
      fileName = handle.name;
      setDirty(false);
      return true;
    }
    download(fileName, data, mime);
    alert("수정본을 다운로드했습니다. 원본 파일은 그대로이며, 다운로드한 파일을 보관해야 변경이 남습니다.");
    return true;
  }

  function sortedHighlights() {
    return (book?.highlights || []).filter((h) => blockById.has(h.blockId))
      .map((h) => ({ ...h, ord: blockById.get(h.blockId).ord, page: blockById.get(h.blockId).page }))
      .sort((a, b) => a.ord - b.ord || (a.side === "ko") - (b.side === "ko") || a.start - b.start);
  }
  function pushUndo(before) {
    undoStack.push(before);
    if (undoStack.length > 99) undoStack.shift();
    setDirty(true);
  }
  function addHighlight(frags) {
    if (!book || !frags?.length) return null;
    const before = copy(book.highlights);
    const gid = crypto.randomUUID();
    const now = Date.now();
    for (const f of frags) {
      const b = blockById.get(f.blockId);
      const whole = f.side === "src" ? b?.src : b?.ko;
      if (!whole || f.start < 0 || f.end > whole.length || f.start >= f.end ||
          whole.slice(f.start, f.end) !== f.text) continue;
      let start = f.start, end = f.end;
      const hits = book.highlights.filter((h) => h.blockId === f.blockId &&
        h.side === f.side && h.start <= end && h.end >= start);
      for (const h of hits) {
        start = Math.min(start, h.start);
        end = Math.max(end, h.end);
        book.highlights.splice(book.highlights.indexOf(h), 1);
        for (const other of book.highlights) if (other.groupId === h.groupId) other.groupId = gid;
      }
      book.highlights.push({
        id: crypto.randomUUID(), groupId: gid, blockId: f.blockId, side: f.side,
        start, end, text: whole.slice(start, end), createdAt: now,
      });
    }
    if (JSON.stringify(before) !== JSON.stringify(book.highlights)) pushUndo(before);
    return gid;
  }
  function removeHighlights(groups) {
    if (!book || !groups?.length) return 0;
    const before = copy(book.highlights);
    const ids = new Set(groups);
    book.highlights = book.highlights.filter((h) => !ids.has(h.groupId));
    const removed = before.length - book.highlights.length;
    if (removed) pushUndo(before);
    return removed;
  }
  function undo() {
    if (!book || !undoStack.length) return false;
    book.highlights = undoStack.pop();
    setDirty(true);
    return true;
  }

  function listBookmarks() {
    return (book?.bookmarks || []).filter((entry) => blockById.has(entry.blockId))
      .map((entry) => {
        const block = blockById.get(entry.blockId);
        return { ...entry, page: block.page, label: block.src.replace(/\s+/g, " ").slice(0, 80) };
      })
      .sort((a, b) => blockById.get(a.blockId).ord - blockById.get(b.blockId).ord);
  }
  function addBookmark(blockId) {
    if (!book || !blockById.has(blockId) || book.bookmarks.some((entry) => entry.blockId === blockId)) return false;
    book.bookmarks.push({ id: crypto.randomUUID(), blockId, createdAt: Date.now() });
    setDirty(true);
    emit("bookmark:changed", listBookmarks());
    return true;
  }
  function removeBookmark(id) {
    if (!book) return false;
    const before = book.bookmarks.length;
    book.bookmarks = book.bookmarks.filter((entry) => entry.id !== id);
    if (book.bookmarks.length === before) return false;
    setDirty(true);
    emit("bookmark:changed", listBookmarks());
    return true;
  }

  function gloss(groups) {
    const result = {};
    const ids = new Set(groups);
    const byGroup = new Map();
    for (const h of sortedHighlights()) {
      if (h.side !== "src" || !ids.has(h.groupId)) continue;
      byGroup.set(h.groupId, [...(byGroup.get(h.groupId) || []), h.text]);
    }
    for (const [gid, parts] of byGroup) {
      const words = parts.join(" ").toLowerCase().match(/[a-z][a-z'-]+/g) || [];
      const single = words.length === 1;
      const found = [...new Set(words)].filter((w) => book.dictCache[w]).slice(0, single ? 1 : 3);
      result[gid] = found.map((word) => ({ word, ...book.dictCache[word],
        ko: single ? book.dictCache[word].ko : "",
        defs: (book.dictCache[word].defs || []).slice(0, single ? 2 : 1),
      }));
    }
    return result;
  }

  const api = {
    doc: { open: openFile, cancelImport: () => {}, meta: async () => book?.doc || null },
    blocks: {
      count: async () => visible.length,
      range: async (off, lim) => visible.slice(off, off + lim),
      byIds: async (ids) => ids.map((id) => blockById.get(id)).filter(Boolean),
      outline: async () => book?.outline || [],
      setHeights: async () => {}, clearHeights: async () => {}, reset: async () => {},
    },
    asset: { get: async (id) => {
      const meta = book?.assets.find((a) => a.id === id);
      if (!meta) return null;
      if (!sourceDb) return meta;
      const row = sqlRows(sourceDb, "SELECT data FROM asset WHERE id=?", [id])[0];
      return row ? { ...meta, b64: b64(row.data) } : null;
    } },
    translate: { request: async () => {}, setMode: async () => {}, pause: async () => {}, stats: async () => null },
    settings: {
      get: async () => { try { return JSON.parse(localStorage.getItem("parallax-html-settings") || "{}"); } catch { return {}; } },
      set: async (patch) => { try {
        const old = JSON.parse(localStorage.getItem("parallax-html-settings") || "{}");
        localStorage.setItem("parallax-html-settings", JSON.stringify({ ...old, ...patch }));
      } catch {} },
    },
    dict: { lookup: async (word) => {
      const key = word.toLowerCase();
      const row = book?.dictCache?.[key];
      return row ? { word, ipa: row.ipa || "", ko: row.ko || "", koOk: !!row.ko, defs: row.defs || [] }
        : { word, ipa: "", ko: "", koOk: false, defs: [], error: "저장된 뜻이 없습니다." };
    } },
    highlight: {
      list: async () => sortedHighlights(), add: async (frags) => addHighlight(frags),
      remove: async (groups) => removeHighlights(groups),
      undo: async () => undo(), undoDepth: async () => undoStack.length,
      gloss: async (groups) => gloss(groups),
    },
    bookmark: { list: async () => listBookmarks(), add: async (id) => addBookmark(id), remove: async (id) => removeBookmark(id) },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    save, isDirty: () => dirty, hasBook: () => !!book,
  };
  window.parallax = api;
  window.addEventListener("beforeunload", (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
})();
