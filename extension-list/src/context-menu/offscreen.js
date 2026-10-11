(() => {
  "use strict";
  const urls = new Map();
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "context:offscreen") return;
    // Only extension-owned service messages can reach this document. Page scripts
    // never receive its handle or any API/connection credentials.
    if (sender.id !== chrome.runtime.id || sender.tab) { respond({ ok: false, code: "forbidden_sender" }); return; }
    try {
      if (message.operation === "clipboard" && typeof message.text === "string") {
        const textarea = document.createElement("textarea"); textarea.value = message.text; document.body.append(textarea); textarea.select();
        let ok;
        try { ok = document.execCommand("copy"); } finally { textarea.remove(); }
        respond({ ok: ok === true, ...(!ok ? { code: "clipboard_failed" } : {}) });
      } else if (message.operation === "blob") {
        const bytes = Uint8Array.from(atob(message.base64), char => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "multipart/related" }));
        // Safety expiry also releases a URL if the service worker is restarted
        // before receiving the terminal download event.
        urls.set(url, setTimeout(() => revoke(url), 3600000)); respond({ ok: true, url });
      } else if (message.operation === "revoke") { revoke(message.url); respond({ ok: true }); }
      else respond({ ok: false, code: "unknown_operation" });
    } catch { respond({ ok: false, code: "offscreen_failed" }); }
  });
  function revoke(url) { if (!urls.has(url)) return; clearTimeout(urls.get(url)); urls.delete(url); URL.revokeObjectURL(url); }
})();
