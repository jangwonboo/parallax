/* 상단 도구와 책갈피 패널. */
(() => {
  const api = window.parallax;
  const saveButton = document.getElementById("saveBtn");
  const saveAsButton = document.getElementById("saveAsBtn");
  const bookmarkButton = document.getElementById("bookmarkBtn");
  const bookmarkPanel = document.getElementById("bookmarkPanel");
  const bookmarkAdd = document.getElementById("bookmarkAdd");
  const bookmarkList = document.getElementById("bookmarkList");

  const closeBookmarks = () => {
    bookmarkPanel.hidden = true;
    bookmarkButton.setAttribute("aria-expanded", "false");
  };
  const renderBookmarks = async () => {
    const items = await api.bookmark.list();
    bookmarkList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "bookmark-empty";
      empty.textContent = "저장된 책갈피가 없습니다.";
      bookmarkList.append(empty);
    }
    for (const entry of items) {
      const row = document.createElement("div");
      row.className = "bookmark-row";
      const jump = document.createElement("button");
      jump.type = "button";
      jump.textContent = `${entry.page ? `p.${entry.page} · ` : ""}${entry.label || "그림"}`;
      jump.title = jump.textContent;
      jump.addEventListener("click", () => { closeBookmarks(); api.gotoBlock(entry.blockId); });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", "책갈피 지우기");
      remove.title = "책갈피 지우기";
      remove.textContent = "×";
      remove.addEventListener("click", () => api.bookmark.remove(entry.id));
      row.append(jump, remove);
      bookmarkList.append(row);
    }
  };
  const toggleBookmarks = () => {
    bookmarkPanel.hidden = !bookmarkPanel.hidden;
    bookmarkButton.setAttribute("aria-expanded", String(!bookmarkPanel.hidden));
    if (bookmarkPanel.hidden) return;
    const width = bookmarkPanel.getBoundingClientRect().width;
    bookmarkPanel.style.left = `${Math.max(14, Math.min(bookmarkButton.getBoundingClientRect().left, innerWidth - width - 14))}px`;
    bookmarkAdd.disabled = !api.currentBlockId();
    renderBookmarks();
  };
  const save = async (asNew = false) => {
    try { await api.save(asNew); }
    catch (e) { alert("저장하지 못했습니다: " + (e.message || e)); }
  };

  document.getElementById("openBtn").addEventListener("click", () => api.doc.open());
  saveButton.addEventListener("click", () => save());
  saveAsButton.addEventListener("click", () => save(true));
  document.getElementById("helpBtn").addEventListener("click", () => api.showHelp());
  bookmarkButton.addEventListener("click", toggleBookmarks);
  bookmarkAdd.addEventListener("click", async () => {
    const id = api.currentBlockId();
    if (id) await api.bookmark.add(id);
  });
  api.on("bookmark:changed", renderBookmarks);
  api.on("doc:opened", () => { closeBookmarks(); renderBookmarks(); });
  document.addEventListener("parallax:dirty", (event) => {
    const { dirty, name } = event.detail;
    saveButton.disabled = !api.hasBook();
    saveAsButton.disabled = !api.hasBook();
    bookmarkButton.disabled = !api.hasBook();
    saveButton.classList.toggle("has-changes", dirty);
    saveButton.title = dirty ? `${name} — 저장되지 않은 변경 (Ctrl+S)` : `${name} — 저장 (Ctrl+S)`;
    document.title = `${dirty ? "● " : ""}${name} · Parallax`;
  });
  document.addEventListener("pointerdown", (event) => {
    if (!bookmarkPanel.hidden && !bookmarkPanel.contains(event.target) && !bookmarkButton.contains(event.target)) closeBookmarks();
  });
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "o") {
      event.preventDefault(); closeBookmarks(); api.doc.open();
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "s") {
      event.preventDefault(); save();
    } else if (event.key === "F1") {
      event.preventDefault(); api.showHelp();
    } else if (event.key === "Escape" && !bookmarkPanel.hidden) {
      closeBookmarks();
      bookmarkButton.focus();
    }
  });
})();
