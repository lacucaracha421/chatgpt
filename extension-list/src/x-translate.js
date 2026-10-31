(() => {
  "use strict";
  const SELECTOR = '[data-testid="tweetText"]';
  const SETTINGS = "lakomics:translation:v1";
  // The background bumps this key whenever it clears the translation cache.
  const CACHE_CLEARED = "lakomics:translation-cache-cleared";
  const OWN_NODES = '.lakomics-translation, .lakomics-translation-toggle, #lakomics-translation-controls';
  const MAX_BATCH_ITEMS = 4;
  const MAX_BATCH_CHARS = 6000;
  const MAX_FAILURES = 3;
  const RETRY_DELAY_CAP_MS = 60000;
  const RETRY_DELAY_DEFAULT_MS = 1500;
  // Requests in flight from this tab; the background raises it for models with higher limits.
  let maxInFlight = 2;
  const SHOW_MORE = '[data-testid="tweet-text-show-more-link"]';
  const EXPAND_WAIT_MS = 1500;
  // A reply that never comes would hold a request slot (and its "번역 중…" lines) until the
  // page is reloaded; past this the request counts as a transient failure.
  const SEND_TIMEOUT_MS = 45000;
  const WATCHDOG_MS = 43000; // Worker budget (39.3 s) plus delivery margin.
  // Transient failures retry by themselves this many times, then on viewport re-entry.
  const AUTO_RETRY_DELAYS_MS = [4000, 15000];
  let enabled = false, hasApiKey = false, blocked = false, epoch = 0, running = false, timer = null, requestSerial = 0, fastLanePending = true, inFlight = 0;
  let initialSettings = null, refreshSerial = 0;
  // requested holds elements whose request (or queued fallback) is outstanding, so the
  // other slot never sends the same post twice.
  const pending = new Set(), observed = new Set(), requested = new Set(), fallbacks = [];
  let completed = new WeakMap(), failures = new WeakMap(), outsideViewport = new WeakSet(), intersection, viewportIntersection, ui;
  const nearby = new WeakSet();
  const rendered = new Map(), toggles = new Map();
  const owners = new Map();
  let scrollDirection = 1, scrollExtremeY = globalThis.scrollY || 0;
  // Reading innerHeight or scrollY while X has pending DOM changes forces a layout,
  // so the height is cached on resize and the scroll position is read once per frame.
  let viewHeight = globalThis.innerHeight || 0;
  const snapshots = new WeakMap();
  const changedTexts = new Set();
  let textObserver, onTextMutations;
  // Main-tweet articles whose "Show more" was pressed, with the time to stop waiting.
  const expansions = new WeakMap();

  function send(message) {
    return new Promise(resolve => {
      let settled = false;
      const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => finish({ ok: false, code: "worker_failed" }), SEND_TIMEOUT_MS);
      try { chrome.runtime.sendMessage(message, result => finish(chrome.runtime.lastError ? { ok: false, code: "worker_failed" } : result || { ok: false, code: "worker_failed" })); }
      catch { finish({ ok: false, code: "worker_failed" }); }
    });
  }
  function source(element) {
    // A worker reply can arrive before mutation delivery. Consume queued changes
    // before checking a cached signature, including while translation is paused.
    if (textObserver) onTextMutations(textObserver.takeRecords());
    const cached = snapshots.get(element);
    if (cached) return cached;
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
    const snapshot = { text, links, signature: JSON.stringify([text, links, element.getAttribute("lang") || ""]) };
    if (textObserver) snapshots.set(element, snapshot);
    return snapshot;
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
  // On a post's own page the main tweet may be cut short behind "Show more", which there
  // expands in place. Only that tweet is expanded, never replies, quotes or timeline
  // posts (where the control can open the post), and never through a link.
  function insideQuote(node, article) {
    const quote = node.closest('[role="link"]');
    return Boolean(quote && article.contains(quote));
  }
  function mainArticle(element) {
    const id = location.pathname.match(/^\/[^/]+\/status\/(\d+)/)?.[1];
    const article = id && element.closest('article[data-testid="tweet"]');
    if (!article || insideQuote(element, article)) return null;
    if (article.getAttribute("tabindex") === "-1") return article;
    const own = [...article.querySelectorAll('a[href*="/status/"]')].some(link => {
      if (!link.querySelector("time") || insideQuote(link, article)) return false;
      try { return new URL(link.href, location.href).pathname.match(/\/status\/(\d+)\/?$/)?.[1] === id; } catch { return false; }
    });
    return own ? article : null;
  }
  function inlineShowMore(element) {
    const article = mainArticle(element);
    if (!article) return null;
    const control = [...article.querySelectorAll(SHOW_MORE)].find(node => !insideQuote(node, article));
    return control && !control.closest('a[href], [role="link"]') ? control : null;
  }
  // True while the main tweet's full text is still being revealed; after the bounded
  // wait the visible text is translated instead.
  function holdForExpansion(element) {
    const control = inlineShowMore(element);
    if (!control) return false;
    const article = control.closest('article');
    const state = expansions.get(article);
    if (state) return Date.now() < state.until;
    expansions.set(article, { until: Date.now() + EXPAND_WAIT_MS });
    try { control.click(); } catch {}
    setTimeout(() => scan(), EXPAND_WAIT_MS + 20);
    return true;
  }
  // Prefetch three screens in the scroll direction, keeping a small margin behind.
  // On-screen posts always win, ordered by distance from the viewport centre.
  const AHEAD_SCREENS = 3, BEHIND_SCREENS = 0.25;
  function near(element, rect) {
    if (!rect) return nearby.has(element);
    return rect.width > 0 && rect.height > 0 && rect.bottom > -viewHeight * (scrollDirection < 0 ? AHEAD_SCREENS : BEHIND_SCREENS) && rect.top < viewHeight * (1 + (scrollDirection > 0 ? AHEAD_SCREENS : BEHIND_SCREENS));
  }
  function visible(element) {
    return viewportState.get(element) === true;
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
  // Scans run often; rendered nodes are rewritten only when the page theme actually changes.
  let lastTheme = null;
  function applyTheme() {
    const theme = detectTheme();
    if (theme === lastTheme) return theme;
    lastTheme = theme;
    if (ui?.host) ui.host.dataset.theme = theme;
    for (const node of rendered.values()) node.dataset.theme = theme;
    return theme;
  }
  const currentTheme = () => lastTheme ?? applyTheme();
  const PENDING_DELAY_MS = 400, COLLAPSE_MIN_HEIGHT = 44;
  function removeResult(element) {
    rendered.get(element)?.remove();
    rendered.delete(element);
    toggles.get(element)?.remove();
    toggles.delete(element);
    element.removeAttribute?.("data-lakomics-collapsed");
  }
  // A quiet "번역 중…" line appears only when a request outlasts a short delay, so fast
  // answers never flash; the result later replaces it in place.
  function showPending(candidate, requestEpoch) {
    const element = candidate.element;
    setTimeout(() => {
      if (owners.get(element) !== candidate || !current(candidate, requestEpoch)) return;
      const card = rendered.get(element);
      if (card && card.dataset.error !== "true") return;
      removeResult(element);
      const node = document.createElement("div");
      node.className = "lakomics-translation"; node.dataset.state = "pending"; node.dataset.theme = currentTheme();
      node.setAttribute("aria-hidden", "true"); node.textContent = "번역 중…";
      element.after(node); rendered.set(element, node);
    }, PENDING_DELAY_MS);
  }
  // With a translation shown, a long original folds to two lines behind a toggle so a
  // post does not take twice its height; the button never opens the post itself.
  function originalHeights(elements) {
    const collapsed = elements.filter(element => element.dataset.lakomicsCollapsed === "true");
    for (const element of collapsed) element.removeAttribute("data-lakomics-collapsed");
    const heights = new Map(elements.map(element => [element, element.getBoundingClientRect().height]));
    for (const element of collapsed) element.dataset.lakomicsCollapsed = "true";
    return heights;
  }
  function collapseOriginal(element, node, height) {
    if (height <= COLLAPSE_MIN_HEIGHT) return;
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
  // An error card offers "다시 시도" so a failed post never needs a page reload.
  function addRetry(element, node) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "lakomics-translation-toggle lakomics-translation-retry";
    button.textContent = "다시 시도";
    button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (event.isTrusted !== true) return;
      if (!enabled || !hasApiKey || blocked) return;
      failures.delete(element); completed.delete(element); removeResult(element);
      pending.add(element); fastLanePending = true;
      schedule(true);
    });
    node.after(button); toggles.set(element, button);
  }
  // A request waiting out a rate limit says so instead of an endless "번역 중…".
  function showWaiting(element, text) {
    removeResult(element);
    const node = document.createElement("div");
    node.className = "lakomics-translation"; node.dataset.state = "pending"; node.dataset.theme = currentTheme();
    node.setAttribute("aria-hidden", "true"); node.textContent = text;
    element.after(node); rendered.set(element, node);
  }
  function render(element, snapshot, text, error = false, replaceText = false, height) {
    const previous = replaceText && rendered.get(element);
    if (!error && !previous) height ??= originalHeights([element]).get(element);
    if (!previous) removeResult(element);
    const node = previous || document.createElement("div");
    if (previous) node.replaceChildren();
    node.className = "lakomics-translation";
    node.dataset.error = String(error);
    node.dataset.theme = currentTheme();
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
    if (!previous) element.after(node);
    const heading = document.createElement("span");
    heading.style.cssText = "display:block;white-space:normal";
    const headingRoot = heading.attachShadow({ mode: "closed" });
    const headingStyle = document.createElement("style");
    headingStyle.textContent = `
      .h{display:flex;align-items:center;gap:8px;height:20px;margin:0 0 4px;font:400 12px/20px "Pretendard Variable",Pretendard,"Malgun Gothic","Segoe UI",sans-serif;color:color-mix(in srgb,currentColor 55%,transparent)}
      .sp{flex:1}.x{display:grid;place-items:center;width:20px;height:20px;border:0;border-radius:2px;background:transparent;color:inherit;padding:0;opacity:0;transition:opacity 90ms cubic-bezier(.2,0,0,1);cursor:pointer}
      :host-context(.lakomics-translation:hover) .x,.h:focus-within .x{opacity:1}.x:focus-visible{outline:2px solid #2f6fdb;outline-offset:1px}.x svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5}
      @media(hover:none){.x{opacity:1;width:44px;height:44px;margin:-12px -12px -12px 0}.h{height:24px;font-size:13px}.x svg{width:20px;height:20px}}
      @media(prefers-reduced-motion:reduce){.x{transition:none}}`;
    const header = document.createElement("span"); header.className = "h";
    const title = document.createElement("span"); title.textContent = "번역";
    const spacer = document.createElement("span"); spacer.className = "sp";
    const close = document.createElement("button"); close.type = "button"; close.className = "x"; close.setAttribute("aria-label", "번역 닫기");
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); removeResult(element); });
    header.append(title, spacer, close); headingRoot.append(headingStyle, header); node.prepend(heading);
    node.setAttribute("role", error ? "status" : "region"); node.setAttribute("aria-label", "한국어 번역");
    rendered.set(element, node);
    if (!error && !previous) collapseOriginal(element, node, height);
    else if (error) addRetry(element, node);
  }
  function failure(code, retryable = false, autoRetry = false) {
    if (code === "http_401" || code === "api_key_missing") return "번역 API 키를 확인하세요";
    if (code === "http_402") return "번역 API 잔액을 확인하세요";
    if (code === "http_403") return "번역 API 접근 권한을 확인하세요";
    if (code === "http_429") return "번역 요청 한도 · 잠시 후 자동 재시도";
    if (code === "text_too_long") return "너무 길어서 번역할 수 없음";
    if (isTransientFailure(code)) return autoRetry ? "번역 연결 실패 · 곧 자동 재시도" : "번역 연결 실패 · 다시 보이면 재시도";
    return retryable ? "번역 실패 · 다시 보이면 재시도" : "번역 실패 · 자동 번역을 껐다 켜면 재시도";
  }
  function setNotice(text = "", kind = "") {
    if (!ui) return;
    ui.notice = kind;
    ui.status.textContent = text;
    updateControlState();
  }
  function isTransientFailure(code) {
    return ["timeout", "network_error", "worker_failed", "disabled"].includes(code) || /^http_5\d\d$/.test(code || "");
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
  function schedule(immediate = false, delay = 120) {
    if (!canRun()) return;
    if (immediate) {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      drain();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; drain(); }, delay);
  }
  function current(candidate, requestEpoch) {
    return requestEpoch === epoch && enabled && !blocked && candidate.element.isConnected
      && source(candidate.element).signature === candidate.snapshot.signature;
  }
  function collectBatch(rects, limit = MAX_BATCH_ITEMS, forceSingle = false) {
    const center = viewHeight / 2;
    const lane = rect => rect.bottom > 0 && rect.top < viewHeight ? 0
      : (scrollDirection > 0 ? rect.top >= viewHeight : rect.bottom <= 0) ? 1 : 2;
    const elements = [...pending].filter(element => rects.has(element) && near(element, rects.get(element)))
      .sort((a, b) => {
        const ar = rects.get(a), br = rects.get(b);
        return lane(ar) - lane(br) || Math.abs((ar.top + ar.bottom) / 2 - center) - Math.abs((br.top + br.bottom) / 2 - center);
      });
    const batch = [];
    let chars = 0, batchLane = null;
    for (const element of elements) {
      if (batch.length >= limit) break;
      const elementLane = lane(rects.get(element));
      if (batch.length && (elementLane !== batchLane || (batchLane === 0 && batch.length >= 2))) break;
      // Keep an in-flight post queued: if its text changes meanwhile, the stale answer
      // is dropped and the new text is requested once the slot frees.
      if (requested.has(element)) continue;
      pending.delete(element);
      // A rescan re-queues it once the expanded text renders or the wait runs out.
      if (holdForExpansion(element)) continue;
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
      batchLane = elementLane;
      chars += snapshot.text.length;
      batch.push({ id: String(++requestSerial), element, snapshot, single: forceSingle });
    }
    for (const element of [...pending]) if (!element.isConnected || !near(element, rects.get(element))) pending.delete(element);
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
      if (attempts < MAX_FAILURES) {
        retry.push({ candidate, record });
        showWaiting(candidate.element, "요청 한도 · 잠시 후 자동 재시도");
      }
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
        if (current(candidate, requestEpoch) && failures.get(candidate.element) === record) {
          if (near(candidate.element)) pending.add(candidate.element);
          else removeResult(candidate.element);
        }
      }
      schedule();
    }, delay);
  }
  // A key rejection blocks the tab, but the provider sometimes rejects a valid key for a moment;
  // one quiet recheck follows, and a later success allows another.
  const AUTH_RECHECK_MS = 30000;
  let authRecheckAvailable = true;
  function blockFor(code) {
    for (const [element, candidate] of owners) {
      if (current(candidate, epoch)) render(element, candidate.snapshot, failure(code), true);
    }
    for (const [element, node] of rendered) {
      if (node.dataset.state === "pending" && element.isConnected) render(element, source(element), failure(code), true);
    }
    blocked = true;
    pending.clear();
    setNotice(failure(code), "error");
    if (!authRecheckAvailable || code === "api_key_missing") return;
    authRecheckAvailable = false;
    const blockedEpoch = epoch;
    setTimeout(() => {
      if (!blocked || blockedEpoch !== epoch) return;
      blocked = false;
      setNotice("", "");
      scan(true);
    }, AUTH_RECHECK_MS);
  }
  function handleTopFailure(candidates, result, requestEpoch) {
    const code = result?.code;
    if (["http_401", "http_402", "http_403", "api_key_missing"].includes(code)) {
      for (const candidate of candidates) if (current(candidate, requestEpoch)) render(candidate.element, candidate.snapshot, failure(code), true);
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
      const retryOnReentry = !isTransientFailure(code) && code !== "text_too_long" && attempts < 2;
      const autoRetryMs = isTransientFailure(code) ? AUTO_RETRY_DELAYS_MS[attempts - 1] : undefined;
      const next = { signature: candidate.snapshot.signature, code, attempts, nextAttemptAt: Infinity, retryOnReentry };
      failures.set(candidate.element, next);
      notice = failure(code, retryOnReentry, autoRetryMs !== undefined);
      render(candidate.element, candidate.snapshot, notice, true);
      if (autoRetryMs !== undefined) {
        setTimeout(() => {
          // Only the same failure of the same text is retried; success, edits, a reset or
          // the user's own retry replace the record first.
          if (failures.get(candidate.element) !== next || !current(candidate, requestEpoch) || !hasApiKey) return;
          next.nextAttemptAt = 0;
          pending.add(candidate.element);
          schedule();
        }, autoRetryMs);
      }
    }
    setNotice(notice || failure(code), "warning");
    return "failed";
  }
  function accept(candidate, text, height) {
    // null means the model found nothing to translate (names, Latin terms): no card.
    if (text === null) removeResult(candidate.element);
    else render(candidate.element, candidate.snapshot, text, false, false, height);
    completed.set(candidate.element, candidate.snapshot.signature);
    failures.delete(candidate.element);
    authRecheckAvailable = true;
    setNotice("", "");
  }
  function handleItem(candidate, item, requestEpoch, height) {
    if (!current(candidate, requestEpoch)) return;
    if (item?.ok && (item.text === null || typeof item.text === "string")) { accept(candidate, item.text, height); if (item.qualityRetry) queueQuality(candidate, item.text, requestEpoch); return; }
    if (item?.code === "invalid_translation" && !candidate.single) {
      // Re-ask alone in its own slot turn, without holding up other groups.
      claim(candidate, requestEpoch);
      fallbacks.push({ candidate, requestEpoch });
      return;
    }
    handleTopFailure([candidate], item || { code: "invalid_translation" }, requestEpoch);
  }
  async function requestGroup(batch) {
    if (batch.length === 1 && batch[0].single) {
      const result = await send({ type: "translation:request", text: batch[0].snapshot.text, priority: visible(batch[0].element) ? 0 : 1 });
      return result?.ok ? { ok: true, items: [{ id: batch[0].id, ok: true, text: result.text, qualityRetry: result.qualityRetry }] } : result;
    }
    return send({ type: "translation:request-batch", priority: batch.some(candidate => visible(candidate.element)) ? 0 : 1, items: batch.map(candidate => ({ id: candidate.id, text: candidate.snapshot.text })) });
  }
  async function runGroup(batch, requestEpoch) {
    const result = await requestGroup(batch);
    batch = batch.filter(candidate => owners.get(candidate.element) === candidate);
    const items = new Map((Array.isArray(result?.items) ? result.items : []).filter(item => item && typeof item.id === "string").map(item => [item.id, item]));
    for (const candidate of batch) release(candidate, requestEpoch);
    if (requestEpoch !== epoch || !enabled) return;
    if (!result?.ok) { handleTopFailure(batch, result || { code: "worker_failed" }, requestEpoch); return; }
    const heights = originalHeights(batch.filter(candidate => current(candidate, requestEpoch) && items.get(candidate.id)?.ok && typeof items.get(candidate.id).text === "string").map(candidate => candidate.element));
    for (const candidate of batch) handleItem(candidate, items.get(candidate.id), requestEpoch, heights.get(candidate.element));
  }
  async function runFallback({ candidate, requestEpoch }) {
    // A batch item the main model answered badly is asked of the sub model first.
    const result = await send({ type: "translation:request", text: candidate.snapshot.text, fallback: true });
    if (owners.get(candidate.element) !== candidate) return;
    release(candidate, requestEpoch);
    if (!current(candidate, requestEpoch)) return;
    if (result?.ok && (result.text === null || typeof result.text === "string")) { accept(candidate, result.text); if (result.qualityRetry) queueQuality(candidate, result.text, requestEpoch); }
    else handleTopFailure([candidate], result || { code: "worker_failed" }, requestEpoch);
  }
  function release(candidate, requestEpoch) {
    if (owners.get(candidate.element) !== candidate) return;
    owners.delete(candidate.element); requested.delete(candidate.element);
    clearTimeout(candidate.watchdog);
    if (requestEpoch === epoch && candidate.element.isConnected && source(candidate.element).signature !== candidate.snapshot.signature) {
      removeResult(candidate.element);
      pending.add(candidate.element);
    }
  }
  function claim(candidate, requestEpoch) {
    owners.set(candidate.element, candidate); requested.add(candidate.element);
    candidate.startedAt ??= Date.now();
    candidate.watchdog = setTimeout(() => {
      if (owners.get(candidate.element) !== candidate) return;
      release(candidate, requestEpoch);
      if (current(candidate, requestEpoch)) handleTopFailure([candidate], { code: "timeout" }, requestEpoch);
      schedule(true);
    }, Math.max(0, WATCHDOG_MS - (Date.now() - candidate.startedAt)));
  }
  const qualityJobs = [];
  function queueQuality(candidate, text, requestEpoch) {
    if (typeof text === "string") qualityJobs.push({ candidate, text, requestEpoch });
  }
  async function runQuality({ candidate, text, requestEpoch }) {
    const result = await send({ type: "translation:quality", text: candidate.snapshot.text, previous: text });
    if (!current(candidate, requestEpoch) || completed.get(candidate.element) !== candidate.snapshot.signature) return;
    if (result?.ok && typeof result.text === "string" && result.text !== text) render(candidate.element, candidate.snapshot, result.text, false, true);
  }
  function drain() {
    if (inFlight >= maxInFlight || !canRun()) return;
    // Snapshot all queued geometry before expansion clicks, result removal or busy
    // indicators can write to the DOM, and reuse it across this drain's slots.
    const rects = new Map();
    for (const element of pending) {
      if (!element.isConnected || requested.has(element)) continue;
      const snapshot = source(element);
      if (completed.get(element) === snapshot.signature || failuresFor(element, snapshot.signature)?.nextAttemptAt > Date.now()) continue;
      rects.set(element, element.getBoundingClientRect());
    }
    while (inFlight < maxInFlight && canRun()) {
      const requestEpoch = epoch;
      let work = null, batch = [];
      if (fastLanePending) { batch = collectBatch(rects, 1, true); fastLanePending = false; }
      if (!batch.length) batch = collectBatch(rects);
      if (batch.length) {
        for (const candidate of batch) { claim(candidate, requestEpoch); showPending(candidate, requestEpoch); }
        work = () => runGroup(batch, requestEpoch);
      }
      while (!work && fallbacks.length) {
        const fallback = fallbacks.shift();
        if (owners.get(fallback.candidate.element) === fallback.candidate && current(fallback.candidate, fallback.requestEpoch) && near(fallback.candidate.element)) {
          batch = [fallback.candidate]; work = () => runFallback(fallback);
        } else {
          const owned = owners.get(fallback.candidate.element) === fallback.candidate;
          release(fallback.candidate, fallback.requestEpoch);
          if (owned && current(fallback.candidate, fallback.requestEpoch)) { removeResult(fallback.candidate.element); pending.add(fallback.candidate.element); }
        }
      }
      while (!work && qualityJobs.length) {
        const job = qualityJobs.shift();
        if (current(job.candidate, job.requestEpoch) && near(job.candidate.element)) work = () => runQuality(job);
      }
      if (!work) break;
      inFlight += 1; running = true; updateControlState();
      // Bound the whole slot too: a dead worker or malformed response must not strand it.
      void new Promise((resolve, reject) => {
        const remaining = batch.length ? Math.min(...batch.map(candidate => Math.max(0, WATCHDOG_MS - (Date.now() - candidate.startedAt)))) : WATCHDOG_MS;
        const timeout = setTimeout(() => reject(new Error("Translation slot timed out")), remaining);
        Promise.resolve().then(work).then(resolve, reject).finally(() => clearTimeout(timeout));
      }).catch(() => {
        for (const candidate of batch) {
          if (owners.get(candidate.element) !== candidate) continue;
          release(candidate, requestEpoch);
          if (current(candidate, requestEpoch)) handleTopFailure([candidate], { code: "worker_failed" }, requestEpoch);
        }
      }).finally(() => {
        inFlight -= 1; running = inFlight > 0; updateControlState(); drain();
      });
    }
  }
  // X mutates the page constantly (timestamps, counters, media, hover cards); only changes that
  // add, remove, or edit tweet text need a rescan.
  const touchesTweetText = node => node.nodeType === 1 && !node.matches(OWN_NODES)
    && (node.matches(SELECTOR) || node.querySelector(SELECTOR) !== null);
  function relevantMutation(record) {
    const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    if (!target || target.closest(OWN_NODES)) return false;
    if (target.closest(SELECTOR)) return true;
    if (record.type !== "childList") return false;
    for (const node of record.addedNodes) if (touchesTweetText(node)) return true;
    for (const node of record.removedNodes) if (touchesTweetText(node)) return true;
    return false;
  }
  function invalidateSource(record) {
    const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    const element = target?.closest(SELECTOR);
    if (element) { snapshots.delete(element); changedTexts.add(element); }
    // Invalidate removed/reinserted subtrees too: X can edit a recycled post
    // while detached, outside the body observer's coverage.
    if (record.type !== "childList") return;
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (node.nodeType !== 1 || node.matches(OWN_NODES)) continue;
      if (node.matches(SELECTOR)) { snapshots.delete(node); changedTexts.add(node); }
      for (const text of node.querySelectorAll(SELECTOR)) { snapshots.delete(text); changedTexts.add(text); }
    }
  }
  const viewportState = new WeakMap();
  const canRun = () => enabled && hasApiKey && !blocked && !document.hidden;
  // While blocked, cards already shown still need scans to drop them from recycled posts.
  const needsScan = () => canRun() || (!document.hidden && rendered.size > 0);
  function scan(immediate = false, changed = null) {
    if (!needsScan()) return;
    for (const element of changed || observed) {
      if (!element.isConnected) {
        intersection?.unobserve(element);
        viewportIntersection?.unobserve(element);
        nearby.delete(element);
        viewportState.delete(element);
        observed.delete(element);
        pending.delete(element);
        failures.delete(element);
        removeResult(element);
      }
    }
    for (const element of changed || document.querySelectorAll(SELECTOR)) {
      if (!element.isConnected) continue;
      if (!observed.has(element)) {
        observed.add(element);
        viewportIntersection?.observe(element);
        intersection?.observe(element);
      }
      const snapshot = source(element);
      const onScreen = visible(element);
      // Recycled text is a new job even if its previous translation failed.
      const record = failures.get(element);
      const owner = owners.get(element);
      const changed = Boolean(owner && owner.snapshot.signature !== snapshot.signature) || Boolean(record && record.signature !== snapshot.signature)
        || (completed.has(element) && completed.get(element) !== snapshot.signature);
      if (changed) {
        completed.delete(element);
        failures.delete(element);
        removeResult(element);
      }
      if (onScreen && !pending.has(element) && !requested.has(element) && completed.get(element) !== snapshot.signature && !failures.has(element)) {
        pending.add(element); fastLanePending = true;
      } else if (near(element)) pending.add(element);
    }
    applyTheme();
    schedule(immediate);
  }
  function reset() {
    epoch += 1;
    fastLanePending = true;
    pending.clear(); requested.clear(); fallbacks.length = 0; qualityJobs.length = 0;
    for (const candidate of owners.values()) clearTimeout(candidate.watchdog);
    owners.clear();
    completed = new WeakMap();
    failures = new WeakMap();
    outsideViewport = new WeakSet();
    for (const element of [...rendered.keys()]) removeResult(element);
  }
  async function refresh() {
    const serial = ++refreshSerial;
    const prefetched = initialSettings;
    initialSettings = null;
    const settings = prefetched ? await prefetched : await send({ type: "translation:settings" });
    if (!settings?.ok || serial !== refreshSerial) return;
    reset();
    enabled = settings.enabled;
    hasApiKey = settings.hasApiKey;
    maxInFlight = Number.isInteger(settings.concurrency) && settings.concurrency > 0 ? Math.min(settings.concurrency, 6) : 2;
    blocked = false;
    ui.toggle.checked = enabled;
    if (settings.modelLabel) ui.model.textContent = settings.modelLabel;
    setNotice(hasApiKey ? "" : `설정에서 ${settings.provider === "neuralwatt" ? "Neuralwatt" : settings.provider === "anthropic" ? "Anthropic" : "OpenRouter"} API 키를 입력하세요`, hasApiKey ? "" : "error");
    if (enabled && hasApiKey) scan(true);
    else updateControlState();
  }
  function mount() {
    viewHeight = globalThis.innerHeight || 0;
    const style = document.createElement("style");
    style.textContent = `
      .lakomics-translation{white-space:pre-wrap;overflow-wrap:anywhere;font:400 .96em/1.7 "Pretendard Variable",Pretendard,"Malgun Gothic","Segoe UI",sans-serif;margin:8px 0 12px;padding:8px 12px 12px;border:0;border-radius:4px;box-sizing:border-box;background:color-mix(in srgb,currentColor 6%,transparent);interpolate-size:allow-keywords;animation:lakomics-translation-in 140ms cubic-bezier(.2,0,0,1) both}
      @keyframes lakomics-translation-in{from{opacity:0;height:0;overflow:hidden}to{opacity:1;height:auto}}
      @media(prefers-reduced-motion:reduce){.lakomics-translation{animation:none}}
      .lakomics-translation[data-theme="light"]{color:#0f1419}
      .lakomics-translation[data-theme="dim"]{color:#f0f2f4}
      .lakomics-translation[data-theme="lights-out"]{color:#e7e9ea}
      .lakomics-translation a{color:rgb(29,155,240);text-decoration:none}
      .lakomics-translation a:hover,.lakomics-translation a:focus-visible{text-decoration:underline}
      .lakomics-translation[data-error="true"]{font-size:12px;padding:4px 8px;background:transparent;opacity:.82}
      .lakomics-translation[data-error="true"][data-theme="light"]{color:#536471}
      .lakomics-translation[data-error="true"]:not([data-theme="light"]){color:#8b98a5}
      .lakomics-translation[data-state="pending"]{font-size:12px;padding:6px 12px;opacity:.7;color:#8b98a5}
      .lakomics-translation[data-state="pending"][data-theme="light"]{color:#536471}
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
    ui.toggle.onchange = async event => {
      if (event?.isTrusted !== true) { ui.toggle.checked = enabled; return; }
      const result = await send({ type: "translation:update", enabled: ui.toggle.checked });
      // A successful write refreshes every tab through storage.onChanged.
      if (!result?.ok) {
        await refresh();
        setNotice("번역 설정 저장 실패", "warning");
      }
    };
    shadow.getElementById("clear").onclick = async event => {
      if (event?.isTrusted !== true) return;
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
      else if (changes[CACHE_CLEARED]) {
        reset();
        if (enabled && hasApiKey && !blocked) scan();
      }
    });
    const onIntersection = entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) { nearby.delete(entry.target); outsideViewport.add(entry.target); continue; }
        nearby.add(entry.target);
        if (!canRun()) continue;
        const record = failures.get(entry.target);
        if (outsideViewport.has(entry.target) && record) {
          if (isTransientFailure(record.code)) failures.delete(entry.target);
          else if (record.retryOnReentry) { record.retryOnReentry = false; record.nextAttemptAt = 0; }
        }
        outsideViewport.delete(entry.target);
        if (visible(entry.target) && !pending.has(entry.target) && !requested.has(entry.target) && !completed.has(entry.target)) fastLanePending = true;
        pending.add(entry.target);
      }
      schedule(false, 0);
    };
    // A separate zero-margin observer reports true viewport re-entry even while a
    // post stays inside the larger prefetch window. Neither callback reads layout.
    viewportIntersection = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const wasOnScreen = viewportState.get(entry.target);
        const onScreen = entry.isIntersecting && entry.intersectionRatio > 0;
        viewportState.set(entry.target, onScreen);
        if (!onScreen || !canRun()) continue;
        const record = failures.get(entry.target);
        if (wasOnScreen === false && record) {
          if (isTransientFailure(record.code)) failures.delete(entry.target);
          else if (record.retryOnReentry) { record.retryOnReentry = false; record.nextAttemptAt = 0; }
        }
        if (!requested.has(entry.target) && !completed.has(entry.target)) fastLanePending = true;
        pending.add(entry.target);
      }
      schedule(false, 0);
    });
    let prefetchDirection;
    function observeWindow() {
      intersection?.disconnect?.();
      // Pixel margins track viewport height; IO percentage margins use viewport width.
      const above = viewHeight * (scrollDirection < 0 ? AHEAD_SCREENS : BEHIND_SCREENS);
      const below = viewHeight * (scrollDirection > 0 ? AHEAD_SCREENS : BEHIND_SCREENS);
      intersection = new IntersectionObserver(onIntersection, { rootMargin: `${above}px 0px ${below}px 0px` });
      for (const element of observed) intersection.observe(element);
      prefetchDirection = scrollDirection;
    }
    observeWindow();
    let scrollTimer = null;
    let scrollFrame = false;
    function onScrollFrame() {
      scrollFrame = false;
      const y = globalThis.scrollY || 0;
      // Measure reversal from the furthest point in the current direction, so
      // small anchoring corrections cannot flip prefetch back and forth. Switch
      // within the existing behind margin, even on a small viewport.
      const movement = (y - scrollExtremeY) * scrollDirection;
      if (movement >= 0) scrollExtremeY = y;
      else if (-movement >= Math.min(96, viewHeight * BEHIND_SCREENS / 2)) {
        scrollDirection *= -1;
        scrollExtremeY = y;
      }
      // A switch needs a sustained reversal, so rebuilding here stays rare.
      if (prefetchDirection !== scrollDirection) observeWindow();
      if (!needsScan()) return;
      if (scrollTimer !== null) return;
      scrollTimer = setTimeout(() => { scrollTimer = null; scan(true); }, 50);
    }
    globalThis.addEventListener("scroll", () => {
      if (scrollFrame) return;
      scrollFrame = true;
      requestAnimationFrame(onScrollFrame);
    }, { passive: true });
    globalThis.addEventListener("resize", () => { viewHeight = globalThis.innerHeight || 0; observeWindow(); scan(); });
    document.addEventListener("visibilitychange", () => {
      if (canRun()) { observeWindow(); scan(true); }
    });
    let scanTimer = null;
    onTextMutations = records => {
      let relevant = false;
      for (const record of records) {
        if (!relevantMutation(record)) continue;
        invalidateSource(record);
        relevant = true;
      }
      if (!needsScan()) { changedTexts.clear(); return; }
      if (!relevant) return;
      if (scanTimer !== null) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        const changed = new Set(changedTexts); changedTexts.clear();
        scan(false, changed);
      }, 200);
    };
    textObserver = new MutationObserver(onTextMutations);
    textObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["lang", "href", "alt"] });
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
