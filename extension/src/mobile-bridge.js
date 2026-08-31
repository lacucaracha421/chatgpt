(() => {
  "use strict";

  const PAGE_ORIGIN = "https://lacucaracha421.github.io";
  const PAGE_PATH_PREFIX = "/chatgpt/";
  const STATE_KEY = "lakomics.mobile.live-classification-tree.v1";

  if (location.origin !== PAGE_ORIGIN || !location.pathname.startsWith(PAGE_PATH_PREFIX)) {
    return;
  }

  let liveEntries = [];
  let nodeById = new Map();
  let childrenByParent = new Map();
  let selectedId = null;
  let expandedIds = new Set();
  let loadGeneration = 0;

  function cleanString(value, maxLength = 200) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  }

  function normalizeEntry(value) {
    if (!value || typeof value !== "object") return null;
    const id = cleanString(value.id, 240);
    const name = cleanString(value.name, 120);
    if (!id || !name) return null;
    const parentId = cleanString(value.parentId ?? value.parent_id, 240) || null;
    const kind = cleanString(value.kind, 40) || "tag";
    const numericCount = Number(value.count ?? value.assetCount ?? value.asset_count);
    return {
      id,
      name,
      parentId,
      kind,
      count: Number.isFinite(numericCount) && numericCount >= 0 ? Math.round(numericCount) : null,
    };
  }

  function loadSavedState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
      return {
        selectedId: cleanString(parsed.selectedId, 240) || null,
        expandedIds: Array.isArray(parsed.expandedIds)
          ? parsed.expandedIds.map((id) => cleanString(id, 240)).filter(Boolean)
          : [],
        scrollTop: Number.isFinite(Number(parsed.scrollTop)) ? Number(parsed.scrollTop) : 0,
      };
    } catch {
      return { selectedId: null, expandedIds: [], scrollTop: 0 };
    }
  }

  function saveState() {
    const scroll = document.querySelector("#treeScroll");
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        selectedId,
        expandedIds: [...expandedIds],
        scrollTop: scroll?.scrollTop || 0,
      }));
    } catch {
      // Persistence is a convenience only. The live tree must still work if
      // site storage is disabled.
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve({ ok: false, code: "extension_message_failed", detail: error.message });
            return;
          }
          resolve(response && typeof response === "object"
            ? response
            : { ok: false, code: "extension_empty_response" });
        });
      } catch (error) {
        resolve({
          ok: false,
          code: "extension_message_failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  function rebuildIndex(entries) {
    liveEntries = entries;
    nodeById = new Map(entries.map((entry) => [entry.id, entry]));
    childrenByParent = new Map();

    for (const entry of entries) {
      const parentId = entry.parentId && nodeById.has(entry.parentId)
        ? entry.parentId
        : null;
      const siblings = childrenByParent.get(parentId) || [];
      siblings.push(entry);
      childrenByParent.set(parentId, siblings);
    }
  }

  function roots() {
    return childrenByParent.get(null) || [];
  }

  function childrenOf(id) {
    return childrenByParent.get(id) || [];
  }

  function pathTo(id) {
    const result = [];
    const seen = new Set();
    let current = nodeById.get(id) || null;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      result.unshift(current);
      current = current.parentId ? nodeById.get(current.parentId) || null : null;
    }
    return result;
  }

  function expandAncestors(id) {
    const path = pathTo(id);
    for (const entry of path.slice(0, -1)) {
      if (childrenOf(entry.id).length) expandedIds.add(entry.id);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function rowHtml(entry, depth, visiting) {
    if (visiting.has(entry.id)) return "";
    const nextVisiting = new Set(visiting);
    nextVisiting.add(entry.id);
    const children = childrenOf(entry.id);
    const hasChildren = children.length > 0;
    const expanded = hasChildren && expandedIds.has(entry.id);
    const selected = selectedId === entry.id;
    const count = entry.count === null ? "" : entry.count.toLocaleString();

    return `<div class="tree-node ${expanded ? "expanded " : ""}${hasChildren ? "" : "leaf "}" data-live-node="${escapeHtml(entry.id)}">
      <button class="tree-row ${selected ? "selected" : ""}" style="--depth:${Math.min(depth, 12)}" data-lakomics-live-select="${escapeHtml(entry.id)}">
        <span class="tree-toggle" ${hasChildren ? `data-lakomics-live-toggle="${escapeHtml(entry.id)}"` : ""}>
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor"><path d="m4 2 4 4-4 4"/></svg>
        </span>
        <span class="tree-name">${escapeHtml(entry.name)}</span>
        <span class="tree-count">${count}</span>
      </button>
      ${hasChildren ? `<div class="tree-children">${children.map((child) => rowHtml(child, depth + 1, nextVisiting)).join("")}</div>` : ""}
    </div>`;
  }

  function renderTree({ restoreScroll = false } = {}) {
    const scroll = document.querySelector("#treeScroll");
    if (!scroll || !liveEntries.length) return;

    const previousScrollTop = scroll.scrollTop;
    const rootEntries = roots();
    scroll.innerHTML = rootEntries.map((entry) => rowHtml(entry, 0, new Set())).join("");

    const saved = loadSavedState();
    scroll.scrollTop = restoreScroll ? saved.scrollTop : previousScrollTop;
    updateSelectedPath();
  }

  function updateSelectedPath() {
    if (!selectedId) return;
    const path = pathTo(selectedId);
    if (!path.length) return;

    const pathElement = document.querySelector("#assetPath");
    if (pathElement) {
      pathElement.textContent = "";
      path.forEach((entry, index) => {
        if (index) pathElement.append(document.createTextNode("  ›  "));
        if (index === path.length - 1) {
          const strong = document.createElement("strong");
          strong.textContent = entry.name;
          pathElement.append(strong);
        } else {
          pathElement.append(document.createTextNode(entry.name));
        }
      });
    }

    const totalElement = document.querySelector("#assetTotal");
    const selected = nodeById.get(selectedId);
    if (totalElement) {
      totalElement.textContent = selected?.count === null || selected?.count === undefined
        ? "에셋 연결 전"
        : `${selected.count.toLocaleString()}개`;
    }
  }

  function setConnectionUi(response, entries) {
    const label = document.querySelector(".sync-state span:last-child");
    const dot = document.querySelector(".sync-state .dot");
    const banner = document.querySelector(".prototype-banner");
    const sidebarCount = document.querySelector(".asset-sidebar-count");

    if (label) {
      label.textContent = response.classificationSource === "cloud-cache"
        ? "분류 캐시"
        : "분류 연결됨";
    }
    if (dot) dot.style.background = "var(--good)";
    if (sidebarCount) sidebarCount.textContent = String(entries.length);
    if (banner) banner.textContent = "Galaxy Tab S11용 Mobile prototype · 분류는 실제 Lakomics 데이터, 에셋/컬렉션은 아직 데모입니다.";
    document.documentElement.dataset.lakomicsLiveClassifications = "connected";
  }

  function setFailureUi(response) {
    const label = document.querySelector(".sync-state span:last-child");
    const dot = document.querySelector(".sync-state .dot");
    const banner = document.querySelector(".prototype-banner");
    if (label) label.textContent = "확장 연결 필요";
    if (dot) dot.style.background = "#d7a36e";
    if (banner) {
      banner.textContent = `분류 실데이터 연결 실패 (${cleanString(response?.code, 60) || "unknown"}) · 현재 데모 분류를 표시합니다.`;
    }
    document.documentElement.dataset.lakomicsLiveClassifications = "failed";
  }

  async function loadClassifications(force = false) {
    const generation = ++loadGeneration;
    const response = await sendRuntimeMessage({
      type: force ? "classifications:refresh" : "classifications:get",
    });
    if (generation !== loadGeneration) return;

    const entries = Array.isArray(response?.entries)
      ? response.entries.map(normalizeEntry).filter(Boolean)
      : [];
    if (!response?.ok || !entries.length) {
      setFailureUi(response);
      return;
    }

    rebuildIndex(entries);
    const saved = loadSavedState();
    expandedIds = new Set(saved.expandedIds.filter((id) => nodeById.has(id)));
    selectedId = saved.selectedId && nodeById.has(saved.selectedId)
      ? saved.selectedId
      : roots()[0]?.id || entries[0].id;
    expandAncestors(selectedId);
    setConnectionUi(response, entries);
    renderTree({ restoreScroll: true });
    saveState();
  }

  function handleTreePointer(event) {
    const toggle = event.target.closest?.("[data-lakomics-live-toggle]");
    const row = event.target.closest?.("[data-lakomics-live-select]");
    if (!toggle && !row) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (toggle) {
      const id = toggle.dataset.lakomicsLiveToggle;
      if (expandedIds.has(id)) expandedIds.delete(id);
      else expandedIds.add(id);
      saveState();
      renderTree();
      return;
    }

    const id = row.dataset.lakomicsLiveSelect;
    if (!nodeById.has(id)) return;
    selectedId = id;
    expandAncestors(id);
    saveState();
    renderTree();

    if (matchMedia("(max-width:999px), (orientation:portrait)").matches) {
      document.querySelector("#app")?.classList.remove("assets-sidebar-open");
    }
  }

  function installDomHooks() {
    const scroll = document.querySelector("#treeScroll");
    if (!scroll) {
      setTimeout(installDomHooks, 100);
      return;
    }

    scroll.addEventListener("click", handleTreePointer, true);
    scroll.addEventListener("scroll", () => saveState(), { passive: true });
    document.querySelector("#refreshBtn")?.addEventListener("click", () => loadClassifications(true));
    loadClassifications(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installDomHooks, { once: true });
  } else {
    installDomHooks();
  }
})();
