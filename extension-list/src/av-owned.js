(() => {
  "use strict";

  const BADGE = "lakomics-av-owned-badge";
  const SKIP = `script,style,noscript,textarea,input,select,button,[contenteditable]:not([contenteditable="false"]),.${BADGE},.lakomics-av-lookup-chip,.lakomics-list-toasts,#ticker`; // avdbs: the news ticker quotes codes in user comments

  function runtimeRequest(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          resolve(chrome.runtime.lastError ? null : response);
        });
      } catch { resolve(null); }
    });
  }

  function createController({ doc = document, win = window, lookup = globalThis.LakomicsAvLookup,
    avSend = globalThis.LakomicsAvSend, sendMessage = runtimeRequest } = {}) {
    const asked = new Set(), owned = new Set();
    let observer = null, timer = null, stopped = false;

    function textNodes() {
      const nodes = [];
      const walker = doc.createTreeWalker(doc.body || doc.documentElement, win.NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        if (!node.parentElement?.closest(SKIP)) nodes.push(node);
      }
      return nodes;
    }

    function observe() {
      observer?.observe(doc.body || doc.documentElement, { childList: true, subtree: true, characterData: true });
    }

    function mark() {
      observer?.disconnect();
      try {
        for (const badge of doc.querySelectorAll(`.${BADGE}`)) {
          const previous = badge.previousSibling;
          const last = previous?.nodeType === 3 ? lookup.productCodesInText(previous.data).at(-1) : null;
          if (!last || last.end !== previous.data.length || last.code !== badge.dataset.code) badge.remove();
        }
        for (const node of textNodes()) {
          const matches = lookup.productCodesInText(node.data);
          for (const match of matches.reverse()) {
            if (!owned.has(match.code)) continue;
            if (match.end === node.data.length && node.nextSibling?.classList?.contains(BADGE)
                && node.nextSibling.dataset.code === match.code) continue;
            const tail = node.splitText(match.end);
            const badge = doc.createElement("span");
            badge.className = BADGE;
            badge.dataset.code = match.code;
            badge.textContent = "보유";
            tail.before(badge);
          }
        }
        avSend?.injectPageButton?.();
        avSend?.setOwned?.(owned);
      } finally { if (!stopped) observe(); }
    }

    async function scan() {
      if (stopped) return;
      const pending = new Set();
      for (const node of textNodes()) {
        for (const { code } of lookup.productCodesInText(node.data)) {
          if (!asked.has(code)) pending.add(code);
        }
      }
      const codes = [...pending];
      for (const code of codes) asked.add(code);
      mark();
      for (let index = 0; index < codes.length && !stopped; index += 200) {
        const batch = codes.slice(index, index + 200);
        let response;
        try { response = await sendMessage({ type: "av-owned", codes: batch }); } catch { continue; }
        if (stopped) return;
        if (response?.ok && Array.isArray(response.owned)) {
          for (const code of response.owned) if (batch.includes(code)) owned.add(code);
          mark();
        }
      }
    }

    function start() {
      if (observer || stopped) return;
      observer = new win.MutationObserver(() => {
        if (timer !== null) win.clearTimeout(timer);
        timer = win.setTimeout(() => { timer = null; void scan(); }, 300);
      });
      observe();
      return scan();
    }

    return { start, scan, destroy() {
      stopped = true;
      observer?.disconnect();
      if (timer !== null) win.clearTimeout(timer);
    } };
  }

  if (globalThis.__LAKOMICS_TEST__) globalThis.LakomicsAvOwned = { createController };
  else if (["www.javlibrary.com", "www.avdbs.com"].includes(location.hostname)
      && ["http:", "https:"].includes(location.protocol)) {
    const controller = createController();
    globalThis.LakomicsAvOwned = controller;
    void controller.start();
  }
})();
