(() => {
  "use strict";
  const SELECTOR = '[data-testid="tweetText"]';
  const SETTINGS = "lakomics:translation:v1";
  const CACHE = "lakomics:translation-cache:v2";
  const MAX_BATCH_ITEMS = 4;
  const MAX_BATCH_CHARS = 6000;
  let enabled = false, hasApiKey = false, blocked = false, epoch = 0, running = false, timer = null, requestSerial = 0, fastLanePending = true;
  let initialSettings = null;
  const pending = new Set(), observed = new Set();
  let completed = new WeakMap(), intersection, ui;
  const rendered = new Map();

  function send(message) {
    return new Promise(resolve => {
      try { chrome.runtime.sendMessage(message, result => resolve(chrome.runtime.lastError ? { ok: false, code: "worker_failed" } : result)); }
      catch { resolve({ ok: false, code: "worker_failed" }); }
    });
  }
  function source(element) {
    const links = [];
    function walk(node) {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1) return "";
      if (node.tagName === "BR") return "\n";
      if (node.tagName === "IMG") return node.getAttribute("alt") || "";
      if (node.tagName === "A") {
        const label = node.textContent || "";
        const token = `[[LINK_${links.length}]]`;
        links.push({ token, label, href: node.href });
        return token;
      }
      return [...node.childNodes].map(walk).join("");
    }
    const text = walk(element).trim();
    return { text, links, signature: JSON.stringify([text, links, element.getAttribute("lang") || ""]) };
  }
  function needsTranslation(element, text) {
    const lang = (element.getAttribute("lang") || "").split("-")[0].toLowerCase();
    if (lang === "ko") return false;
    const prose = text.replace(/\[\[LINK_\d+\]\]/g, "");
    const letters = prose.match(/\p{L}/gu) || [];
    if (letters.length < 3) return false;
    if (lang && lang !== "und" && lang !== "zxx") return true;
    const korean = prose.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) || [];
    return korean.length / letters.length < 0.55;
  }
  function visible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
  }
  function detectTheme() {
    const value = getComputedStyle(document.body).backgroundColor || "";
    const match = value.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
    if (!match) return "lights-out";
    const [r, g, b] = match.slice(1).map(Number);
    if (r >= 225 && g >= 225 && b >= 225) return "light";
    if (r <= 8 && g <= 8 && b <= 8) return "lights-out";
    return "dim";
  }
  function applyTheme() {
    const theme = detectTheme();
    if (ui?.host) ui.host.dataset.theme = theme;
    for (const node of rendered.values()) node.dataset.theme = theme;
    return theme;
  }
  function removeResult(element) {
    rendered.get(element)?.remove();
    rendered.delete(element);
  }
  function render(element, snapshot, text, error = false) {
    removeResult(element);
    const node = document.createElement("div");
    node.className = "lakomics-translation";
    node.dataset.error = String(error);
    node.dataset.theme = detectTheme();
    node.setAttribute("lang", "ko");
    if (error) node.setAttribute("role", "status");
    const links = new Map(snapshot.links.map(link => [link.token, link]));
    for (const piece of text.split(/(\[\[LINK_\d+\]\])/g)) {
      const link = links.get(piece);
      if (!link) { node.append(document.createTextNode(piece)); continue; }
      let url;
      try { url = new URL(link.href); } catch {}
      if (!url || !["http:", "https:"].includes(url.protocol)) { node.append(document.createTextNode(link.label)); continue; }
      const anchor = document.createElement("a");
      anchor.href = url.href;
      anchor.textContent = link.label;
      anchor.rel = "noopener noreferrer";
      node.append(anchor);
    }
    element.after(node);
    rendered.set(element, node);
  }
  function failure(code) {
    if (code === "http_401" || code === "api_key_missing") return "번역 API 키를 확인하세요";
    if (code === "http_402") return "OpenRouter 잔액을 확인하세요";
    if (code === "http_403") return "OpenRouter API 접근 권한을 확인하세요";
    if (code === "http_429") return "번역 요청 한도 · 잠시 후 자동 재시도";
    if (code === "timeout" || code === "network_error" || /^http_5\d\d$/.test(code || "")) return "번역 연결 실패 · 다시 보이면 재시도";
    return "번역 실패 · 다시 보이면 재시도";
  }
  function setNotice(text = "", kind = "") {
    if (!ui) return;
    ui.notice = kind;
    ui.status.textContent = text;
    updateControlState();
  }
  function updateControlState() {
    if (!ui) return;
    let state = "off";
    if (running) state = "busy";
    else if (blocked) state = "error";
    else if (ui.notice === "warning") state = "warning";
    else if (enabled && hasApiKey) state = "on";
    else if (enabled && !hasApiKey) state = "error";
    ui.button.dataset.state = state;
  }
  function schedule(immediate = false) {
    if (!enabled || !hasApiKey || blocked) return;
    if (immediate) {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      void drain();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; void drain(); }, 120);
  }
  function current(candidate, requestEpoch) {
    return requestEpoch === epoch && enabled && !blocked && candidate.element.isConnected
      && source(candidate.element).signature === candidate.snapshot.signature;
  }
  function collectBatch(limit = MAX_BATCH_ITEMS, forceSingle = false) {
    const center = innerHeight / 2;
    const elements = [...pending].filter(element => element.isConnected && visible(element))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return Math.abs((ar.top + ar.bottom) / 2 - center) - Math.abs((br.top + br.bottom) / 2 - center);
      });
    const batch = [];
    let chars = 0;
    for (const element of elements) {
      if (batch.length >= limit) break;
      pending.delete(element);
      const snapshot = source(element);
      if (completed.get(element) === snapshot.signature) continue;
      if (!needsTranslation(element, snapshot.text)) {
        completed.set(element, snapshot.signature);
        removeResult(element);
        continue;
      }
      if (snapshot.text.length > MAX_BATCH_CHARS) {
        if (batch.length) { pending.add(element); continue; }
        batch.push({ id: String(++requestSerial), element, snapshot, single: true });
        break;
      }
      if (batch.length && chars + snapshot.text.length > MAX_BATCH_CHARS) { pending.add(element); continue; }
      chars += snapshot.text.length;
      batch.push({ id: String(++requestSerial), element, snapshot, single: forceSingle });
    }
    for (const element of [...pending]) if (!element.isConnected || !visible(element)) pending.delete(element);
    return batch;
  }
  function requeueLater(candidates, waitMs) {
    const retryEpoch = epoch;
    setTimeout(() => {
      if (retryEpoch !== epoch || !enabled || !hasApiKey || blocked) return;
      for (const candidate of candidates) if (candidate.element.isConnected && source(candidate.element).signature === candidate.snapshot.signature) pending.add(candidate.element);
      setNotice("", "");
      schedule();
    }, Math.max(250, Math.min(60000, Number(waitMs) || 1500)));
  }
  function blockFor(code) {
    blocked = true;
    pending.clear();
    setNotice(failure(code), "error");
  }
  function handleTopFailure(candidates, result, requestEpoch) {
    const code = result?.code;
    if (["http_401", "http_402", "http_403", "api_key_missing"].includes(code)) {
      blockFor(code);
      return "blocked";
    }
    if (code === "http_429") {
      setNotice(failure(code), "warning");
      requeueLater(candidates, result?.retryAfterMs);
      return "cooldown";
    }
    setNotice(failure(code), "warning");
    for (const candidate of candidates) if (current(candidate, requestEpoch)) render(candidate.element, candidate.snapshot, failure(code), true);
    return "failed";
  }
  async function handleItem(candidate, item, requestEpoch) {
    if (!current(candidate, requestEpoch)) return;
    if (item?.ok) {
      render(candidate.element, candidate.snapshot, item.text);
      completed.set(candidate.element, candidate.snapshot.signature);
      setNotice("", "");
      return;
    }
    if (item?.code === "invalid_translation") {
      const fallback = await send({ type: "translation:request", text: candidate.snapshot.text });
      if (!current(candidate, requestEpoch)) return;
      if (fallback?.ok) {
        render(candidate.element, candidate.snapshot, fallback.text);
        completed.set(candidate.element, candidate.snapshot.signature);
        setNotice("", "");
        return;
      }
      handleTopFailure([candidate], fallback, requestEpoch);
      return;
    }
    handleTopFailure([candidate], item || { code: "invalid_translation" }, requestEpoch);
  }
  async function requestGroup(batch) {
    if (batch.length === 1 && batch[0].single) {
      const result = await send({ type: "translation:request", text: batch[0].snapshot.text });
      return result?.ok ? { ok: true, items: [{ id: batch[0].id, ok: true, text: result.text }] } : result;
    }
    return send({ type: "translation:request-batch", items: batch.map(candidate => ({ id: candidate.id, text: candidate.snapshot.text })) });
  }
  async function drain() {
    if (running || !enabled || !hasApiKey || blocked) return;
    running = true;
    updateControlState();
    let continueImmediately = true;
    try {
      while (enabled && hasApiKey && !blocked) {
        const wave = [];
        if (fastLanePending) {
          const fast = collectBatch(1, true);
          if (fast.length) {
            wave.push({ batch: fast, requestEpoch: epoch });
            fastLanePending = false;
          }
        }
        for (let slot = wave.length; slot < 2; slot += 1) {
          const batch = collectBatch();
          if (!batch.length) break;
          wave.push({ batch, requestEpoch: epoch });
        }
        if (!wave.length) break;
        const failures = await Promise.all(wave.map(async ({ batch, requestEpoch }) => {
          const result = await requestGroup(batch);
          if (requestEpoch !== epoch || !enabled) return false;
          if (!result?.ok) {
            handleTopFailure(batch, result || { code: "worker_failed" }, requestEpoch);
            return true;
          }
          const items = new Map((result.items || []).map(item => [item.id, item]));
          for (const candidate of batch) await handleItem(candidate, items.get(candidate.id), requestEpoch);
          return false;
        }));
        if (failures.some(Boolean)) {
          continueImmediately = false;
          break;
        }
      }
    } finally {
      running = false;
      updateControlState();
      if (continueImmediately && pending.size) schedule();
    }
  }
  function scan(immediate = false) {
    for (const element of observed) {
      if (!element.isConnected) {
        intersection?.unobserve(element);
        observed.delete(element);
        pending.delete(element);
        removeResult(element);
      }
    }
    for (const element of document.querySelectorAll(SELECTOR)) {
      if (!observed.has(element)) {
        observed.add(element);
        intersection?.observe(element);
      }
      const signature = source(element).signature;
      if (completed.has(element) && completed.get(element) !== signature) {
        completed.delete(element);
        removeResult(element);
      }
      if (visible(element)) pending.add(element);
    }
    applyTheme();
    schedule(immediate);
  }
  function reset() {
    epoch += 1;
    fastLanePending = true;
    pending.clear();
    completed = new WeakMap();
    for (const element of [...rendered.keys()]) removeResult(element);
  }
  async function refresh() {
    const prefetched = initialSettings;
    initialSettings = null;
    const settings = prefetched ? await prefetched : await send({ type: "translation:settings" });
    if (!settings?.ok) return;
    reset();
    enabled = settings.enabled;
    hasApiKey = settings.hasApiKey;
    blocked = false;
    ui.toggle.checked = enabled;
    setNotice(hasApiKey ? "" : "설정에서 OpenRouter API 키를 입력하세요", hasApiKey ? "" : "error");
    if (enabled && hasApiKey) scan(true);
    else updateControlState();
  }
  function mount() {
    const style = document.createElement("style");
    style.textContent = `
      .lakomics-translation{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:.96em;line-height:1.52;margin:8px 0 10px;padding:8px 10px;border-left:2px solid rgb(29,155,240);border-radius:0 8px 8px 0;box-sizing:border-box}
      .lakomics-translation[data-theme="light"]{color:#0f1419;background:rgba(29,155,240,.07)}
      .lakomics-translation[data-theme="dim"]{color:#f0f2f4;background:rgba(29,155,240,.09)}
      .lakomics-translation[data-theme="lights-out"]{color:#e7e9ea;background:rgba(29,155,240,.08)}
      .lakomics-translation a{color:rgb(29,155,240);text-decoration:none}
      .lakomics-translation a:hover,.lakomics-translation a:focus-visible{text-decoration:underline}
      .lakomics-translation[data-error="true"]{font-size:12px;padding:4px 8px;background:transparent;opacity:.82}
      .lakomics-translation[data-error="true"][data-theme="light"]{color:#536471;border-left-color:#aab8c2}
      .lakomics-translation[data-error="true"]:not([data-theme="light"]){color:#8b98a5;border-left-color:#536471}`;
    document.head.append(style);
    const host = document.createElement("div");
    host.id = "lakomics-translation-controls";
    host.style.cssText = "position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483000";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e7e9ea;--panel:#111214;--border:#343638;--muted:#8b98a5;--button:#1d1f21;--accent:#1d9bf0}
      :host([data-theme="dim"]){--panel:#15202b;--border:#38444d;--button:#1e2c38}
      :host([data-theme="light"]){color:#0f1419;--panel:#fff;--border:#cfd9de;--muted:#536471;--button:#f7f9f9}
      *{box-sizing:border-box}[hidden]{display:none!important}.wrap{position:relative}.launcher{position:relative;width:40px;height:40px;border-radius:50%;border:1px solid var(--border);background:var(--panel);color:var(--muted);box-shadow:0 4px 16px rgba(0,0,0,.22);display:grid;place-items:center;cursor:pointer;padding:0}.launcher:hover{filter:brightness(1.08)}.launcher:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.launcher svg{width:23px;height:23px}.launcher[data-state="on"],.launcher[data-state="busy"]{color:var(--accent)}.launcher[data-state="busy"] svg{animation:pulse 1.1s ease-in-out infinite}.dot{position:absolute;right:1px;top:1px;width:8px;height:8px;border-radius:50%;background:transparent;border:1px solid transparent}.launcher[data-state="error"] .dot{background:#f4212e;border-color:var(--panel)}.launcher[data-state="warning"] .dot{background:#ffd400;border-color:var(--panel)}@keyframes pulse{50%{opacity:.45;transform:scale(.94)}}
      .panel{position:absolute;right:0;bottom:48px;width:min(270px,calc(100vw - 24px));padding:12px;background:var(--panel);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.28)}.head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.head strong{font-size:13px}.model{font-size:11px;color:var(--muted);white-space:nowrap}.toggle{display:flex;align-items:center;gap:8px;margin:8px 0 12px}.toggle input{accent-color:var(--accent)}.actions{display:flex;gap:6px}.actions button{font:inherit;color:inherit;background:var(--button);border:1px solid var(--border);border-radius:7px;padding:6px 9px;cursor:pointer}.status{font-size:11px;color:var(--muted);margin:9px 0 0}.status:empty{display:none}
    </style><div class="wrap"><button id="translator-button" class="launcher" type="button" aria-label="AI 번역" aria-controls="translator-popover" aria-expanded="false" title="AI 번역"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h7M7.5 3v2.5m-2.2 3.2c1.5 2.1 3.5 3.8 6 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M10.7 8.5c-.9 2.1-2.5 4-4.8 5.6M13.5 18.5l3.1-8 3.1 8m-5-2.7h3.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="dot"></span></button><div id="translator-popover" class="panel" role="dialog" aria-label="AI 번역 설정" hidden><div class="head"><strong>AI 번역</strong><span class="model">Gemini 3.1 Flash Lite</span></div><label class="toggle"><input id="auto" type="checkbox"> 자동 번역</label><div class="actions"><button id="clear" type="button">캐시 비우기</button><button id="settings" type="button">설정</button></div><p id="status" class="status" role="status"></p></div></div>`;
    document.body.append(host);
    ui = {
      host,
      button: shadow.getElementById("translator-button"),
      popover: shadow.getElementById("translator-popover"),
      toggle: shadow.getElementById("auto"),
      status: shadow.getElementById("status"),
      notice: "",
    };
    applyTheme();
    ui.button.onclick = () => {
      ui.popover.hidden = !ui.popover.hidden;
      ui.button.setAttribute("aria-expanded", String(!ui.popover.hidden));
    };
    ui.toggle.onchange = async () => {
      await send({ type: "translation:update", enabled: ui.toggle.checked });
      await refresh();
    };
    shadow.getElementById("clear").onclick = async () => {
      const result = await send({ type: "translation:clear" });
      if (result?.ok) {
        reset();
        setNotice("캐시를 비웠습니다", "");
        if (enabled && hasApiKey && !blocked) scan();
      }
    };
    shadow.getElementById("settings").onclick = () => void send({ type: "settings:open" });
    document.addEventListener("pointerdown", event => {
      if (!ui.popover.hidden && !host.contains(event.target)) {
        ui.popover.hidden = true;
        ui.button.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !ui.popover.hidden) {
        ui.popover.hidden = true;
        ui.button.setAttribute("aria-expanded", "false");
        ui.button.focus();
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[SETTINGS]) void refresh();
      else if (changes[CACHE]?.newValue?.length === 0) {
        reset();
        if (enabled && hasApiKey && !blocked) scan();
      }
    });
    intersection = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) pending.add(entry.target);
      schedule();
    });
    let scanTimer = null;
    new MutationObserver(records => {
      if (!records.some(record => !record.target.closest?.('.lakomics-translation, #lakomics-translation-controls')
        && (record.type !== "childList" || [...record.addedNodes, ...record.removedNodes].some(node => !node.matches?.('.lakomics-translation'))))) return;
      if (scanTimer !== null) return;
      scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 200);
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["lang", "href"] });
    const themeObserver = new MutationObserver(() => applyTheme());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    void refresh();
  }
  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsTranslateContent = { source, needsTranslation, render, detectTheme };
    return;
  }
  initialSettings = send({ type: "translation:settings" });
  if (document.body) mount();
  else {
    const bodyObserver = new MutationObserver(() => {
      if (!document.body) return;
      bodyObserver.disconnect();
      mount();
    });
    bodyObserver.observe(document.documentElement || document, { childList: true, subtree: true });
  }
})();
