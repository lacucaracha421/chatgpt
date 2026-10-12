(() => {
  "use strict";
  const SETTINGS = "lakomics:context-menu:v1";
  const ownSelector = "lakomics-menu, lakomics-toast, lakomics-translation-block, lakomics-translation-note, lakomics-image-popover, lakomics-page-status, #lakomics-arc-collector, #lakomics-yt-button, #lakomics-yt-overlay, #lakomics-yt-toast, #ytsf-button";
  function hosts(value) {
    return [...new Set((Array.isArray(value) ? value : String(value || "").split(/\r?\n/))
      .map(host => String(host).trim().toLowerCase().replace(/\.$/, ""))
      .filter(host => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host)))];
  }
  function settings(value) { return { enabled: value?.enabled !== false, excludedHosts: hosts(value?.excludedHosts), pageMode: value?.pageMode === "below" ? "below" : "replace" }; }
  function excluded(host, list) { host = host.toLowerCase().replace(/\.$/, ""); return list.some(item => host === item || host.endsWith("." + item)); }
  function topHostname(win) {
    try { return win.top.location.hostname; } catch {}
    const origins = win.location.ancestorOrigins;
    try { return new URL(origins?.[origins.length - 1]).hostname; } catch { return win.location.hostname; }
  }
  function mediaAt(target) {
    const direct = target?.closest?.("video, audio");
    if (direct) return direct;
    // Only a nearby player container, never a document-wide media search.
    for (let node = target, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      if (node.matches?.('.video-js, .plyr, [class*="player" i], [data-testid="videoPlayer"]')) {
        const media = node.querySelectorAll("video, audio");
        if (media.length <= 8) {
          const origin = target.getBoundingClientRect();
          const x = origin.left + origin.width / 2, y = origin.top + origin.height / 2;
          const distance = element => { const rect = element.getBoundingClientRect(); return Math.max(rect.left - x, 0, x - rect.right) ** 2 + Math.max(rect.top - y, 0, y - rect.bottom) ** 2; };
          return [...media].sort((a, b) => distance(a) - distance(b))[0] || null;
        }
        return null;
      }
    }
    return null;
  }
  function mediaUrl(media) {
    // currentSrc is authoritative: a MediaSource/blob player may still carry an
    // unrelated <source> fallback that does not describe the playing stream.
    if (media?.srcObject) return "";
    const value = media?.currentSrc || media?.src || media?.querySelector?.("source[src]")?.src || "";
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : ""; } catch { return ""; }
  }
  function bypass(event, { enabled = true, excludedHosts = [], hostname = "", phase = "idle", picker = false } = {}) {
    return event.isTrusted !== true || event.defaultPrevented || (event.shiftKey && event.key !== "F10") || !enabled || excluded(hostname, excludedHosts)
      || phase !== "idle" || picker || event.composedPath?.().some(node => node?.matches?.(ownSelector)) || Boolean(event.target?.closest?.(ownSelector));
  }
  function sourceLanguage(text) {
    const letters = [...text].filter(char => /\p{Letter}/u.test(char));
    if (!letters.length) return "en";
    if (letters.filter(char => /[\uac00-\ud7a3\u1100-\u11ff]/.test(char)).length / letters.length > .3) return "ko";
    if (letters.filter(char => /[\u3040-\u30ff\u3400-\u9fff]/.test(char)).length / letters.length > .3) return "ja";
    return "en";
  }
  function quote(text) {
    const clean = text.replace(/\s+/g, " ").trim();
    const segments = typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean)].map(item => item.segment) : [...clean];
    return segments.slice(0, 40).join("") + (segments.length > 40 ? "…" : "");
  }
  function editable(target) {
    let field = target?.closest?.('input, textarea, [contenteditable]');
    if (!field) return null;
    if (field.matches('input') && !/^(?:text|search|url|tel|email|password)$/i.test(field.type)) return null;
    if (field.hasAttribute("contenteditable") && field.getAttribute("contenteditable") === "false") return null;
    if (field.hasAttribute("contenteditable")) {
      // The editing host can be an ancestor of nested markup carrying the same
      // attribute. Keep selection and input events on the outer editing host.
      while (field.parentElement?.isContentEditable) field = field.parentElement;
    }
    return field;
  }
  function blockAt(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element?.closest?.("p, li, blockquote, dd, td, h1, h2, h3, h4, h5, h6, div") || element;
  }
  function selectionEnd(range) {
    let node = range?.endContainer;
    if (node?.nodeType === 1 && range.endOffset > 0) {
      node = node.childNodes[Math.min(range.endOffset, node.childNodes.length) - 1] || node;
      while (node.lastChild) node = node.lastChild;
    }
    return node;
  }
  function snapshot(target, doc = document, win = window, candidateFor = () => null) {
    const field = editable(target), selection = win.getSelection?.();
    let range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const input = field?.matches("input, textarea") && typeof field.selectionStart === "number";
    const start = input ? field.selectionStart : null, end = input ? field.selectionEnd : null;
    let text = input ? field.value.slice(start, end) : selection?.toString() || "";
    if (field && !input && (!range || !field.contains(range.startContainer) || !field.contains(range.endContainer))) {
      // A selection elsewhere on the page must never become an editable-field
      // cut/paste target. With no field caret, paste at the end of that field.
      range = doc.createRange(); range.selectNodeContents(field); range.collapse(false); text = "";
    }
    const media = mediaAt(target);
    const picture = target?.closest?.("img, picture");
    const image = picture?.matches("picture") ? picture.querySelector("img") : picture;
    const imageUrl = image?.currentSrc || image?.src || "";
    const link = target?.closest?.("a[href]");
    return { target, field, readonly: Boolean(field?.readOnly || field?.disabled), password: field?.type === "password", input,
      start, end, direction: input ? field.selectionDirection : null, fieldValue: input ? field.value : null,
      fieldContent: !input && field ? field.innerHTML : null,
      text, range, activeElement: doc.activeElement,
      block: blockAt(selectionEnd(range) || target), image: imageUrl ? image : null, imageUrl,
      media, mediaType: media?.tagName?.toLowerCase() || "", mediaUrl: mediaUrl(media), posterUrl: media?.poster || "",
      linkUrl: link?.href || "", candidate: imageUrl ? candidateFor(target) : null };
  }
  function restore(context, doc = document, win = window, focus = true) {
    try {
      if (focus && context.activeElement?.isConnected) context.activeElement.focus({ preventScroll: true });
      if (context.input && context.field?.isConnected) context.field.setSelectionRange(context.start, context.end, context.direction);
      else if (context.range && context.range.startContainer.isConnected && context.range.endContainer.isConnected) {
        const selection = win.getSelection(); selection.removeAllRanges(); selection.addRange(context.range);
      }
    } catch {}
  }
  function items(context, availability = {}, lookup = globalThis.LakomicsAvLookup) {
    const groups = [], selection = [], translation = [], av = [], edit = [], imageActions = [], mediaActions = [], links = [], imageBrowser = [], page = [];
    const add = (group, id, label, icon, extra = {}) => group.push({ id, label, icon, ...extra });
    const translate = (id, label, glyph) => add(translation, id, label, glyph, { setup: !(availability.hasContextApiKey ?? availability.hasApiKey) });
    if (context.text) {
      if (!context.field) add(selection, "edit.copy", "복사", "copy", { hint: "Ctrl+C" });
      if (!context.password && context.text.trim()) {
        const language = sourceLanguage(context.text);
        if (context.field && !context.readonly) {
          for (const [code, label, glyph] of [["ja", "일본어", "あ"], ["en", "영어", "A"], ["ko", "한국어", "가"]]) {
            if (code !== language) translate("replace." + code, label + "로 바꾸기", glyph);
          }
        } else if (!context.field && language !== "ko") translate("translate.ko.inline", "한국어로 번역", "가");
        translate("translate.ja.copy", "일본어로 번역해서 복사", "あ");
        translate("translate.en.copy", "영어로 번역해서 복사", "A");
        const request = lookup?.createSendRequest(context.text, availability.href);
        if (request) add(av, "av.send", "표지 찾기:", "film", { quote: request.productCode });
      }
    }
    if (context.field) {
      if (context.text && !context.readonly) add(edit, "edit.cut", "잘라내기", "cut", { hint: "Ctrl+X" });
      if (context.text) add(edit, "edit.copy", "복사", "copy", { hint: "Ctrl+C" });
      if (!context.readonly) add(edit, "edit.paste", "붙여넣기", "clipboard", { hint: "Ctrl+V" });
      add(edit, "edit.selectAll", "모두 선택", "select", { hint: "Ctrl+A" });
    }
    if (context.imageUrl) {
      add(imageActions, "image.translate", "이미지 글자 번역", "translate", { setup: !(availability.hasImageApiKey ?? availability.hasApiKey), disabled: context.imageUrl.startsWith("http:"), hint: context.imageUrl.startsWith("http:") ? "HTTPS 이미지 필요" : undefined });
      if (context.candidate) add(imageActions, "image.lakomics", "Lakomics에 저장…", "archive", { disabled: context.candidate.mediaUrl?.startsWith("http:"), hint: context.candidate.mediaUrl?.startsWith("http:") ? "HTTPS 원본 필요" : undefined });
      add(imageBrowser, "image.save", "이미지 저장", "download");
      add(imageBrowser, "image.saveAs", "다른 이름으로 저장", "download");
      add(imageBrowser, "image.copyUrl", "이미지 주소 복사", "image");
      add(imageBrowser, "image.openTab", "새 탭에서 이미지 열기", "open");
    }
    if (context.linkUrl) {
      add(links, "link.openTab", "새 탭에서 열기", "open");
      add(links, "link.copy", "링크 주소 복사", "link");
      add(links, "link.saveAs", "링크를 다른 이름으로 저장", "download");
    }
    if (context.mediaType) {
      if (context.mediaUrl) add(mediaActions, "media.copyUrl", context.mediaType === "video" ? "영상 주소 복사" : "오디오 주소 복사", "link");
      if (context.mediaType === "video") {
        if (context.posterUrl) add(mediaActions, "media.poster", "포스터 저장", "download");
        add(mediaActions, "media.frame.save", "현재 장면을 이미지로 저장", "download");
        add(mediaActions, "media.frame.lakomics", "현재 장면을 Lakomics에 저장…", "archive");
      }
    }
    if (!context.text && !context.field && !context.imageUrl && !context.linkUrl && !context.mediaType) {
      // While a page translation exists the item toggles it: hide, then show again.
      const pageLabel = { on: "번역 숨기기", hidden: "번역 보기" }[availability.pageState] || "페이지 본문 번역";
      add(page, "page.translate", pageLabel, "translate", { setup: !availability.pageState && !(availability.hasContextApiKey ?? availability.hasApiKey) });
      groups.push(page);
      const browser = [];
      if (!availability.inFrame) add(browser, "page.saveAs", "다른 이름으로 페이지 저장", "download");
      add(browser, "nav.back", "뒤로", "back", { hint: "Alt+←", disabled: !availability.canGoBack });
      add(browser, "nav.forward", "앞으로", "forward", { hint: "Alt+→", disabled: !availability.canGoForward });
      add(browser, "nav.reload", "새로고침", "reload", { hint: "Ctrl+R" });
      groups.push(browser);
    } else groups.push(translation, av, selection, edit, imageActions, mediaActions, links, imageBrowser);
    const clipboard = availability.clipboard !== false;
    return groups.map(group => group.filter(item => clipboard || !["edit.copy", "edit.cut", "edit.paste", "image.copyUrl", "link.copy", "media.copyUrl"].includes(item.id)))
      .filter(group => group.length).flatMap((group, index) => index ? [{ separator: true }, ...group] : group);
  }
  function placement(x, y, width, height, viewport, offset = 2) {
    const left = viewport.offsetLeft || 0, top = viewport.offsetTop || 0;
    const right = left + viewport.width, bottom = top + viewport.height;
    const flipX = x + offset + width > right - 8, flipY = y + offset + height > bottom - 8;
    return { x: Math.max(left + 8, Math.min(flipX ? x - width - offset : x + offset, right - width - 8)),
      y: Math.max(top + 8, Math.min(flipY ? y - height - offset : y + offset, bottom - height - 8)), flipX, flipY };
  }
  // The image text popover sits right of the image, else left, else inside its lower edge.
  function imagePlacement(rect, size, viewport, gap = 8, touch = false) {
    const left = viewport.offsetLeft || 0, top = viewport.offsetTop || 0, right = left + viewport.width, bottom = top + viewport.height;
    const insetY = touch ? 12 : 8;
    const width = Math.min(size.width, viewport.width - 16), height = Math.min(size.height, viewport.height - insetY * 2);
    const clampY = y => Math.max(top + insetY, Math.min(y, bottom - height - insetY));
    if (touch) {
      const inset = 12, edge = 24;
      const clampX = x => Math.max(left + edge, Math.min(x, right - width - edge));
      if (rect.right + gap + width <= right - inset) return { side: "right", x: rect.right + gap, y: clampY(rect.top), width };
      if (rect.left - gap - width >= left + inset) return { side: "left", x: rect.left - gap - width, y: clampY(rect.top), width };
      if (rect.bottom + gap + height <= bottom - inset) return { side: "below", x: clampX(rect.left), y: rect.bottom + gap, width };
      return { side: "inside", x: clampX(rect.left + inset), y: clampY(rect.bottom - inset - height), width };
    }
    if (rect.right + gap + width <= right - 8) return { side: "right", x: rect.right + gap, y: clampY(rect.top), width };
    if (rect.left - gap - width >= left + 8) return { side: "left", x: rect.left - gap - width, y: clampY(rect.top), width };
    const inside = Math.max(160, Math.min(width, rect.width - 16));
    return { side: "inside", x: Math.max(left + 8, Math.min(rect.left + 8, right - inside - 8)), y: clampY(rect.bottom - gap - height), width: inside };
  }
  function nextIndex(key, current, count) {
    if (!count) return -1;
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    if (key === "ArrowDown") return (current + 1) % count;
    if (key === "ArrowUp") return current < 0 ? count - 1 : (current + count - 1) % count;
    return current;
  }
  globalThis.LakomicsContextModel = { SETTINGS, ownSelector, hosts, settings, excluded, topHostname, mediaAt, mediaUrl, bypass, sourceLanguage, quote, editable, snapshot, restore, items, placement, imagePlacement, nextIndex };
})();
