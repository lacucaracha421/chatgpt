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
    const codeNodes = new Map(), nodeCodes = new WeakMap();
    const dirtyRoots = new Set(), dirtyBadges = new Set();
    let observer = null, timer = null, stopped = false;

    function textNodes(root) {
      const nodes = [];
      if ((root.nodeType === 1 ? root : root.parentElement)?.closest(SKIP)) return nodes;
      if (root.nodeType === 3) return [root];
      const filter = win.NodeFilter;
      const walker = doc.createTreeWalker(root, filter.SHOW_ELEMENT | filter.SHOW_TEXT, {
        acceptNode: node => node.nodeType === 1
          ? (node.matches(SKIP) ? filter.FILTER_REJECT : filter.FILTER_SKIP) : filter.FILTER_ACCEPT,
      });
      for (let node; (node = walker.nextNode());) nodes.push(node);
      return nodes;
    }

    function forget(node) {
      for (const code of nodeCodes.get(node) || []) {
        const nodes = codeNodes.get(code);
        nodes?.delete(node);
        if (!nodes?.size) codeNodes.delete(code);
      }
      nodeCodes.delete(node);
    }

    function indexNode(node) {
      forget(node);
      const matches = lookup.productCodesInText(node.data);
      const codes = new Set(matches.map(match => match.code));
      nodeCodes.set(node, codes);
      for (const code of codes) {
        if (!codeNodes.has(code)) codeNodes.set(code, new Set());
        codeNodes.get(code).add(node);
      }
      return matches;
    }

    function collectRecords(records) {
      for (const record of records) {
        if (record.type === "characterData") {
          dirtyRoots.add(record.target);
          if (record.target.nextSibling?.classList?.contains(BADGE)) dirtyBadges.add(record.target.nextSibling);
        } else {
          for (const node of record.addedNodes) dirtyRoots.add(node);
          for (const node of record.removedNodes) {
            if (node.nodeType === 3) forget(node);
            else {
              // Removed branches may have moved into a skipped subtree.
              const walker = doc.createTreeWalker(node, win.NodeFilter.SHOW_TEXT);
              for (let text; (text = walker.nextNode());) forget(text);
            }
          }
          if (record.nextSibling?.classList?.contains(BADGE)) dirtyBadges.add(record.nextSibling);
        }
      }
      if (records.length && !stopped) {
        if (timer !== null) win.clearTimeout(timer);
        timer = win.setTimeout(() => { timer = null; void scan([...dirtyRoots]); }, 300);
      }
    }

    function observe() {
      observer?.observe(doc.body || doc.documentElement, { childList: true, subtree: true, characterData: true });
    }

    function mark(nodes) {
      collectRecords(observer?.takeRecords() || []);
      observer?.disconnect();
      try {
        for (const node of nodes) {
          if (!node.isConnected || node.parentElement?.closest(SKIP)) continue;
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
            indexNode(tail);
          }
          indexNode(node);
        }
        avSend?.injectPageButton?.();
        avSend?.setOwned?.(owned);
      } finally { if (!stopped) observe(); }
    }

    async function scan(roots = [doc.body || doc.documentElement]) {
      if (stopped) return;
      collectRecords(observer?.takeRecords() || []);
      roots = [...new Set([...roots, ...dirtyRoots])];
      dirtyRoots.clear();
      // A newly added branch can contain other records from the same batch.
      const rootSet = new Set(roots);
      roots = roots.filter(root => {
        for (let parent = root.parentNode; parent; parent = parent.parentNode) if (rootSet.has(parent)) return false;
        return true;
      });
      const badges = new Set(dirtyBadges);
      dirtyBadges.clear();
      for (const root of roots) {
        if (root.nodeType === 1) {
          if (root.matches(`.${BADGE}`)) badges.add(root);
          for (const badge of root.querySelectorAll(`.${BADGE}`)) badges.add(badge);
        }
      }
      const pending = new Set(), toMark = new Set(), nodes = new Set();
      for (const root of roots) if (root.isConnected) for (const node of textNodes(root)) nodes.add(node);
      for (const node of nodes) {
        for (const { code } of indexNode(node)) {
          if (!asked.has(code)) pending.add(code);
          if (owned.has(code)) toMark.add(node);
        }
      }
      // Validate only badges next to changed text or inside changed branches.
      collectRecords(observer?.takeRecords() || []);
      observer?.disconnect();
      try {
        for (const badge of badges) {
          const previous = badge.previousSibling;
          const last = previous?.nodeType === 3 ? lookup.productCodesInText(previous.data).at(-1) : null;
          if (!last || last.end !== previous.data.length || last.code !== badge.dataset.code) badge.remove();
        }
        if (!toMark.size) {
          avSend?.injectPageButton?.();
          avSend?.setOwned?.(owned);
        }
      } finally { if (!stopped) observe(); }
      const codes = [...pending];
      for (const code of codes) asked.add(code);
      if (toMark.size) mark(toMark);
      for (let index = 0; index < codes.length && !stopped; index += 200) {
        const batch = codes.slice(index, index + 200);
        let response;
        try { response = await sendMessage({ type: "av-owned", codes: batch }); } catch { continue; }
        if (stopped) return;
        if (response?.ok && Array.isArray(response.owned)) {
          const newNodes = new Set();
          let changed = false;
          for (const code of response.owned) if (batch.includes(code) && !owned.has(code)) {
            owned.add(code); changed = true;
            for (const node of codeNodes.get(code) || []) newNodes.add(node);
          }
          if (changed) mark(newNodes);
        }
      }
    }

    function start() {
      if (observer || stopped) return;
      observer = new win.MutationObserver(records => {
        collectRecords(records);
      });
      observe();
      return scan();
    }

    return { start, scan, destroy() {
      stopped = true;
      observer?.disconnect();
      codeNodes.clear(); dirtyRoots.clear(); dirtyBadges.clear();
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
