(() => {
  "use strict";
  function runtime(message) {
    return new Promise(resolve => {
      let timer = setTimeout(() => finish({ ok: false, code: "worker_timeout" }), 45000);
      function finish(result) { if (timer === null) return; clearTimeout(timer); timer = null; resolve(result || { ok: false, code: "worker_failed" }); }
      try { chrome.runtime.sendMessage(message, result => finish(chrome.runtime.lastError ? { ok: false, code: "worker_failed" } : result)); }
      catch { finish({ ok: false, code: "worker_failed" }); }
    });
  }
  function unchanged(context) {
    if (!context.field?.isConnected || context.field.readOnly || context.field.disabled) return false;
    if (context.input) return context.field.value === context.fieldValue;
    return Boolean(context.field.innerHTML === context.fieldContent && context.range?.startContainer.isConnected && context.range?.endContainer.isConnected && context.field.contains(context.range.startContainer) && context.field.contains(context.range.endContainer) && context.range.toString() === context.text);
  }
  function replace(context, text, doc = document, win = window) {
    if (!unchanged(context)) return false;
    context.field.focus({ preventScroll: true }); globalThis.LakomicsContextModel.restore(context, doc, win, false);
    let emitted = false;
    const observe = () => { emitted = true; };
    context.field.addEventListener("input", observe);
    let inserted = false;
    try { inserted = doc.execCommand?.("insertText", false, text) === true; }
    catch {} finally { context.field.removeEventListener("input", observe); }
    if (!inserted) {
      if (context.input) context.field.setRangeText(text, context.start, context.end, "end");
      else { const range = context.range; range.deleteContents(); const node = doc.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true); const selection = win.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
    }
    if (!emitted) context.field.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: text ? "insertText" : "deleteContentBackward", data: text || null }));
    return true;
  }
  function selectAll(context, doc = document, win = window) {
    context.field.focus({ preventScroll: true });
    if (context.input) { context.field.select(); return; }
    const range = doc.createRange(); range.selectNodeContents(context.field); const selection = win.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  function captureFrame(media, doc) {
    if (media?.mediaKeys) throw new Error("보호된 영상(DRM)의 장면은 저장할 수 없어요");
    if (!media?.videoWidth || !media?.videoHeight || media.readyState < 2) throw new Error("영상이 준비된 뒤 다시 시도해 주세요");
    const canvas = doc.createElement("canvas"); canvas.width = media.videoWidth; canvas.height = media.videoHeight;
    try {
      const drawing = canvas.getContext("2d");
      if (!drawing) throw new Error("canvas unavailable");
      drawing.drawImage(media, 0, 0);
      const url = canvas.toDataURL("image/png");
      if (!url.startsWith("data:image/png;base64,")) throw new Error("empty frame");
      return url;
    } catch (error) {
      throw new Error(error.name === "SecurityError" ? "영상 제공 사이트의 보안 제한(CORS)으로 현재 장면을 저장할 수 없어요" : "브라우저가 영상 장면을 읽을 수 없어요 · 보호된 영상인지 확인해 주세요");
    }
  }
  function createActions({ doc = document, win = window, send = runtime, surfaces, collector = {}, alive = () => true, watchSession, settings = () => ({}) } = {}) {
    const model = globalThis.LakomicsContextModel;
    // Both own long-lived surfaces (the image popover, the page translation) and their own navigation watchers.
    const image = globalThis.LakomicsContextImage?.create({ doc, win, send, surfaces, collector, alive, watchSession });
    const page = globalThis.LakomicsContextPage?.create({ doc, win, send, surfaces, collector, settings, watchSession });
    function notice(label, context, origin, options) { const toast = surfaces.toast(origin, context.target); toast.show(label, options); return toast; }
    function copy(text, context, origin) {
      // Invoke synchronously in the trusted click/key handler, before any await.
      let promise;
      try { promise = win.navigator.clipboard.writeText(text); } catch (error) { promise = Promise.reject(error); }
      return promise.then(() => { if (alive(context)) notice("복사됨", context, origin, { preview: text }); });
    }
    async function translate(id, context, origin, event) {
      if (!context.text || context.text.length > 12000 || context.password) { notice("선택한 글은 12,000자까지 번역할 수 있어요", context, origin, { error: true }); return; }
      const inline = id === "translate.ko.inline", replacing = id.startsWith("replace.");
      const card = inline && context.block?.isConnected ? surfaces.inline(context.block) : null;
      if (inline && !card) return;
      const current = card?.begin?.() || (() => true);
      let toast = null;
      const retry = nextEvent => { if (nextEvent.isTrusted === true && alive(context)) void activate(id, context, origin, nextEvent); };
      const result = await globalThis.LakomicsContextSurfaces.delayed(() => send({ type: "translation:context", kind: id, text: context.text }), () => {
        if (!alive(context) || !current()) return;
        if (card) card.show("", { pending: true });
        else { toast = surfaces.toast(origin, context.target); toast.show("번역 중", { pending: true }); }
      }, { win });
      if (!alive(context) || !current()) { toast?.close(0); return; }
      if (!result?.ok || typeof result.text !== "string" || !result.text.trim()) {
        if (card) card.show("", { error: true, retry });
        else { toast ||= surfaces.toast(origin, context.target); toast.show("번역 실패", { error: true, retry }); }
        return;
      }
      if (inline) { card.show(result.text); return; }
      if (replacing) {
        toast?.close(0);
        if (!replace(context, result.text, doc, win)) notice("입력 내용이 바뀌어 번역을 넣지 못했어요", context, origin, { error: true });
        return;
      }
      // The worker's offscreen document keeps clipboard writes reliable after long
      // requests, even when Chrome's transient activation has expired.
      const copied = await send({ type: "context:clipboard", text: result.text });
      if (!alive(context)) { toast?.close(0); return; }
      toast ||= surfaces.toast(origin, context.target);
      if (!copied?.ok) toast.show("복사 실패", { error: true, retry });
      else toast.show(id.includes(".ja.") ? "일본어로 복사됨" : "영어로 복사됨", { preview: result.text });
    }
    async function activate(id, context, origin, event) {
      if (event?.isTrusted !== true || !alive(context)) return { ok: false, code: "untrusted_event" };
      model.restore(context, doc, win);
      try {
        if (id.startsWith("translate.") || id.startsWith("replace.")) { await translate(id, context, origin, event); return; }
        switch (id) {
          case "media.copyUrl": await copy(context.mediaUrl, context, origin); break;
          case "media.poster": {
            const result = await send({ type: "context:action", action: "image.save", url: context.posterUrl });
            if (alive(context)) notice(result?.ok ? "저장 시작됨" : "포스터를 저장하지 못했어요", context, origin, { error: !result?.ok });
            break;
          }
          case "media.frame.save":
          case "media.frame.lakomics": {
            let url;
            try { url = captureFrame(context.media, doc); }
            catch (error) { notice(error.message, context, origin, { error: true }); return { ok: false, code: "frame_unavailable" }; }
            if (id === "media.frame.lakomics") {
              // /v1/captures accepts remote URLs, not locally generated bytes.
              notice("현재 장면의 Lakomics 저장에는 이미지 업로드 지원이 필요해요 · 이미지로 저장을 이용해 주세요", context, origin, { error: true });
              return { ok: false, code: "frame_upload_unsupported" };
            }
            const result = await send({ type: "context:action", action: "image.save", url });
            if (alive(context)) notice(result?.ok ? "저장 시작됨" : "현재 장면을 저장하지 못했어요", context, origin, { error: !result?.ok });
            break;
          }
          case "edit.copy": await copy(context.text, context, origin); break;
          case "edit.cut": {
            await win.navigator.clipboard.writeText(context.text);
            if (alive(context) && !replace(context, "", doc, win)) notice("입력 내용이 바뀌었어요", context, origin, { error: true });
            break;
          }
          case "edit.paste": {
            const text = await win.navigator.clipboard.readText();
            if (alive(context) && !replace(context, text, doc, win)) notice("입력 내용이 바뀌었어요", context, origin, { error: true });
            break;
          }
          case "edit.selectAll": selectAll(context, doc, win); break;
          case "image.copyUrl": await copy(context.imageUrl, context, origin); break;
          case "link.copy": await copy(context.linkUrl, context, origin); break;
          case "image.translate": await image?.translate(context, event); break;
          case "page.translate": page?.activate(context, origin); break;
          case "image.lakomics": await collector.open?.(context.candidate, origin); break;
          case "nav.back": win.history.back(); break;
          case "nav.forward": win.history.forward(); break;
          case "nav.reload": win.location.reload(); break;
          case "av.send": {
            const request = globalThis.LakomicsAvLookup.createSendRequest(context.text, win.location.href);
            if (!request) return;
            const result = await send({ type: "av-send", request });
            if (alive(context)) notice(result?.ok ? `PC로 보냈어요 · ${request.productCode}` : result?.code === "unpaired" || result?.code === "revoked" ? "Lakomics와 먼저 연결해 주세요" : "보내지 못했어요", context, origin, { error: !result?.ok });
            break;
          }
          default: {
            const image = id.startsWith("image.");
            const result = await send({ type: "context:action", action: id, url: image ? context.imageUrl : context.linkUrl, title: doc.title });
            if (alive(context) && (!result?.ok || id.endsWith("saveAs") || id === "image.save")) notice(result?.ok ? "저장 시작됨" : "작업 실패", context, origin, { error: !result?.ok });
          }
        }
        return { ok: true };
      } catch { if (alive(context)) notice("작업 실패 · 브라우저 권한을 확인해 주세요", context, origin, { error: true }); return { ok: false }; }
    }
    return { activate, pageState: () => page?.state() ?? "off", destroy() { image?.destroy(); page?.destroy(); } };
  }
  globalThis.LakomicsContextActions = { runtime, unchanged, replace, selectAll, captureFrame, createActions };
})();
