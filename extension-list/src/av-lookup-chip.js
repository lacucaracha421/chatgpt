(() => {
  "use strict";

  const CHIP_ID = "lakomics-av-lookup-chip";
  const CHIP_WIDTH_FALLBACK = 208;
  const CHIP_HEIGHT = 44;
  const VIEWPORT_GUTTER = 8;

  function isEditableElement(element) {
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      const tagName = String(node.tagName || "").toLowerCase();
      if (tagName === "input" || tagName === "textarea" || node.isContentEditable) return true;
      if (node.hasAttribute?.("contenteditable") && node.getAttribute("contenteditable") !== "false") return true;
    }
    return false;
  }

  function selectionIsEditable(selection, doc) {
    if (isEditableElement(doc?.activeElement)) return true;
    return isEditableElement(selection?.anchorNode?.nodeType === 1 ? selection.anchorNode : selection?.anchorNode?.parentElement)
      || isEditableElement(selection?.focusNode?.nodeType === 1 ? selection.focusNode : selection?.focusNode?.parentElement);
  }

  function selectionRect(selection) {
    if (!selection?.rangeCount) return null;
    try {
      const range = selection.getRangeAt(0);
      return range.getClientRects?.()[0] || range.getBoundingClientRect?.() || null;
    } catch { return null; }
  }

  function createChipController({ doc = globalThis.document, win = globalThis.window, lookup = globalThis.LakomicsAvLookup, sendMessage, avSend = globalThis.LakomicsAvSend } = {}) {
    let chip = null;
    let sendButton = null;
    let hiddenUntilSelectionChange = false;
    let selectedText = "";

    function ensureChip() {
      if (chip?.isConnected) return chip;
      chip = doc.createElement("div");
      chip.id = CHIP_ID;
      chip.className = "lakomics-av-lookup-chip";
      chip.setAttribute("role", "group");
      chip.setAttribute("aria-label", "선택한 AV 코드 작업");
      const lookupButton = doc.createElement("button");
      lookupButton.type = "button";
      lookupButton.textContent = "AV 표지 찾기";
      sendButton = doc.createElement("button");
      sendButton.type = "button";
      sendButton.textContent = "보내기";
      chip.append(lookupButton, sendButton);
      chip.hidden = true;
      chip.addEventListener("pointerdown", event => event.preventDefault());
      lookupButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const text = selectedText;
        hide();
        if (!text) return;
        try { sendMessage?.({ type: "av-lookup", selectionText: text }); } catch {}
      });
      sendButton.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (selectedText) void avSend?.send(selectedText);
      });
      (doc.documentElement || doc.body).append(chip);
      return chip;
    }

    function hide({ suppressSelection = false } = {}) {
      if (suppressSelection) hiddenUntilSelectionChange = true;
      selectedText = "";
      if (chip) chip.hidden = true;
    }

    function update() {
      if (hiddenUntilSelectionChange) return;
      const selection = win.getSelection?.();
      const text = selection?.toString?.() ?? "";
      const code = lookup?.productCodeFromText?.(text) || "";
      const rect = selectionRect(selection);
      if (!selection || selection.isCollapsed || !code || selectionIsEditable(selection, doc) || !rect) {
        hide();
        return;
      }

      const control = ensureChip();
      selectedText = text;
      avSend?.setButton(sendButton, code, "보내기");
      const viewportWidth = Math.max(0, Number(win.innerWidth) || doc.documentElement?.clientWidth || 320);
      const viewportHeight = Math.max(0, Number(win.innerHeight) || doc.documentElement?.clientHeight || 640);
      const width = control.offsetWidth || control.getBoundingClientRect?.().width || CHIP_WIDTH_FALLBACK;
      const height = control.offsetHeight || control.getBoundingClientRect?.().height || CHIP_HEIGHT;
      const left = Number(rect.left) + (Number(rect.width) || 0) / 2 - width / 2;
      const top = Number(rect.bottom) + VIEWPORT_GUTTER;
      control.style.left = `${Math.max(VIEWPORT_GUTTER, Math.min(left, viewportWidth - width - VIEWPORT_GUTTER))}px`;
      control.style.top = `${Math.max(VIEWPORT_GUTTER, Math.min(top, viewportHeight - height - VIEWPORT_GUTTER))}px`;
      control.hidden = false;
    }

    function onSelectionChange() {
      hiddenUntilSelectionChange = false;
      update();
    }
    function onScroll() { hide({ suppressSelection: true }); }
    function onKeyDown(event) { if (event.key === "Escape") hide({ suppressSelection: true }); }

    doc.addEventListener("selectionchange", onSelectionChange, true);
    doc.addEventListener("scroll", onScroll, true);
    doc.addEventListener("keydown", onKeyDown, true);
    update();

    return { chip: ensureChip(), hide, update, destroy() {
      doc.removeEventListener("selectionchange", onSelectionChange, true);
      doc.removeEventListener("scroll", onScroll, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      chip?.remove(); chip = null; selectedText = "";
    } };
  }

  const api = { CHIP_ID, createChipController, isEditableElement, selectionIsEditable };
  if (globalThis.__LAKOMICS_TEST__) globalThis.LakomicsAvLookupChip = api;
  else if (globalThis.LakomicsAvLookup) createChipController({ sendMessage: message => chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; }) });
})();
