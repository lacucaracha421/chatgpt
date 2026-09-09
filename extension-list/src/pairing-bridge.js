(() => {
  "use strict";

  function pairingLocation(value) {
    try {
      const url = new URL(String(value || ""));
      const path = url.pathname.replace(/\/+$/, "");
      const secret = url.hash.startsWith("#") ? url.hash.slice(1) : "";
      return url.protocol === "https:" && path === "/extension-pair" && secret.length >= 16 && secret.length <= 256;
    } catch { return false; }
  }

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, code: "worker_timeout" }), 15_000);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value ?? { ok: false, code: "worker_failed" });
      };
      try {
        // Chromium/Titanium can expose a Promise even when a callback is supplied.
        // That Promise may resolve to undefined before sendResponse arrives, so the
        // callback is the single authority for this callback-form invocation.
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime?.lastError) finish({ ok: false, code: "worker_failed" });
          else finish(response);
        });
      } catch { finish({ ok: false, code: "worker_failed" }); }
    });
  }

  function renderResult(ok) {
    const render = () => {
      document.documentElement.innerHTML = `<head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lakomics</title><style>
        :root{color-scheme:dark;font:15px/1.5 system-ui,'Malgun Gothic',sans-serif;background:#111214;color:#e5e3dd}
        body{margin:0;min-height:100dvh;display:grid;place-items:center}.state{width:min(320px,calc(100% - 48px));border-top:3px solid #ddd8ca;padding:22px 0;text-align:center}
        small{display:block;margin-bottom:8px;color:#a6a7a5;font-size:11px;letter-spacing:.18em}strong{font-size:20px;font-weight:500;color:${ok ? "#ddd8ca" : "#e3b987"}}
      </style></head><body><main class="state"><small>LAKOMICS</small><strong>${ok ? "연결됨" : "연결 실패"}</strong></main></body>`;
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render, { once: true });
    else render();
  }

  async function pairFromLocation(value = location.href) {
    if (!pairingLocation(value)) return { ok: false, code: "not_pairing_url" };
    try { history.replaceState(null, "", `${location.origin}/extension-pair`); } catch {}
    const result = await runtimeMessage({ type: "pair", value });
    renderResult(Boolean(result?.ok));
    if (result?.ok) setTimeout(() => { try { window.close(); } catch {} }, 600);
    return result;
  }

  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsPairingBridge = { pairingLocation, runtimeMessage };
    return;
  }
  if (globalThis.__lakomicsPairingBridgeInstalled) return;
  globalThis.__lakomicsPairingBridgeInstalled = true;
  void pairFromLocation();
})();
