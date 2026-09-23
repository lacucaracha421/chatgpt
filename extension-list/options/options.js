(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let state = null, preview = null, busy = false;

  function send(message) { return chrome.runtime.sendMessage(message); }
  function model() { return state ? LakomicsClassificationTree.createModel(state.classifications.entries, state.profile) : null; }
  function pathLabel(entry) { return model()?.path(entry.id).map((item) => item.name).join(" / ") || entry.name; }
  function setStatus(message = "") { $("sync-status").textContent = message; }

  async function load() {
    const settings = await send({ type: "settings:get" });
    const paired = Boolean(settings?.paired);
    $("state-dot").classList.toggle("online", paired);
    $("state-label").textContent = paired ? "연결됨" : "연결 안 됨";
    $("pair-help").hidden = paired;
    $("pair-form").hidden = paired; document.querySelector(".paired-actions").hidden = !paired;
    $("pin-section").hidden = !paired; $("order-section").hidden = !paired; $("preference-section").hidden = !paired;
    $("origin").textContent = settings?.origin || "";
    state = settings?.state || null;
    if (paired && !state) {
      const refreshed = await send({ type: "profile:refresh" });
      state = refreshed?.state || null;
    }
    render();
    if (paired && settings?.state) void send({ type: "profile:refresh" }).then((fresh) => {
      if (fresh?.ok) { state = fresh.state; render(); }
    }).catch(() => {});
  }

  function render() {
    if (!state) { preview?.close?.(); preview = null; return; }
    const m = model();
    $("auto-like").checked = state.profile.preferences.autoLikeOnSave !== false;
    $("pins").replaceChildren();
    for (const id of state.profile.pinnedClassificationIds) {
      const entry = m.byId.get(id); if (!entry) continue;
      const item = document.createElement("div"); item.className = "pin";
      const name = document.createElement("span"); name.textContent = pathLabel(entry);
      const remove = document.createElement("button"); remove.textContent = "×"; remove.ariaLabel = "고정 해제";
      remove.onclick = () => void patch({ pinnedClassificationIds: state.profile.pinnedClassificationIds.filter((value) => value !== id) });
      item.append(name, remove); $("pins").append(item);
    }
    const pinned = new Set(state.profile.pinnedClassificationIds);
    $("pin-candidate").replaceChildren(new Option("—", ""), ...LakomicsClassificationTree.visibleEntries(m.entries, state.hiddenClassificationIds).filter((entry) => !pinned.has(entry.id)).map((entry) => new Option(pathLabel(entry), entry.id)));
    const hidden = new Set(state.hiddenClassificationIds || []);
    $("hidden-folders").replaceChildren();
    const hiddenEntries = m.entries.filter(entry => hidden.has(entry.id));
    $("hidden-count").textContent = String(hiddenEntries.length);
    $("hidden-empty").hidden = hiddenEntries.length > 0;
    for (const entry of hiddenEntries) {
      const item = document.createElement("div"); item.className = "hidden-folder";
      const name = document.createElement("span"); name.textContent = pathLabel(entry);
      const restore = document.createElement("button"); restore.textContent = "표시";
      restore.ariaLabel = `${pathLabel(entry)} 다시 표시`;
      restore.onclick = () => void changeHidden(state.hiddenClassificationIds.filter(id => id !== entry.id));
      item.append(name, restore); $("hidden-folders").append(item);
    }
    if (preview) { preview.update(state); return; }
    preview = LakomicsArcCollector.mount({
      entries: state.classifications.entries, profile: state.profile, arcLayout: state.arcLayout,
      hiddenClassificationIds: state.hiddenClassificationIds, container: $("order-editor"),
      onReorder: async (parentId, ids) => {
        const key = parentId ?? "__root__";
        const result = await patch({ listOrderPatch: { [key]: ids } });
        return result;
      }, onHide: id => changeHidden([...(state.hiddenClassificationIds || []), id]), onClose: () => {},
    });
  }

  async function changeHidden(ids) {
    if (busy || !state) return { ok: false };
    busy = true; setStatus("…");
    try {
      const result = await send({ type: "arc:hidden", ids });
      if (!result?.ok || !result.state) { setStatus("변경 실패"); return { ok: false }; }
      state = result.state; render(); setStatus(""); return result;
    } catch { setStatus("변경 실패"); return { ok: false }; }
    finally { busy = false; }
  }

  async function patch(change) {
    if (busy || !state) return { ok: false };
    busy = true; setStatus("…");
    try {
      const result = await send({ type: "profile:patch", patch: change });
      if (!result?.ok) { setStatus(result?.code === "revoked" ? "다시 연결" : "동기화 실패"); return result; }
      state = result.state; setStatus(result.pending ? "오프라인" : "");
      render();
      return result;
    } catch { setStatus("동기화 실패"); return { ok: false }; }
    finally { busy = false; }
  }

  $("pair-form").onsubmit = async (event) => {
    event.preventDefault(); if (busy) return; busy = true; $("pair-status").textContent = "…";
    try {
      const result = await send({ type: "pair", value: $("pairing").value.trim() });
      if (!result?.ok) { $("pair-status").textContent = result?.code === "pairing_expired" ? "만료된 링크입니다. PC에서 새로 발급하세요." : result?.code === "invalid_pairing" ? "연결 링크 전체를 붙여넣으세요." : "연결 실패 · 다시 시도해 주세요."; return; }
      $("pairing").value = ""; $("pair-status").textContent = ""; state = result.state; await load();
    } finally { busy = false; }
  };
  $("refresh").onclick = async () => { const result = await send({ type: "profile:refresh" }); if (result?.ok) { state = result.state; render(); setStatus(""); } else setStatus("연결 실패"); };
  let disconnectTimer = null;
  function resetDisconnect() {
    clearTimeout(disconnectTimer); disconnectTimer = null;
    $("disconnect").classList.remove("confirm"); $("disconnect").textContent = "×"; $("disconnect").ariaLabel = "연결 해제";
    $("pair-status").textContent = "";
  }
  $("disconnect").onclick = async () => {
    // Disconnecting also clears this browser's hidden folders and layout, so it takes a second press.
    if (!disconnectTimer) {
      $("disconnect").classList.add("confirm"); $("disconnect").textContent = "해제"; $("disconnect").ariaLabel = "연결 해제 확인";
      $("pair-status").textContent = "한 번 더 누르면 연결이 해제되고 이 브라우저의 숨긴 폴더 설정도 지워집니다.";
      disconnectTimer = setTimeout(resetDisconnect, 4000); return;
    }
    resetDisconnect(); await send({ type: "disconnect" }); state = null; await load();
  };
  $("pin-add").onclick = () => { const id = $("pin-candidate").value; if (id && state) void patch({ pinnedClassificationIds: [...state.profile.pinnedClassificationIds, id] }); };
  $("auto-like").onchange = () => void patch({ preferences: { autoLikeOnSave: $("auto-like").checked } });
  void load();
  async function translationSettings() {
    const result = await send({ type: "translation:settings" });
    if (!result?.ok) return;
    $("translation-enabled").checked = result.enabled;
    $("translation-model").replaceChildren(...(result.models || []).map(model => new Option(model.label, model.id)));
    $("translation-model").value = result.model || "";
    // The sub model answers when the main model fails or times out; it cannot equal the main model.
    $("translation-fallback").replaceChildren(new Option("사용 안 함", ""), ...(result.models || []).filter(model => model.id !== result.model).map(model => new Option(model.label, model.id)));
    $("translation-fallback").value = result.fallbackModel || "";
    $("translation-key").placeholder = result.hasApiKey ? "API 키 저장됨 · 변경할 키 입력" : "OpenRouter API 키";
  }
  $("translation-model").onchange = async () => {
    const result = await send({ type: "translation:update", model: $("translation-model").value });
    $("translation-status").textContent = result?.ok ? "모델 변경됨 · 캐시 초기화" : "모델 변경 실패";
    await translationSettings();
  };
  $("translation-fallback").onchange = async () => {
    const result = await send({ type: "translation:update", fallbackModel: $("translation-fallback").value });
    $("translation-status").textContent = result?.ok ? "보조 모델 저장됨" : "보조 모델 저장 실패";
    await translationSettings();
  };
  $("translation-enabled").onchange = async () => {
    const result = await send({ type: "translation:update", enabled: $("translation-enabled").checked });
    $("translation-status").textContent = result?.ok ? "저장됨" : "설정 저장 실패";
  };
  $("translation-key-form").onsubmit = async event => {
    event.preventDefault();
    const result = await send({ type: "translation:update", apiKey: $("translation-key").value });
    $("translation-key").value = "";
    $("translation-status").textContent = result?.ok ? "저장됨" : "API 키 저장 실패";
    await translationSettings();
  };
  $("translation-clear").onclick = async () => {
    const result = await send({ type: "translation:clear" });
    $("translation-status").textContent = result?.ok ? "캐시를 비웠습니다" : "캐시 삭제 실패";
  };
  void translationSettings().catch(() => { $("translation-status").textContent = "번역 설정을 불러오지 못했습니다"; });
})();
