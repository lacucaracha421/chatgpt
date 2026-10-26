(() => {
  "use strict";
  // Show the page within 300 ms even if anything below throws before the normal reveal.
  setTimeout(() => document.body.classList.add("ready"), 300);
  const $ = id => document.getElementById(id);
  const send = message => chrome.runtime.sendMessage(message);
  const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const scroll = (node, block = "start") => node.scrollIntoView?.({ block, behavior: reduced() ? "auto" : "smooth" });
  let state = null, preview = null, busy = false, translation = {}, youtube = {}, desiredAutoLike = null;
  let loadGeneration = 0;
  let context = { enabled: true, excludedHosts: [] };
  const contextKey = "lakomics:context-menu:v1";
  const queues = new Map(), statuses = new WeakMap();
  const desiredTranslation = new Map(), desiredYoutube = new Map();

  // Serialize writes to each settings document, including rapid changes and flushes.
  function queued(domain, action) {
    const result = (queues.get(domain) || Promise.resolve()).then(action);
    queues.set(domain, result.catch(() => {}));
    return result;
  }
  function status(output, text, bad = false, retry = null) {
    output.classList.remove("fade"); output.classList.toggle("bad", bad);
    const nodes = [];
    if (!bad) {
      const check = document.createElement("span"); check.className = "ok"; check.textContent = "✓"; check.ariaHidden = "true";
      nodes.push(check);
    }
    nodes.push(document.createTextNode(text));
    if (retry) {
      const button = document.createElement("button"); button.type = "button"; button.className = "retry";
      button.textContent = "다시 시도"; button.onclick = retry; nodes.push(button);
    }
    output.replaceChildren(...nodes);
  }
  async function delayedBusy(output, action, done = "저장됨") {
    const previous = statuses.get(output);
    if (previous) { clearTimeout(previous.busy); clearTimeout(previous.finish); clearTimeout(previous.fade); }
    const record = { shown: output.textContent === "저장 중" ? previous?.shown ?? null : null };
    statuses.set(output, record);
    if (record.shown == null) output.replaceChildren();
    output.classList.remove("bad", "fade");
    record.busy = setTimeout(() => {
      if (statuses.get(output) !== record) return;
      record.shown ??= Date.now(); output.textContent = "저장 중";
    }, 400);
    let result;
    try { result = await action(); if (!result?.ok) throw new Error("save_failed"); }
    catch { result ||= { ok: false }; }
    clearTimeout(record.busy);
    if (statuses.get(output) !== record) return result;
    const finish = () => {
      if (statuses.get(output) !== record) return;
      if (result.ok) {
        const text = result.pending ? "오프라인" : typeof done === "function" ? done(result) : done;
        status(output, text);
        if (!result.pending) record.fade = setTimeout(() => output.classList.add("fade"), 2000);
      } else status(output, result.code === "revoked" ? "다시 연결 ·" : "저장 실패 ·", true, () => void delayedBusy(output, action, done));
    };
    const wait = record.shown == null ? 0 : Math.max(0, 600 - (Date.now() - record.shown));
    if (wait) record.finish = setTimeout(finish, wait); else finish();
    return result;
  }
  function model() { return state ? LakomicsClassificationTree.createModel(state.classifications.entries, state.profile) : null; }
  function pathLabel(entry) { return model()?.path(entry.id).map((item) => item.name).join(" / ") || entry.name; }
  function pathName(entry) {
    const name = document.createElement("span"), parts = model()?.path(entry.id) || [entry];
    if (parts.length > 1) {
      const parent = document.createElement("span"); parent.className = "path";
      parent.textContent = parts.slice(0, -1).map(item => item.name).join(" / ") + " / "; name.append(parent);
    }
    name.append(document.createTextNode(entry.name)); return name;
  }
  function render() {
    if (!state) { preview?.close?.(); preview = null; return; }
    const m = model();
    $("auto-like").checked = desiredAutoLike ? desiredAutoLike.value : state.profile.preferences.autoLikeOnSave !== false;
    const pins = [];
    for (const id of state.profile.pinnedClassificationIds) {
      const entry = m.byId.get(id); if (!entry) continue;
      const item = document.createElement("div"); item.className = "pin";
      const name = pathName(entry);
      const remove = document.createElement("button"); remove.textContent = "×"; remove.ariaLabel = `${entry.name} 고정 해제`;
      remove.onclick = () => void patch(() => ({ pinnedClassificationIds: state.profile.pinnedClassificationIds.filter((value) => value !== id) }));
      item.append(name, remove); pins.push(item);
    }
    $("pins").replaceChildren(...pins);
    const pinned = new Set(state.profile.pinnedClassificationIds), candidate = $("pin-candidate"), selected = candidate.value;
    candidate.replaceChildren(new Option("고정할 폴더 고르기", ""), ...LakomicsClassificationTree.visibleEntries(m.entries, state.hiddenClassificationIds).filter((entry) => !pinned.has(entry.id)).map((entry) => new Option(pathLabel(entry), entry.id)));
    if ([...candidate.options].some(option => option.value === selected)) candidate.value = selected;
    const hidden = new Set(state.hiddenClassificationIds || []);
    const folders = [];
    const hiddenEntries = m.entries.filter(entry => hidden.has(entry.id));
    $("hidden-count").textContent = String(hiddenEntries.length);
    $("hidden-empty").hidden = hiddenEntries.length > 0;
    for (const entry of hiddenEntries) {
      const item = document.createElement("div"); item.className = "hidden-folder";
      const name = pathName(entry);
      const restore = document.createElement("button"); restore.textContent = "표시"; restore.className = "btn";
      restore.ariaLabel = `${pathLabel(entry)} 다시 표시`;
      restore.onclick = () => void changeHidden(() => state.hiddenClassificationIds.filter(id => id !== entry.id));
      item.append(name, restore); folders.push(item);
    }
    $("hidden-folders").replaceChildren(...folders);
    $("order-editor").classList.remove("arc-skeleton");
    if (preview) { preview.update(state); return; }
    preview = LakomicsArcCollector.mount({
      entries: state.classifications.entries, profile: state.profile, arcLayout: state.arcLayout,
      hiddenClassificationIds: state.hiddenClassificationIds, container: $("order-editor"),
      onReorder: async (parentId, ids) => {
        const key = parentId ?? "__root__";
        const result = await patch({ listOrderPatch: { [key]: ids } });
        return result;
      }, onHide: id => changeHidden(() => [...(state.hiddenClassificationIds || []), id]), onClose: () => {},
    });
  }


  async function load() {
    const generation = ++loadGeneration;
    const settings = await send({ type: "settings:get" });
    if (generation !== loadGeneration) return;
    const paired = Boolean(settings?.paired);
    $("youtube-clear-server-row").hidden = !paired;
    $("state-dot").classList.toggle("online", paired);
    $("state-label").textContent = paired ? "연결됨" : "연결 안 됨";
    $("pair-help").hidden = paired; $("pair-form").hidden = paired;
    document.querySelector(".paired-actions").hidden = !paired;
    for (const id of ["pin-section", "order-section", "preference-section"]) $(id).hidden = !paired;
    $("collect-locked").hidden = paired; $("origin").textContent = settings?.origin || "";
    state = settings?.state || null; render();
    if (paired) {
      const skeleton = setTimeout(() => { if (!state) $("order-editor").classList.add("arc-skeleton"); }, 300);
      void send({ type: "profile:refresh" }).then(fresh => {
        if (generation === loadGeneration && fresh?.ok && fresh.state) { state = fresh.state; render(); }
      }).catch(() => {}).finally(() => { clearTimeout(skeleton); $("order-editor").classList.remove("arc-skeleton"); });
    }
  }
  async function changeHidden(ids) {
    if (!state) return { ok: false };
    return delayedBusy($("sync-status"), () => queued("collection", async () => {
      const result = await send({ type: "arc:hidden", ids: typeof ids === "function" ? ids() : ids });
      if (result?.ok && result.state) { state = result.state; render(); }
      return result;
    }));
  }
  async function patch(change) {
    if (!state) return { ok: false };
    const preference = change.preferences?.autoLikeOnSave;
    const token = typeof preference === "boolean" ? { value: preference } : null;
    if (token) desiredAutoLike = token;
    return delayedBusy($("sync-status"), () => queued("collection", async () => {
      const result = await send({ type: "profile:patch", patch: typeof change === "function" ? change() : change });
      if (result?.ok && result.state) {
        if (desiredAutoLike === token) desiredAutoLike = null;
        state = result.state; render();
      }
      return result;
    }));
  }

  // Confirm panels are inert while collapsed, so their controls are never tab stops.
  let activeConfirm = null, activeHelp = null;
  function closeConfirm(restore = false) {
    if (!activeConfirm) return;
    const current = activeConfirm; activeConfirm = null; clearTimeout(current.timer);
    current.panel.classList.remove("open"); current.panel.inert = true; current.panel.setAttribute("aria-hidden", "true");
    current.trigger.setAttribute("aria-expanded", "false");
    if (restore) current.trigger.focus({ preventScroll: true });
  }
  function armConfirm(current) {
    clearTimeout(current.timer);
    current.timer = setTimeout(() => { if (!current.pending && activeConfirm === current) closeConfirm(); }, 10000);
  }
  function confirm(id, question, consequence, verb, output, action, done) {
    const trigger = $(id), panel = document.createElement("div");
    panel.id = "confirm-" + id; panel.className = "confirm"; panel.inert = true; panel.setAttribute("aria-hidden", "true");
    const inner = document.createElement("div"), box = document.createElement("div"); box.className = "confirm-box";
    box.setAttribute("role", "group"); box.setAttribute("aria-label", question);
    const text = document.createElement("p"), detail = document.createElement("small"); text.append(document.createTextNode(question)); text.append(detail);
    const acts = document.createElement("div"); acts.className = "acts";
    const cancel = document.createElement("button"), commit = document.createElement("button"), error = document.createElement("p");
    cancel.type = commit.type = "button"; cancel.className = "btn"; commit.className = "btn danger solid";
    cancel.textContent = "취소"; commit.textContent = verb; cancel.dataset.cancel = ""; commit.dataset.commit = "";
    error.className = "confirm-error"; error.setAttribute("aria-live", "polite");
    acts.append(cancel, commit); box.append(text, acts, error); inner.append(box); panel.append(inner);
    trigger.closest(".row, .key").append(panel);
    trigger.setAttribute("aria-controls", panel.id); trigger.setAttribute("aria-expanded", "false");
    const current = { trigger, panel, pending: false };
    trigger.onclick = () => {
      if (activeConfirm === current) { if (!current.pending) closeConfirm(true); return; }
      if (activeConfirm?.pending) return;
      closeConfirm(); activeConfirm = current; detail.textContent = typeof consequence === "function" ? consequence() : consequence;
      error.textContent = ""; commit.textContent = verb; panel.inert = false; panel.setAttribute("aria-hidden", "false");
      panel.classList.add("open"); trigger.setAttribute("aria-expanded", "true"); cancel.focus(); armConfirm(current);
    };
    cancel.onclick = () => closeConfirm(true);
    panel.addEventListener("pointerdown", () => armConfirm(current));
    panel.addEventListener("keydown", () => armConfirm(current));
    const perform = async () => {
      if (current.pending) return { ok: false };
      current.pending = true; commit.disabled = true; clearTimeout(current.timer);
      let result;
      try { result = await action(); } catch { result = { ok: false }; }
      current.pending = false; commit.disabled = false;
      if (result?.ok) { if (activeConfirm === current) closeConfirm(true); }
      else if (activeConfirm === current) {
        error.textContent = "실패 · 다시 시도해 주세요"; commit.textContent = "다시 시도"; armConfirm(current);
      }
      return result;
    };
    commit.onclick = () => { if (!current.pending) return delayedBusy(output, perform, done); };
  }
  function closeHelp(restore = false) {
    if (!activeHelp) return;
    const { button, panel } = activeHelp; activeHelp = null;
    panel.hidden = true; button.setAttribute("aria-expanded", "false"); if (restore) button.focus();
  }
  for (const button of document.querySelectorAll("[data-help]")) {
    const panel = $(button.dataset.help);
    button.onclick = () => {
      if (activeHelp?.button === button) { closeHelp(); return; }
      closeHelp(); panel.hidden = false; button.setAttribute("aria-expanded", "true"); activeHelp = { button, panel };
    };
  }
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { closeConfirm(true); closeHelp(true); }
  });
  document.addEventListener("pointerdown", event => {
    if (activeConfirm && !activeConfirm.panel.contains(event.target) && !activeConfirm.trigger.contains(event.target)) closeConfirm();
    if (activeHelp && !activeHelp.panel.contains(event.target) && !activeHelp.button.contains(event.target)) closeHelp();
  });

  const provider = id => String(id).startsWith("neuralwatt:") ? "neuralwatt" : String(id).startsWith("anthropic:") ? "anthropic" : "openrouter";
  const keyId = p => p === "openrouter" ? "translation-key" : `translation-${p}-key`;
  const hasKey = p => Boolean(p === "neuralwatt" ? translation.hasNeuralwattKey : p === "anthropic" ? translation.hasAnthropicKey : translation.hasOpenRouterKey);
  const providerLabel = p => p === "neuralwatt" ? "Neuralwatt" : p === "anthropic" ? "Anthropic" : "OpenRouter";
  function goKey(p) { const field = $(keyId(p)); scroll(field.closest(".key"), "center"); field.focus({ preventScroll: true }); }
  function keyMeta(id, p, visible = true, prefix = "") {
    const node = $(id); node.hidden = !visible; node.replaceChildren();
    if (!visible) return;
    node.classList.toggle("need-key", !hasKey(p));
    if (hasKey(p)) {
      const check = document.createElement("span"); check.className = "ok"; check.textContent = "✓";
      node.append(check, document.createTextNode(" " + providerLabel(p) + " 키"));
    } else {
      node.append(document.createTextNode("⚠ " + prefix + "API 키 필요 · "));
      const button = document.createElement("button"); button.type = "button"; button.className = "link"; button.textContent = "키 입력";
      button.onclick = () => goKey(p); node.append(button);
    }
  }
  function grouped(id, models, value, first = null) {
    const children = first ? [new Option(first, "")] : [];
    const selected = document.activeElement === $(id) ? $(id).value : value;
    for (const p of ["openrouter", "anthropic", "neuralwatt"]) {
      const group = document.createElement("optgroup"); group.label = providerLabel(p);
      for (const m of models.filter(m => provider(m.id) === p)) group.append(new Option(m.label + (hasKey(p) ? "" : " · 키 필요"), m.id));
      if (group.children.length) children.push(group);
    }
    $(id).replaceChildren(...children); $(id).value = selected || "";
  }
  function relationships() {
    const x = provider(translation.model), cm = provider(translation.contextModel || translation.model), image = provider(translation.imageModel);
    keyMeta("translation-model-key-meta", x);
    keyMeta("translation-fallback-key-meta", provider(translation.fallbackModel), Boolean(translation.fallbackModel));
    keyMeta("context-menu-model-key-meta", cm); keyMeta("context-menu-image-model-key-meta", image);
    keyMeta("translation-enabled-key-meta", x, $("translation-enabled").checked && !hasKey(x));
    keyMeta("youtube-enabled-key-meta", "anthropic", $("youtube-enabled").checked && !hasKey("anthropic"), "Anthropic ");
    keyMeta("youtube-model-key-meta", "anthropic");
    const uses = [
      ["X 번역", x, $("translation-enabled").checked],
      ["보조 모델", translation.fallbackModel ? provider(translation.fallbackModel) : null, $("translation-enabled").checked],
      ["우클릭 번역", cm, context.enabled], ["페이지 번역", cm, context.enabled],
      ["이미지 글자 번역", image, context.enabled], ["YouTube 자막", "anthropic", $("youtube-enabled").checked],
    ];
    let needed = false;
    for (const p of ["openrouter", "anthropic", "neuralwatt"]) {
      const id = keyId(p), present = hasKey(p), relevant = uses.filter(([,key]) => key === p);
      const missing = relevant.filter(([, ,enabled]) => enabled);
      const stateNode = $(id + "-state"); stateNode.textContent = present ? "✓ 저장됨" : "없음"; stateNode.classList.toggle("miss", !present);
      const useNode = $(id + "-uses"), required = !present && missing.length > 0;
      useNode.hidden = relevant.length === 0; useNode.classList.toggle("need-key", required);
      useNode.textContent = (required ? "필요: " : "사용: ") + (required ? missing : relevant).map(([name]) => name).join(" · ");
      needed ||= required; $(id + "-clear").hidden = !present;
      $(id + "-save").classList.toggle("primary", !present);
      $(id).placeholder = present ? "새 키로 바꾸기" : providerLabel(p) + " API 키";
    }
    $("nav-key-needed").hidden = !needed;
  }
  function renderTranslation(result) {
    translation = { ...translation, ...result };
    for (const [key, desired] of desiredTranslation) translation[key] = desired.value;
    $("translation-enabled").checked = Boolean(translation.enabled);
    const models = translation.models || [], label = models.find(m => m.id === translation.model)?.label || "";
    grouped("translation-model", models, translation.model);
    grouped("translation-fallback", models.filter(m => m.id !== translation.model), translation.fallbackModel, "사용 안 함");
    grouped("context-menu-model", models, translation.contextModel, `X 번역과 같게 (${label})`);
    grouped("context-menu-image-model", translation.imageModels || [], translation.imageModel);
    $("context-menu-image-cover").value = translation.imageCover === "card" ? "card" : "paper";
    dictionaryEditor.receive((translation.userTerms || []).map(term => `${term.source} = ${term.korean}`).join("\n"));
    $("translation-dictionary-status").textContent = `${(translation.userTerms || []).length}개`;
    relationships();
  }
  let translationRead = 0;
  async function translationSettings() {
    const generation = ++translationRead, result = await send({ type: "translation:settings" });
    if (!result?.ok) throw new Error("settings_failed");
    if (generation === translationRead) renderTranslation(result);
  }
  function updateTranslation(change, output, done = "저장됨") {
    const tokens = Object.entries(change).map(([key, value]) => {
      const token = { value }; desiredTranslation.set(key, token); return [key, token];
    });
    return delayedBusy($(output), () => queued("translation", async () => {
      ++translationRead;
      const result = await send({ type: "translation:update", ...change });
      if (result?.ok) {
        for (const [key, token] of tokens) if (desiredTranslation.get(key) === token) desiredTranslation.delete(key);
        renderTranslation(result);
      }
      return result;
    }), done);
  }
  for (const [id, key, out] of [["translation-model", "model", "x-status"], ["translation-fallback", "fallbackModel", "x-status"], ["context-menu-model", "contextModel", "context-menu-status"], ["context-menu-image-model", "imageModel", "context-menu-status"], ["context-menu-image-cover", "imageCover", "context-menu-status"]]) {
    $(id).onchange = () => {
      translation[key] = $(id).value; relationships();
      return updateTranslation({ [key]: $(id).value }, out, key === "model" ? "저장됨 · 번역 캐시 비움" : "저장됨");
    };
  }
  $("translation-enabled").onchange = () => { relationships(); return updateTranslation({ enabled: $("translation-enabled").checked }, "x-status"); };
  for (const [p, field, clearFlag] of [["openrouter", "apiKey", "clearApiKey"], ["anthropic", "anthropicApiKey", "clearAnthropicApiKey"], ["neuralwatt", "neuralwattApiKey", "clearNeuralwattApiKey"]]) {
    const id = keyId(p), input = $(id), button = $(id + "-save");
    input.oninput = () => { button.disabled = Boolean(input.dataset.saving) || !input.value.trim(); };
    $(id + "-form").onsubmit = async event => {
      event.preventDefault(); const value = input.value.trim(); if (!value || input.dataset.saving) return;
      input.dataset.saving = "true"; button.disabled = true;
      await delayedBusy($("translation-status"), () => queued("translation", async () => {
        ++translationRead;
        const result = await send({ type: "translation:update", [field]: value });
        if (result?.ok) { if (input.value.trim() === value) input.value = ""; button.disabled = !input.value.trim(); renderTranslation(result); }
        return result;
      }), "키 저장됨");
      delete input.dataset.saving; button.disabled = !input.value.trim();
    };
    confirm(id + "-clear", `${providerLabel(p)} 키를 지울까요?`, () => $(id + "-uses").textContent.replace(/^(사용|필요): /, "") + " 기능이 멈춥니다.", "지우기", $("translation-status"), () => queued("translation", async () => {
      ++translationRead;
      const result = await send({ type: "translation:update", [field]: "", [clearFlag]: true });
      if (result?.ok) renderTranslation(result); return result;
    }), "키 지움");
  }

  // Keep unsaved/focused text intact even when the worker broadcasts a settings change.
  function textEditor(id, formId, save) {
    const node = $(id); let timer, saved = node.value, inFlight = null, normalized = null;
    const flush = (blur = false) => {
      clearTimeout(timer);
      const raw = node.value;
      if (raw === saved || raw === inFlight) { if (blur) void save(raw, true, false); return Promise.resolve(); }
      inFlight = raw;
      normalized = null;
      return Promise.resolve(save(raw, blur, true)).then(result => {
        if (result?.ok) saved = normalized?.raw === raw ? normalized.value : raw;
      }).finally(() => { if (inFlight === raw) inFlight = null; });
    };
    node.oninput = () => { clearTimeout(timer); timer = setTimeout(() => void flush(), 800); };
    node.onblur = () => void flush(true);
    node.onkeydown = event => { if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void flush(); } };
    $(formId).onsubmit = event => { event.preventDefault(); return flush(true); };
    return { flush, receive(value) {
      if (document.activeElement !== node && node.value === saved && inFlight == null) { node.value = value; saved = value; }
    }, committed(raw) { saved = normalized?.raw === raw ? normalized.value : raw; }, normalized(raw, value) {
      if (node.value === raw && document.activeElement !== node) {
        node.value = value; normalized = { raw, value };
        if (saved === raw) saved = value;
      }
    } };
  }
  function validation(id, message) {
    const node = $(id); node.setAttribute("aria-invalid", String(Boolean(message))); node.classList.toggle("err", Boolean(message));
    $(id === "translation-dictionary" ? "translation-dictionary-error" : id === "context-menu-priority" ? "context-menu-priority-error" : "context-menu-error").textContent = message;
  }
  const hostRe = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  function hosts(raw) {
    const lines = raw.split(/\r?\n/).map(text => text.trim().toLowerCase().replace(/\.$/, ""));
    return { bad: lines.findIndex(host => host && !hostRe.test(host)), values: [...new Set(lines.filter(Boolean))] };
  }
  const contextEditor = textEditor("context-menu-excluded", "context-menu-form", async (raw, blur, write) => {
    const parsed = hosts(raw);
    if (blur) validation("context-menu-excluded", parsed.bad < 0 ? "" : `${parsed.bad + 1}번째 줄: 주소 대신 호스트만`);
    if (parsed.bad >= 0) return { ok: false };
    if (!write) { contextEditor.normalized(raw, parsed.values.join("\n")); return { ok: true }; }
    return delayedBusy($("context-menu-status"), () => queued("context", async () => {
      await chrome.storage.local.set({ [contextKey]: { ...context, excludedHosts: parsed.values } });
      context.excludedHosts = parsed.values; $("context-menu-count").textContent = `${parsed.values.length}개`;
      if (blur) contextEditor.normalized(raw, parsed.values.join("\n"));
      contextEditor.committed(raw); return { ok: true };
    }));
  });
  const priorityEditor = textEditor("context-menu-priority", "context-menu-priority-form", async (raw, blur, write) => {
    const parsed = hosts(raw);
    if (blur) validation("context-menu-priority", parsed.bad < 0 ? "" : `${parsed.bad + 1}번째 줄: 주소 대신 호스트만`);
    if (parsed.bad >= 0) return { ok: false };
    if (!write) { priorityEditor.normalized(raw, parsed.values.join("\n")); return { ok: true }; }
    return delayedBusy($("context-menu-status"), () => queued("context", async () => {
      await chrome.storage.local.set({ [contextKey]: { ...context, priorityHosts: parsed.values } });
      context.priorityHosts = parsed.values;
      if (blur) priorityEditor.normalized(raw, parsed.values.join("\n"));
      priorityEditor.committed(raw); return { ok: true };
    }));
  });
  const dictionaryEditor = textEditor("translation-dictionary", "translation-dictionary-form", async (raw, blur, write) => {
    const core = globalThis.LakomicsTranslationCore;
    const lines = raw.split(/\r?\n/).filter(line => line.trim());
    const invalid = lines.filter(line => !core.parseUserTerms(line).length).length;
    const terms = core.parseUserTerms(raw), skipped = Math.max(invalid, lines.length - terms.length);
    if (blur) validation("translation-dictionary", skipped ? `${skipped}줄을 읽지 못했어요` : "");
    if (!write) {
      if (blur && !skipped) dictionaryEditor.normalized(raw, terms.map(t => `${t.source} = ${t.korean}`).join("\n"));
      return { ok: true };
    }
    return delayedBusy($("translation-status"), () => queued("translation", async () => {
      ++translationRead;
      const result = await send({ type: "translation:update", userTerms: terms });
      if (result?.ok) {
        renderTranslation(result);
        if (blur && !skipped) dictionaryEditor.normalized(raw, terms.map(t => `${t.source} = ${t.korean}`).join("\n"));
        dictionaryEditor.committed(raw);
      }
      return result;
    }), "저장됨 · 번역 캐시 비움");
  });
  $("context-menu-enabled").onchange = () => {
    const enabled = $("context-menu-enabled").checked; context.enabled = enabled; relationships();
    return delayedBusy($("context-menu-status"), () => queued("context", async () => {
      await chrome.storage.local.set({ [contextKey]: { ...context, enabled } }); return { ok: true };
    }));
  };
  $("context-menu-page-mode").onchange = () => {
    const pageMode = $("context-menu-page-mode").value === "below" ? "below" : "replace"; context.pageMode = pageMode;
    return delayedBusy($("context-menu-status"), () => queued("context", async () => {
      await chrome.storage.local.set({ [contextKey]: { ...context, pageMode } }); return { ok: true };
    }));
  };
  async function contextSettings() {
    if (!chrome.storage?.local) return;
    const stored = await chrome.storage.local.get([contextKey]), value = stored[contextKey];
    context = { enabled: value?.enabled !== false, excludedHosts: Array.isArray(value?.excludedHosts) ? value.excludedHosts : [], ...(value?.pageMode ? { pageMode: value.pageMode === "below" ? "below" : "replace" } : {}) };
    if (Array.isArray(value?.priorityHosts)) context.priorityHosts = value.priorityHosts;
    priorityEditor.receive((context.priorityHosts || []).join("\n"));
    $("context-menu-enabled").checked = context.enabled; $("context-menu-page-mode").value = context.pageMode || "replace"; contextEditor.receive(context.excludedHosts.join("\n"));
    $("context-menu-count").textContent = `${context.excludedHosts.length}개`; relationships();
  }
  const youtubeChecks = ["enabled", "translate", "localAsr", "speakerColors", "speakers", "glossarySonnet", "showOriginal", "rolling"];
  const youtubeSelects = ["model", "register", "fontScale", "position"];
  function subtitlePreview() {
    const node = $("youtube-preview"); node.style.setProperty("--fs", $("youtube-fontScale").value);
    node.classList.toggle("raised", $("youtube-position").value === "raised");
    node.querySelector("small").hidden = !$("youtube-showOriginal").checked;
    node.querySelector("em").hidden = !$("youtube-rolling").checked;
  }
  function renderYoutube(settings) {
    youtube = { ...youtube, ...settings };
    for (const [key, desired] of desiredYoutube) youtube[key] = desired.value;
    for (const key of youtubeChecks) $("youtube-" + key).checked = Boolean(youtube[key]);
    for (const key of youtubeSelects) if (youtube[key] != null) $("youtube-" + key).value = String(youtube[key]);
    subtitlePreview(); relationships();
  }
  let youtubeRead = 0;
  async function youtubeSettings() {
    const generation = ++youtubeRead, result = await send({ type: "youtube:settings" });
    if (!result?.ok) throw new Error("settings_failed");
    if (generation === youtubeRead) renderYoutube(result.settings);
  }
  for (const key of [...youtubeChecks, ...youtubeSelects]) {
    $("youtube-" + key).onchange = () => {
      const node = $("youtube-" + key), value = youtubeChecks.includes(key) ? node.checked : key === "fontScale" ? Number(node.value) : node.value;
      const token = { value }; desiredYoutube.set(key, token);
      subtitlePreview(); relationships();
      return delayedBusy($("youtube-status"), () => queued("youtube", async () => {
        ++youtubeRead;
        const result = await send({ type: "youtube:update", patch: { [key]: value } });
        if (result?.ok) {
          if (desiredYoutube.get(key) === token) desiredYoutube.delete(key);
          renderYoutube(result.settings);
        }
        return result;
      }));
    };
  }
  // ---------------------------------------------------------------- usage
  const usageApi = globalThis.LakomicsUsage;
  const usageTime = ms => {
    const date = new Date(ms), pad = value => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  function usageCell(cell) {
    const td = document.createElement("td");
    if (!cell || !cell.requests) { td.textContent = "-"; td.className = "none"; return td; }
    const cost = document.createElement("span"), tokens = document.createElement("span");
    cost.className = "uc"; cost.textContent = usageApi.describeCost(cell);
    tokens.className = "ut"; tokens.textContent = usageApi.describeTokens(cell);
    td.append(cost, tokens); return td;
  }
  function usageRow(name, cells, className = "") {
    const tr = document.createElement("tr"), head = document.createElement("th");
    head.scope = "row"; head.textContent = name; tr.className = className; tr.append(head, ...cells.map(usageCell)); return tr;
  }
  let usageRender = 0;
  async function renderUsage() {
    if (!usageApi || !chrome.storage?.local) return;
    const request = ++usageRender;
    const data = usageApi.summarize(await usageApi.load());
    if (request !== usageRender) return;
    const rows = usageApi.FEATURES.map(feature => usageRow(usageApi.FEATURE_LABELS[feature], [data.rows[feature].today, data.rows[feature].month, data.rows[feature].total]));
    if (data.legacy) rows.push(usageRow("기록 시작 전 유튜브", [null, null, data.legacy], "legacy"));
    rows.push(usageRow("합계", [data.all.today, data.all.month, data.all.total], "sum"));
    $("usage-rows").replaceChildren(...rows);
    const jobs = data.jobs.map(job => {
      const item = document.createElement("li"), time = document.createElement("span"), kind = document.createElement("span"), label = document.createElement("span"), amount = document.createElement("span");
      time.className = "jt"; time.textContent = usageTime(job.at);
      kind.className = "jk"; kind.textContent = usageApi.FEATURE_LABELS[job.feature];
      label.className = "jl"; label.textContent = job.label || usageApi.FEATURE_LABELS[job.feature]; label.title = job.models.join(", ");
      const cell = { requests: job.requests, input: job.input, output: job.output, costUsd: job.costUsd, unknownCostRequests: job.unknown };
      amount.className = "ja"; amount.textContent = `${usageApi.describeCost(cell)} · ${usageApi.describeTokens(cell)}`;
      item.append(time, kind, label, amount); return item;
    });
    $("usage-jobs").replaceChildren(...jobs);
    $("usage-jobs-count").textContent = `${jobs.length}개`; $("usage-jobs-empty").hidden = jobs.length > 0;
  }
  confirm("usage-clear", "사용량 기록을 지울까요?", "오늘·이번 달·전체 합계와 최근 작업이 모두 사라집니다. 되돌릴 수 없어요.", "지우기", $("usage-status"), async () => {
    const result = await send({ type: "usage:clear" }); if (result?.ok) await renderUsage(); return result;
  }, "사용량 기록 지움");
  confirm("translation-clear", "X 번역 캐시를 비울까요?", "열린 X 탭의 번역도 사라지고 다시 번역합니다. 키와 사전은 그대로.", "비우기", $("storage-status"), () => send({ type: "translation:clear" }), "X 번역 캐시 비움");
  confirm("youtube-clear", "이 브라우저의 자막을 지울까요?", "다음에 볼 때 다시 만듭니다(서버에 있으면 서버에서 받아 옵니다).", "지우기", $("storage-status"), () => send({ type: "youtube:clearCache" }), "이 브라우저 자막 지움");
  confirm("youtube-clear-server", "서버의 자막을 모두 지울까요?", "다른 브라우저와 기기도 다시 만들어야 합니다. 되돌릴 수 없습니다.", "모두 지우기", $("storage-status"), () => send({ type: "youtube:clearServerCache" }), "서버 자막 지움");
  confirm("disconnect", "연결을 해제할까요?", "이 브라우저의 숨긴 폴더와 폴더 배치도 지워집니다. 다시 연결하면 서버에서 돌아옵니다.", "연결 해제", $("pair-status"), async () => {
    const result = await send({ type: "disconnect" }); if (result?.ok) { state = null; await load(); } return result;
  }, "연결 해제됨");
  $("pair-form").onsubmit = async event => {
    event.preventDefault(); if (busy) return; busy = true;
    $("pair-error").textContent = ""; $("pairing").setAttribute("aria-invalid", "false");
    const value = $("pairing").value.trim();
    try {
      await delayedBusy($("pair-status"), async () => {
        const result = await send({ type: "pair:review", value });
        if (!result?.ok) {
          $("pair-error").textContent = result?.code === "pairing_expired" ? "만료된 링크입니다. PC에서 새로 발급하세요." : result?.code === "invalid_pairing" ? "연결 링크 전체를 붙여넣으세요." : "연결 실패 · 다시 시도해 주세요.";
          $("pairing").setAttribute("aria-invalid", "true");
        } else { $("pairing").value = ""; $("pair-error").textContent = ""; $("pairing").setAttribute("aria-invalid", "false"); }
        return result;
      }, "새 탭에서 서버 주소를 확인하세요");
    } finally { busy = false; }
  };
  $("refresh").onclick = () => delayedBusy($("pair-status"), async () => {
    const result = await send({ type: "profile:refresh" }); if (result?.ok && result.state) { state = result.state; render(); } return result;
  }, "동기화함");
  $("pin-add").onclick = () => { const id = $("pin-candidate").value; if (id && state) return patch(() => ({ pinnedClassificationIds: [...new Set([...state.profile.pinnedClassificationIds, id])] })); };
  $("auto-like").onchange = () => patch({ preferences: { autoLikeOnSave: $("auto-like").checked } });
  $("collect-go-pair").onclick = () => { scroll($("pair-section")); $("pairing").focus({ preventScroll: true }); };
  $("download-settings").onclick = async () => {
    try { await chrome.tabs.create({ url: "chrome://settings/downloads" }); }
    catch { $("download-settings").hidden = true; }
  };
  $("version").textContent = chrome.runtime.getManifest?.().version || "";
  const links = [...document.querySelectorAll(".op-nav a")], sections = links.map(link => $(link.getAttribute("href").slice(1)));
  function current(index) { links.forEach((link, i) => i === index ? link.setAttribute("aria-current", "location") : link.removeAttribute("aria-current")); }
  links.forEach((link, i) => link.onclick = event => {
    event.preventDefault(); scroll(sections[i]); sections[i].querySelector("h2").focus({ preventScroll: true }); current(i);
  });
  function spy() {
    let index = 0; sections.forEach((section, i) => { if (section.getBoundingClientRect().top <= 32) index = i; });
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) index = sections.length - 1;
    current(index);
  }
  if (window.IntersectionObserver) {
    const observer = new IntersectionObserver(spy, { rootMargin: "-16px 0px -70% 0px" }); sections.forEach(section => observer.observe(section));
  }
  window.addEventListener("scroll", spy, { passive: true });
  const flush = () => { void dictionaryEditor.flush(); void contextEditor.flush(); };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    // Never use raw key-bearing storage documents to render the page.
    if (changes["lakomics:translation:v1"]) void queued("translation", translationSettings).catch(() => {});
    if (changes[contextKey]) void queued("context", contextSettings).catch(() => {});
    if (usageApi && Object.keys(changes).some(usageApi.isUsageKey)) void renderUsage().catch(() => {});
    if (Object.keys(changes).some(key => key.startsWith("lakomics:youtube:settings:"))) void queued("youtube", youtubeSettings).catch(() => {});
  });
  const reveal = () => document.body.classList.add("ready"), cap = setTimeout(reveal, 300);
  const initialTranslation = translationSettings().catch(() => status($("translation-status"), "번역 설정을 불러오지 못했습니다", true));
  void initialTranslation.then(() => {
    if (location.hash !== "#translation-section") return;
    scroll($("translation-section"));
    if (!hasKey("openrouter")) goKey("openrouter"); else if (!hasKey("anthropic")) goKey("anthropic");
    history.replaceState(null, "", location.pathname);
  });
  const initial = [load().catch(() => status($("pair-status"), "연결 설정을 불러오지 못했습니다", true)),
    initialTranslation,
    contextSettings().catch(() => status($("context-menu-status"), "설정을 불러오지 못했습니다", true)),
    youtubeSettings().catch(() => status($("youtube-status"), "자막 설정을 불러오지 못했습니다", true)),
    renderUsage().catch(() => status($("usage-status"), "사용량을 불러오지 못했습니다", true))];
  void Promise.all(initial).then(() => {
    clearTimeout(cap); reveal();
  });
})();
