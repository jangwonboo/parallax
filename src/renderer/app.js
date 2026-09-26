/* Electron 전용 설정 UI. 본문 렌더링은 src/reader/reader.js 가 담당한다. */
(() => {
const api = window.parallax;
const keyDlg = document.getElementById("keyDlg");
const keyInput = document.getElementById("keyInput");
const keyErr = document.getElementById("keyErr");

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
  const result = await api.keys.set(keyInput.value);
  if (!result.ok) { keyErr.textContent = result.reason; keyErr.hidden = false; return; }
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
keyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    document.getElementById("keySave").click();
  }
});
api.on("keys:prompt", (st) => openKeyDialog(st));

window.parallaxElectron = {
  onDocumentOpened(event, doc) {
    if (!event.sourceChanged && event.hasKey) return;
    const notice = document.createElement("div");
    notice.className = "notice";
    notice.innerHTML = [
      event.sourceChanged ? "<b>원본 파일이 변경되었습니다.</b> 현재 번역본은 이전 원본을 기준으로 합니다." : "",
      !event.hasKey ? "<b>API 키가 없습니다.</b> 번역을 시작하려면 ANTHROPIC_API_KEY 환경변수를 설정하거나 키를 등록하세요." : "",
    ].filter(Boolean).join("<br>");
    if (!event.hasKey) {
      const button = document.createElement("button");
      button.textContent = "키 등록…";
      button.onclick = () => openKeyDialog();
      notice.append(button);
    }
    doc.prepend(notice);
  },
};
})();
