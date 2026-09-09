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
    preview?.close?.(); preview = null;
    if (!state) return;
    const m = model();
    $("auto-like").checked = state.profile.preferences.autoLikeOnSave !== false;
    $("x-translate").checked = state.profile.preferences.xTranslateEnabled !== false;
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
    $("pin-candidate").replaceChildren(new Option("—", ""), ...m.entries.filter((entry) => !pinned.has(entry.id)).map((entry) => new Option(pathLabel(entry), entry.id)));
    const editorProfile = { ...state.profile, pinnedClassificationIds: [] };
    preview = LakomicsListCollector.mount({
      entries: state.classifications.entries, profile: editorProfile, container: $("order-editor"), editing: true,
      onReorder: async (parentId, ids) => {
        const key = parentId ?? "__root__";
        const result = await patch({ listOrderPatch: { [key]: ids } }, false);
        return result;
      }, onClose: () => {},
    });
  }

  async function patch(change, rerender = true) {
    if (busy || !state) return { ok: false };
    busy = true; setStatus("…");
    try {
      const result = await send({ type: "profile:patch", patch: change });
      if (!result?.ok) { setStatus(result?.code === "revoked" ? "다시 연결" : "동기화 실패"); return result; }
      state = result.state; setStatus(result.pending ? "오프라인" : "");
      if (rerender) render();
      return result;
    } finally { busy = false; }
  }

  $("pair-form").onsubmit = async (event) => {
    event.preventDefault(); if (busy) return; busy = true; $("pair-status").textContent = "…";
    try {
      const result = await send({ type: "pair", value: $("pairing").value.trim() });
      if (!result?.ok) { $("pair-status").textContent = result?.code === "pairing_expired" ? "만료" : "연결 실패"; return; }
      $("pairing").value = ""; $("pair-status").textContent = ""; state = result.state; await load();
    } finally { busy = false; }
  };
  $("refresh").onclick = async () => { const result = await send({ type: "profile:refresh" }); if (result?.ok) { state = result.state; render(); setStatus(""); } else setStatus("연결 실패"); };
  $("disconnect").onclick = async () => { await send({ type: "disconnect" }); state = null; await load(); };
  $("pin-add").onclick = () => { const id = $("pin-candidate").value; if (id && state) void patch({ pinnedClassificationIds: [...state.profile.pinnedClassificationIds, id] }); };
  $("auto-like").onchange = () => void patch({ preferences: { autoLikeOnSave: $("auto-like").checked } });
  $("x-translate").onchange = () => void patch({ preferences: { xTranslateEnabled: $("x-translate").checked } });
  void load();
})();
