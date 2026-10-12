(() => {
  "use strict";
  // Settings row for the key that lets the Arca Live picker read pictures from PC Lakomics.
  // The key lives only in the extension's storage; the page and this form never read it back.
  const $ = id => document.getElementById(id);
  const form = $("pc-key-form");
  if (!form) return;
  const send = message => chrome.runtime.sendMessage(message);
  const input = $("pc-key"), state = $("pc-key-state"), error = $("pc-key-error"), clear = $("pc-key-clear"), save = $("pc-key-save");
  function render(has) {
    state.textContent = has ? "✓ 저장됨" : "아직 없음";
    clear.hidden = !has;
    save.classList.toggle("primary", !has);
    input.placeholder = has ? "새 키로 바꾸기" : "PC 연결 키 붙여넣기";
  }
  async function load() {
    try { render(Boolean((await send({ type: "picker:key-state" }))?.hasKey)); }
    catch { state.textContent = "상태를 확인하지 못했습니다"; }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    error.textContent = "";
    let reply;
    try { reply = await send({ type: "picker:key-set", value }); } catch { reply = null; }
    if (reply?.ok) { input.value = ""; render(true); }
    else error.textContent = reply?.code === "invalid_key" ? "키 형식이 맞지 않습니다 (영문 소문자와 숫자 32자)" : "저장하지 못했습니다";
  });
  clear.addEventListener("click", async () => {
    error.textContent = "";
    try { const reply = await send({ type: "picker:key-clear" }); if (reply?.ok) render(false); else error.textContent = "지우지 못했습니다"; }
    catch { error.textContent = "지우지 못했습니다"; }
  });
  void load();
})();
