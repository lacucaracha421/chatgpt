(() => {
  "use strict";
  const OFFSCREEN = "src/context-menu/offscreen.html";
  let creating = null, offscreenJobs = Promise.resolve();
  const pageUrls = new Map();
  function contentSender(sender) {
    try {
      if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id)) return false;
      if (["https:", "http:"].includes(new URL(sender.url).protocol)) return true;
      return ["about:blank", "about:srcdoc"].includes(sender.url) && sender.frameId > 0 && Boolean(safeUrl(sender.tab.url)) && Boolean(safeUrl(sender.origin));
    }
    catch { return false; }
  }
  function callbackCall(invoke) {
    return new Promise((resolve, reject) => { try { invoke(value => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(value)); } catch (error) { reject(error); } });
  }
  async function ensureOffscreen() {
    if (creating) return creating;
    creating = (async () => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL(OFFSCREEN)] });
      if (!contexts.length) await chrome.offscreen.createDocument({ url: OFFSCREEN, reasons: ["CLIPBOARD", "BLOBS"], justification: "Copy translated text after asynchronous requests and hold captured page download URLs." });
    })();
    try { await creating; } finally { creating = null; }
  }
  function offscreen(operation, value) {
    const result = offscreenJobs.then(async () => {
      await ensureOffscreen();
      return callbackCall(callback => chrome.runtime.sendMessage({ type: "context:offscreen", operation, ...value }, callback));
    });
    offscreenJobs = result.catch(() => {}); return result;
  }
  function filename(title) {
    let name = String(title || "page").normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").replace(/[\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 100).replace(/[. ]+$/, "");
    if (!name) name = "page";
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "_" + name;
    return name + ".mhtml";
  }
  function safeUrl(value) {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  }
  function imageUrl(value, sender) {
    const remote = safeUrl(value); if (remote) return remote;
    try {
      const url = new URL(value);
      const origin = ["about:blank", "about:srcdoc"].includes(sender.url) ? sender.origin : new URL(sender.url).origin;
      if (url.protocol === "blob:" && url.origin === origin) return url.href;
      if (url.protocol === "data:" && /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)(?:;|,)/i.test(value)) return url.href;
    } catch {}
    return null;
  }
  async function download(details) {
    const id = await callbackCall(callback => chrome.downloads.download(details, callback));
    if (!Number.isInteger(id)) throw new Error("No download id");
    return { ok: true, downloadId: id };
  }
  async function savePage(sender, title) {
    const blob = await callbackCall(callback => chrome.pageCapture.saveAsMHTML({ tabId: sender.tab.id }, callback));
    if (!blob || typeof blob.arrayBuffer !== "function") return { ok: false, code: "capture_failed" };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    const created = await offscreen("blob", { base64: btoa(binary) });
    if (!created?.ok || !created.url) return { ok: false, code: "capture_failed" };
    try {
      const result = await download({ url: created.url, filename: filename(title || sender.tab.title), saveAs: true, conflictAction: "uniquify" });
      pageUrls.set(result.downloadId, created.url); return result;
    } catch (error) { await offscreen("revoke", { url: created.url }).catch(() => {}); throw error; }
  }
  async function handle(message, sender) {
    if (!contentSender(sender)) return { ok: false, code: "forbidden_sender" };
    try {
      if (message.type === "context:settings") {
        await chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") + "#translation-section" }); return { ok: true };
      }
      if (message.type === "context:clipboard") {
        if (typeof message.text !== "string" || !message.text || message.text.length > 40000) return { ok: false, code: "invalid_text" };
        return await offscreen("clipboard", { text: message.text });
      }
      if (message.type !== "context:action") return { ok: false, code: "unknown_message" };
      if (message.action === "page.saveAs") return sender.frameId > 0 ? { ok: false, code: "top_frame_only" } : await savePage(sender, message.title);
      const url = message.action?.startsWith("image.") ? imageUrl(message.url, sender) : safeUrl(message.url);
      if (!url) return { ok: false, code: "invalid_url" };
      if (["link.openTab", "image.openTab"].includes(message.action)) {
        await chrome.tabs.create({ url, ...(Number.isInteger(sender.tab.index) ? { index: sender.tab.index + 1 } : {}), openerTabId: sender.tab.id });
        return { ok: true };
      }
      if (["image.save", "image.saveAs", "link.saveAs"].includes(message.action)) return await download({ url, saveAs: message.action !== "image.save", conflictAction: "uniquify" });
      return { ok: false, code: "unknown_action" };
    } catch { return { ok: false, code: "browser_action_failed" }; }
  }
  chrome.downloads?.onChanged?.addListener(delta => {
    if (!pageUrls.has(delta.id) || !["complete", "interrupted"].includes(delta.state?.current)) return;
    const url = pageUrls.get(delta.id); pageUrls.delete(delta.id); void offscreen("revoke", { url }).catch(() => {});
  });
  globalThis.LakomicsContextBackground = { handle, filename, safeUrl };
})();
