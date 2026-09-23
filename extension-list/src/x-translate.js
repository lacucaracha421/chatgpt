(() => {
  "use strict";
  const SELECTOR = '[data-testid="tweetText"]';
  const SETTINGS = "lakomics:translation:v1";
  const CACHE = "lakomics:translation-cache:v2";
  const MAX_BATCH_ITEMS = 4;
  const MAX_BATCH_CHARS = 6000;
  const MAX_FAILURES = 3;
  const RETRY_DELAY_CAP_MS = 60000;
  const RETRY_DELAY_DEFAULT_MS = 1500;
  const MAX_IN_FLIGHT = 2;
  let enabled = false, hasApiKey = false, blocked = false, epoch = 0, running = false, timer = null, requestSerial = 0, fastLanePending = true, inFlight = 0;
  let initialSettings = null;
  // requested holds elements whose request (or queued fallback) is outstanding, so the
  // other slot never sends the same post twice.
  const pending = new Set(), observed = new Set(), requested = new Set(), fallbacks = [];
  let completed = new WeakMap(), failures = new WeakMap(), outsideViewport = new WeakSet(), intersection, ui;
  const rendered = new Map(), toggles = new Map();

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
    // A couple of Han or Kana characters are a complete post, so they count as content
    // while a stray single letter does not.
    const script = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(prose);
    const letters = prose.match(/\p{L}/gu) || [];
    if (letters.length < 3 && !script) return false;
    if (lang && lang !== "und" && lang !== "zxx") return true;
    const korean = prose.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) || [];
    return korean.length / letters.length < 0.55;
  }
  // Posts up to 1.5 screens below (and a quarter screen above) are translated ahead
  // while the slots are free, so they are usually ready on arrival; posts on screen
  // still come first because work is ordered by distance from the viewport centre.
  const AHEAD_SCREENS = 1.5, BEHIND_SCREENS = 0.25;
  function near(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > -innerHeight * BEHIND_SCREENS && rect.top < innerHeight * (1 + AHEAD_SCREENS);
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
  const PENDING_DELAY_MS = 250, COLLAPSE_MIN_HEIGHT = 44;
  function removeResult(element) {
    rendered.get(element)?.remove();
    rendered.delete(element);
    toggles.get(element)?.remove();
    toggles.delete(element);
    element.removeAttribute?.("data-lakomics-collapsed");
  }
  // A quiet "번역 중…" line appears only when a request outlasts a short delay, so fast
  // answers never flash; the result later replaces it in place.
  function showPending(element) {
    setTimeout(() => {
      if (!requested.has(element) || !element.isConnected) return;
      const card = rendered.get(element);
      if (card && card.dataset.error !== "true") return;
      removeResult(element);
      const node = document.createElement("div");
      node.className = "lakomics-translation"; node.dataset.state = "pending"; node.dataset.theme = detectTheme();
      node.setAttribute("aria-hidden", "true"); node.textContent = "번역 중…";
      element.after(node); rendered.set(element, node);
    }, PENDING_DELAY_MS);
  }
  // With a translation shown, a long original folds to two lines behind a toggle so a
  // post does not take twice its height; the button never opens the post itself.
  function collapseOriginal(element, node) {
    if (element.getBoundingClientRect().height <= COLLAPSE_MIN_HEIGHT) return;
    element.dataset.lakomicsCollapsed = "true";
    const toggle = document.createElement("button");
    toggle.type = "button"; toggle.className = "lakomics-translation-toggle";
    const sync = () => {
      const collapsed = element.dataset.lakomicsCollapsed === "true";
      toggle.textContent = collapsed ? "원문 펼치기" : "원문 접기";
      toggle.setAttribute("aria-expanded", String(!collapsed));
    };
    toggle.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      element.dataset.lakomicsCollapsed = element.dataset.lakomicsCollapsed === "true" ? "false" : "true";
      sync();
    });
    sync(); node.after(toggle); toggles.set(element, toggle);
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
    // A translation may drop a hashtag or link; keep it clickable at the end.
    if (!error) for (const link of snapshot.links) {
      if (text.includes(link.token)) continue;
      let url;
      try { url = new URL(link.href); } catch {}
      node.append(document.createTextNode(" "));
      if (!url || !["http:", "https:"].includes(url.protocol)) { node.append(document.createTextNode(link.label)); continue; }
      const anchor = document.createElement("a");
      anchor.href = url.href; anchor.textContent = link.label; anchor.rel = "noopener noreferrer";
      node.append(anchor);
    }
    element.after(node);
    rendered.set(element, node);
    if (!error) collapseOriginal(element, node);
  }
  function failure(code, retryable = false) {
    if (code === "http_401" || code === "api_key_missing") return "번역 API 키를 확인하세요";
    if (code === "http_402") return "OpenRouter 잔액을 확인하세요";
    if (code === "http_403") return "OpenRouter API 접근 권한을 확인하세요";
    if (code === "http_429") return "번역 요청 한도 · 잠시 후 자동 재시도";
    if (isTransientFailure(code)) return "번역 연결 실패 · 다시 보이면 재시도";
    return retryable ? "번역 실패 · 다시 보이면 재시도" : "번역 실패 · 자동 번역을 껐다 켜면 재시도";
  }
  function setNotice(text = "", kind = "") {
    if (!ui) return;
    ui.notice = kind;
    ui.status.textContent = text;
    updateControlState();
  }
  function isTransientFailure(code) {
    return ["timeout", "network_error", "worker_failed"].includes(code) || /^http_5\d\d$/.test(code || "");
  }
  function failuresFor(element, signature) {
    const record = failures.get(element);
    return record && record.signature === signature ? record : null;
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
      drain();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; drain(); }, 120);
  }
  function current(candidate, requestEpoch) {
    return requestEpoch === epoch && enabled && !blocked && candidate.element.isConnected
      && source(candidate.element).signature === candidate.snapshot.signature;
  }
  function collectBatch(limit = MAX_BATCH_ITEMS, forceSingle = false) {
    const center = innerHeight / 2;
    const elements = [...pending].filter(element => element.isConnected && near(element))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return Math.abs((ar.top + ar.bottom) / 2 - center) - Math.abs((br.top + br.bottom) / 2 - center);
      });
    const batch = [];
    let chars = 0;
    for (const element of elements) {
      if (batch.length >= limit) break;
      // Keep an in-flight post queued: if its text changes meanwhile, the stale answer
      // is dropped and the new text is requested once the slot frees.
      if (requested.has(element)) continue;
      pending.delete(element);
      const snapshot = source(element);
      // DOM scans must not bypass a cooldown or retry an unchanged failed post.
      if (failuresFor(element, snapshot.signature)?.nextAttemptAt > Date.now()) continue;
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
    for (const element of [...pending]) if (!element.isConnected || !near(element)) pending.delete(element);
    return batch;
  }
  function requeueLater(candidates, waitMs, requestEpoch) {
    const delay = Math.max(250, Math.min(RETRY_DELAY_CAP_MS, Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : RETRY_DELAY_DEFAULT_MS));
    const retry = [];
    for (const candidate of candidates) {
      if (!current(candidate, requestEpoch)) continue;
      const previous = failuresFor(candidate.element, candidate.snapshot.signature);
      const attempts = (previous?.attempts || 0) + 1;
      const record = { signature: candidate.snapshot.signature, code: "http_429", attempts,
        nextAttemptAt: attempts < MAX_FAILURES ? Date.now() + delay : Infinity };
      failures.set(candidate.element, record);
      if (attempts < MAX_FAILURES) retry.push({ candidate, record });
      else {
        const message = "번역 요청 한도 · 자동 재시도 중단";
        render(candidate.element, candidate.snapshot, message, true);
        setNotice(message, "warning");
      }
    }
    if (!retry.length) return;
    setTimeout(() => {
      if (requestEpoch !== epoch || !enabled || !hasApiKey || blocked) return;
      for (const { candidate, record } of retry) {
        if (current(candidate, requestEpoch) && failures.get(candidate.element) === record) pending.add(candidate.element);
      }
      schedule();
    }, delay);
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
      requeueLater(candidates, result?.retryAfterMs, requestEpoch);
      return "cooldown";
    }
    let notice = "";
    for (const candidate of candidates) {
      if (!current(candidate, requestEpoch)) continue;
      const record = failuresFor(candidate.element, candidate.snapshot.signature);
      const attempts = (record?.attempts || 0) + 1;
      // Transient failures retry whenever the post re-enters the viewport; any other
      // failure gets one such retry before it is parked until translation is reset.
      const retryOnReentry = !isTransientFailure(code) && attempts < 2;
      failures.set(candidate.element, { signature: candidate.snapshot.signature, code, attempts, nextAttemptAt: Infinity, retryOnReentry });
      notice = failure(code, retryOnReentry);
      render(candidate.element, candidate.snapshot, notice, true);
    }
    setNotice(notice || failure(code), "warning");
    return "failed";
  }
  function accept(candidate, text) {
    // null means the model found nothing to translate (names, Latin terms): no card.
    if (text === null) removeResult(candidate.element);
    else render(candidate.element, candidate.snapshot, text);
    completed.set(candidate.element, candidate.snapshot.signature);
    failures.delete(candidate.element);
    setNotice("", "");
  }
  function handleItem(candidate, item, requestEpoch) {
    if (!current(candidate, requestEpoch)) return;
    if (item?.ok) { accept(candidate, item.text); return; }
    if (item?.code === "invalid_translation" && !candidate.single) {
      // Re-ask alone in its own slot turn, without holding up other groups.
      requested.add(candidate.element);
      fallbacks.push({ candidate, requestEpoch });
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
  async function runGroup(batch, requestEpoch) {
    const result = await requestGroup(batch);
    for (const candidate of batch) requested.delete(candidate.element);
    if (requestEpoch !== epoch || !enabled) return;
    if (!result?.ok) { handleTopFailure(batch, result || { code: "worker_failed" }, requestEpoch); return; }
    const items = new Map((result.items || []).map(item => [item.id, item]));
    for (const candidate of batch) handleItem(candidate, items.get(candidate.id), requestEpoch);
  }
  async function runFallback({ candidate, requestEpoch }) {
    // A batch item the main model answered badly is asked of the sub model first.
    const result = await send({ type: "translation:request", text: candidate.snapshot.text, fallback: true });
    requested.delete(candidate.element);
    if (!current(candidate, requestEpoch)) return;
    if (result?.ok) accept(candidate, result.text);
    else handleTopFailure([candidate], result || { code: "worker_failed" }, requestEpoch);
  }
  // Two continuous slots: whenever one frees, the next queued fallback or group starts
  // at once. After new posts come into view, the one nearest the viewport centre goes
  // alone first so the post being read appears first.
  function drain() {
    while (inFlight < MAX_IN_FLIGHT && enabled && hasApiKey && !blocked) {
      const requestEpoch = epoch;
      let work = null;
      while (!work && fallbacks.length) {
        const fallback = fallbacks.shift();
        if (current(fallback.candidate, fallback.requestEpoch)) work = () => runFallback(fallback);
        else requested.delete(fallback.candidate.element);
      }
      if (!work) {
        let batch = [];
        if (fastLanePending) { batch = collectBatch(1, true); fastLanePending = false; }
        if (!batch.length) batch = collectBatch();
        if (!batch.length) break;
        for (const candidate of batch) { requested.add(candidate.element); showPending(candidate.element); }
        work = () => runGroup(batch, requestEpoch);
      }
      inFlight += 1; running = true; updateControlState();
      void Promise.resolve().then(work).catch(() => {}).finally(() => {
        inFlight -= 1; running = inFlight > 0; updateControlState();
        drain();
      });
    }
  }
  function scan(immediate = false) {
    for (const element of observed) {
      if (!element.isConnected) {
        intersection?.unobserve(element);
        observed.delete(element);
        pending.delete(element);
        failures.delete(element);
        removeResult(element);
      }
    }
    for (const element of document.querySelectorAll(SELECTOR)) {
      if (!observed.has(element)) {
        observed.add(element);
        intersection?.observe(element);
      }
      const snapshot = source(element);
      // Recycled text is a new job even if its previous translation failed.
      const record = failures.get(element);
      const changed = Boolean(record && record.signature !== snapshot.signature)
        || (completed.has(element) && completed.get(element) !== snapshot.signature);
      if (changed) {
        completed.delete(element);
        failures.delete(element);
        removeResult(element);
      }
      if (visible(element) && !pending.has(element) && !requested.has(element) && completed.get(element) !== snapshot.signature && !failures.has(element)) {
        pending.add(element); fastLanePending = true;
      } else if (near(element)) pending.add(element);
    }
    applyTheme();
    schedule(immediate);
  }
  function reset() {
    epoch += 1;
    fastLanePending = true;
    pending.clear(); requested.clear(); fallbacks.length = 0;
    completed = new WeakMap();
    failures = new WeakMap();
    outsideViewport = new WeakSet();
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
    if (settings.modelLabel) ui.model.textContent = settings.modelLabel;
    setNotice(hasApiKey ? "" : "설정에서 OpenRouter API 키를 입력하세요", hasApiKey ? "" : "error");
    if (enabled && hasApiKey) scan(true);
    else updateControlState();
  }
  function mount() {
    const style = document.createElement("style");
    style.textContent = `
      .lakomics-translation{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:.96em;line-height:1.36;margin:8px 0 10px;padding:8px 10px;border-left:2px solid rgb(29,155,240);border-radius:0 8px 8px 0;box-sizing:border-box}
      .lakomics-translation[data-theme="light"]{color:#0f1419;background:rgba(29,155,240,.07)}
      .lakomics-translation[data-theme="dim"]{color:#f0f2f4;background:rgba(29,155,240,.09)}
      .lakomics-translation[data-theme="lights-out"]{color:#e7e9ea;background:rgba(29,155,240,.08)}
      .lakomics-translation a{color:rgb(29,155,240);text-decoration:none}
      .lakomics-translation a:hover,.lakomics-translation a:focus-visible{text-decoration:underline}
      .lakomics-translation[data-error="true"]{font-size:12px;padding:4px 8px;background:transparent;opacity:.82}
      .lakomics-translation[data-error="true"][data-theme="light"]{color:#536471;border-left-color:#aab8c2}
      .lakomics-translation[data-error="true"]:not([data-theme="light"]){color:#8b98a5;border-left-color:#536471}
      .lakomics-translation[data-state="pending"]{font-size:12px;padding:4px 8px;background:transparent;opacity:.7;color:#8b98a5;border-left-color:#536471}
      .lakomics-translation[data-state="pending"][data-theme="light"]{color:#536471;border-left-color:#aab8c2}
      [data-testid="tweetText"][data-lakomics-collapsed="true"]{display:-webkit-box!important;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
      .lakomics-translation-toggle{display:block;margin:-4px 0 8px auto;padding:2px 0;border:0;background:none;font:inherit;font-size:12px;color:rgb(29,155,240);cursor:pointer;white-space:nowrap}
      .lakomics-translation-toggle:hover,.lakomics-translation-toggle:focus-visible{text-decoration:underline}
      .lakomics-translation-toggle:focus-visible{outline:2px solid rgb(29,155,240);outline-offset:2px;border-radius:2px}`;
    document.head.append(style);
    const host = document.createElement("div");
    host.id = "lakomics-translation-controls";
    // Wide desktop X docks its messages drawer at the bottom right; sit above it there.
    const clearDrawer = globalThis.matchMedia?.("(min-width: 1000px) and (pointer: fine)")?.matches;
    host.style.cssText = `position:fixed;right:12px;bottom:calc(${clearDrawer ? 76 : 12}px + env(safe-area-inset-bottom,0px));z-index:2147483000`;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e7e9ea;--panel:#111214;--border:#343638;--muted:#8b98a5;--button:#1d1f21;--accent:#1d9bf0}
      :host([data-theme="dim"]){--panel:#15202b;--border:#38444d;--button:#1e2c38}
      :host([data-theme="light"]){color:#0f1419;--panel:#fff;--border:#cfd9de;--muted:#536471;--button:#f7f9f9}
      *{box-sizing:border-box}[hidden]{display:none!important}.wrap{position:relative}.launcher{position:relative;width:40px;height:40px;border-radius:50%;border:1px solid var(--border);background:var(--panel);color:var(--muted);box-shadow:0 4px 16px rgba(0,0,0,.22);display:grid;place-items:center;cursor:pointer;padding:0}.launcher:hover{filter:brightness(1.08)}.launcher:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.launcher svg{width:23px;height:23px}.launcher[data-state="on"],.launcher[data-state="busy"]{color:var(--accent)}.launcher[data-state="busy"] svg{animation:pulse 1.1s ease-in-out infinite}.dot{position:absolute;right:1px;top:1px;width:8px;height:8px;border-radius:50%;background:transparent;border:1px solid transparent}.launcher[data-state="error"] .dot{background:#f4212e;border-color:var(--panel)}.launcher[data-state="warning"] .dot{background:#ffd400;border-color:var(--panel)}@keyframes pulse{50%{opacity:.45;transform:scale(.94)}}
      .panel{position:absolute;right:0;bottom:48px;width:min(270px,calc(100vw - 24px));padding:12px;background:var(--panel);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.28)}.head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.head strong{font-size:13px}.model{font-size:11px;color:var(--muted);white-space:nowrap}.toggle{display:flex;align-items:center;gap:8px;margin:8px 0 12px}.toggle input{accent-color:var(--accent)}.actions{display:flex;gap:6px}.actions button{font:inherit;color:inherit;background:var(--button);border:1px solid var(--border);border-radius:7px;padding:6px 9px;cursor:pointer}.status{font-size:11px;color:var(--muted);margin:9px 0 0}.status:empty{display:none}
    </style><div class="wrap"><button id="translator-button" class="launcher" type="button" aria-label="AI 번역" aria-controls="translator-popover" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h7M7.5 3v2.5m-2.2 3.2c1.5 2.1 3.5 3.8 6 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M10.7 8.5c-.9 2.1-2.5 4-4.8 5.6M13.5 18.5l3.1-8 3.1 8m-5-2.7h3.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="dot"></span></button><div id="translator-popover" class="panel" role="dialog" aria-label="AI 번역 설정" hidden><div class="head"><strong>AI 번역</strong><span class="model" id="model-name">Gemini 3.1 Flash Lite</span></div><label class="toggle"><input id="auto" type="checkbox"> 자동 번역</label><div class="actions"><button id="clear" type="button">캐시 비우기</button><button id="settings" type="button">설정</button></div><p id="status" class="status" role="status"></p></div></div>`;
    document.body.append(host);
    ui = {
      host,
      button: shadow.getElementById("translator-button"),
      popover: shadow.getElementById("translator-popover"),
      toggle: shadow.getElementById("auto"),
      model: shadow.getElementById("model-name"),
      status: shadow.getElementById("status"),
      notice: "",
    };
    applyTheme();
    ui.button.onclick = () => {
      ui.popover.hidden = !ui.popover.hidden;
      ui.button.setAttribute("aria-expanded", String(!ui.popover.hidden));
    };
    ui.toggle.onchange = async () => {
      const result = await send({ type: "translation:update", enabled: ui.toggle.checked });
      // A successful write refreshes every tab through storage.onChanged.
      if (!result?.ok) {
        await refresh();
        setNotice("번역 설정 저장 실패", "warning");
      }
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
      for (const entry of entries) {
        if (!entry.isIntersecting) { outsideViewport.add(entry.target); continue; }
        const record = failures.get(entry.target);
        if (outsideViewport.has(entry.target) && record) {
          if (isTransientFailure(record.code)) failures.delete(entry.target);
          else if (record.retryOnReentry) { record.retryOnReentry = false; record.nextAttemptAt = 0; }
        }
        outsideViewport.delete(entry.target);
        if (visible(entry.target) && !pending.has(entry.target) && !requested.has(entry.target) && !completed.has(entry.target)) fastLanePending = true;
        pending.add(entry.target);
      }
      schedule();
    }, { rootMargin: `${BEHIND_SCREENS * 100}% 0px ${AHEAD_SCREENS * 100}% 0px` });
    let scanTimer = null;
    new MutationObserver(records => {
      if (!records.some(record => !record.target.closest?.('.lakomics-translation, .lakomics-translation-toggle, #lakomics-translation-controls')
        && (record.type !== "childList" || [...record.addedNodes, ...record.removedNodes].some(node => !node.matches?.('.lakomics-translation, .lakomics-translation-toggle'))))) return;
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
