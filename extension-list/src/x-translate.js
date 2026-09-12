(() => {
  "use strict";
  const SELECTOR = '[data-testid="tweetText"]';
  const SETTINGS = "lakomics:translation:v1", CACHE = "lakomics:translation-cache:v1";
  let enabled = false, hasApiKey = false, epoch = 0, running = false, timer = null;
  const pending = new Set(), observed = new Set();
  let completed = new WeakMap();
  const rendered = new Map();
  let ui;

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
    return { text, links, signature: JSON.stringify([text, links]) };
  }
  function needsTranslation(element, text) {
    if (element.getAttribute("lang")?.split("-")[0] === "ko") return false;
    const prose = text.replace(/\[\[LINK_\d+\]\]/g, "");
    const letters = prose.match(/\p{L}/gu) || [];
    const korean = prose.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) || [];
    return letters.length >= 2 && korean.length / letters.length < 0.55;
  }
  function visible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
  }
  function removeResult(element) { rendered.get(element)?.remove(); rendered.delete(element); }
  function render(element, snapshot, text, error = false) {
    removeResult(element);
    const node = document.createElement("div");
    node.className = "lakomics-translation";
    node.dataset.error = String(error);
    node.setAttribute("lang", "ko");
    const links = new Map(snapshot.links.map(link => [link.token, link]));
    for (const piece of text.split(/(\[\[LINK_\d+\]\])/g)) {
      const link = links.get(piece);
      if (!link) { node.append(document.createTextNode(piece)); continue; }
      let url;
      try { url = new URL(link.href); } catch {}
      if (!url || !["http:", "https:"].includes(url.protocol)) { node.append(document.createTextNode(link.label)); continue; }
      const anchor = document.createElement("a");
      anchor.href = url.href; anchor.textContent = link.label; anchor.rel = "noopener noreferrer";
      node.append(anchor);
    }
    element.after(node); rendered.set(element, node);
  }
  function failure(code) {
    if (code === "http_401" || code === "api_key_missing") return "번역 API 키를 확인하세요";
    if (code === "http_402") return "OpenRouter 잔액을 확인하세요";
    if (code === "http_429") return "번역 요청 한도 초과 · 잠시 후 자동 번역을 다시 켜세요";
    return "번역 실패 · 자동 번역을 다시 켜면 재시도합니다";
  }
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; void drain(); }, 150);
  }
  async function drain() {
    if (running || !enabled || !hasApiKey) return;
    running = true;
    try {
      for (const element of pending) {
        pending.delete(element);
        if (!enabled || !hasApiKey) break;
        if (!element.isConnected || !visible(element)) continue;
        const snapshot = source(element);
        if (completed.get(element) === snapshot.signature || !needsTranslation(element, snapshot.text)) continue;
        completed.set(element, snapshot.signature);
        const requestEpoch = epoch;
        const result = await send({ type: "translation:request", text: snapshot.text });
        if (requestEpoch !== epoch || !enabled || !element.isConnected || source(element).signature !== snapshot.signature) continue;
        if (result?.ok) render(element, snapshot, result.text);
        else if (result?.code !== "disabled") {
          render(element, snapshot, failure(result?.code), true);
          // Authentication/quota failures must not trigger a request for every tweet.
          if (["http_401", "http_402", "http_403", "http_429", "api_key_missing"].includes(result?.code)) {
            hasApiKey = false; pending.clear(); ui.status.textContent = failure(result.code); break;
          }
        }
      }
    } finally { running = false; }
  }
  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) pending.add(entry.target);
    schedule();
  });
  function scan() {
    for (const element of observed) {
      if (!element.isConnected) { intersection.unobserve(element); observed.delete(element); pending.delete(element); removeResult(element); }
    }
    for (const element of document.querySelectorAll(SELECTOR)) {
      if (!observed.has(element)) { observed.add(element); intersection.observe(element); }
      const signature = source(element).signature;
      if (completed.has(element) && completed.get(element) !== signature) { completed.delete(element); removeResult(element); }
      if (visible(element)) pending.add(element);
    }
    schedule();
  }
  function reset() {
    epoch += 1; pending.clear(); completed = new WeakMap();
    for (const element of rendered.keys()) removeResult(element);
  }
  async function refresh() {
    const settings = await send({ type: "translation:settings" });
    if (!settings?.ok) return;
    reset(); enabled = settings.enabled; hasApiKey = settings.hasApiKey;
    ui.toggle.checked = enabled;
    ui.status.textContent = hasApiKey ? "" : "설정에서 OpenRouter API 키를 입력하세요";
    if (enabled && hasApiKey) scan();
  }
  function mount() {
    const style = document.createElement("style");
    style.textContent = '.lakomics-translation{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:.94em;line-height:1.5;margin:8px 0;color:inherit;opacity:.85;border-left:2px solid #888;padding-left:10px}.lakomics-translation[data-error="true"]{font-size:12px;opacity:.65}.lakomics-translation a{color:inherit;text-decoration:underline}';
    document.head.append(style);
    const host = document.createElement("div"); host.id = "lakomics-translation-controls";
    host.style.cssText = "position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483000";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>:host{font:13px/1.5 system-ui;color:#e5e3dd}details{background:#191a1c;border:1px solid #414244;border-radius:4px;padding:8px 12px;max-width:260px}summary{cursor:pointer}label{display:block;margin:10px 0}button{font:inherit;color:inherit;background:#232426;border:1px solid #414244;border-radius:3px;padding:7px 10px;cursor:pointer}p{font-size:12px;color:#a6a7a5;margin:8px 0}input{accent-color:#ddd8ca}</style><details><summary>AI 번역</summary><p>Gemini 2.5 Flash Lite · 한국어</p><label><input id="auto" type="checkbox"> 자동 번역</label><button id="clear">캐시 비우기</button> <button id="settings">설정</button><p id="status" role="status"></p></details>`;
    document.body.append(host);
    ui = { toggle: shadow.getElementById("auto"), status: shadow.getElementById("status") };
    ui.toggle.onchange = async () => { await send({ type: "translation:update", enabled: ui.toggle.checked }); await refresh(); };
    shadow.getElementById("clear").onclick = async () => {
      const result = await send({ type: "translation:clear" });
      if (result?.ok) { reset(); ui.status.textContent = "캐시를 비웠습니다"; }
    };
    shadow.getElementById("settings").onclick = () => void send({ type: "settings:open" });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[SETTINGS]) void refresh();
      else if (changes[CACHE]?.newValue?.length === 0) reset();
    });
    let scanTimer = null;
    new MutationObserver(records => {
      if (!records.some(record => !record.target.closest?.('.lakomics-translation, #lakomics-translation-controls')
        && (record.type !== "childList" || [...record.addedNodes, ...record.removedNodes].some(node => !node.matches?.('.lakomics-translation'))))) return;
      if (scanTimer !== null) return;
      scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 200);
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["lang", "href"] });
    void refresh();
  }
  if (globalThis.__LAKOMICS_TEST__) { globalThis.LakomicsTranslateContent = { source, needsTranslation, render }; return; }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
