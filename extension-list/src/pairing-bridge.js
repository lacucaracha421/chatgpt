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

  // The failure page names the cause so the next step is clear; no server detail,
  // secret or URL is shown.
  function failureReason(result) {
    const code = result?.code;
    if (code === "pairing_expired") return "링크가 만료됐거나 이미 사용됐습니다 · PC에서 새로 발급한 QR로 다시 연결하세요";
    if (code === "invalid_pairing") return "연결 링크 형식이 올바르지 않습니다 · QR을 다시 스캔하세요";
    if (code === "timeout" || code === "offline") return "서버에 연결하지 못했습니다 · 태블릿의 네트워크와 서버 상태를 확인하세요";
    if (code === "worker_failed" || code === "worker_timeout") return "확장 프로그램이 응답하지 않습니다 · 확장 프로그램을 새로고침한 뒤 새 QR로 연결하세요";
    if (code === "pairing_failed") return `서버가 연결을 거절했습니다${Number.isInteger(result?.httpStatus) && result.httpStatus > 0 ? ` (HTTP ${result.httpStatus})` : ""} · 새 QR로 다시 시도하세요`;
    return "알 수 없는 오류 · 새 QR로 다시 시도하세요";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function renderResult(ok, reason = "") {
    const render = () => {
      document.documentElement.innerHTML = `<head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lakomics</title><style>
        :root{color-scheme:dark;font:15px/1.5 system-ui,'Malgun Gothic',sans-serif;background:#111214;color:#e5e3dd}
        body{margin:0;min-height:100dvh;display:grid;place-items:center}.state{width:min(320px,calc(100% - 48px));border-top:3px solid #ddd8ca;padding:22px 0;text-align:center}
        small{display:block;margin-bottom:8px;color:#a6a7a5;font-size:11px;letter-spacing:.18em}strong{font-size:20px;font-weight:500;color:${ok ? "#ddd8ca" : "#e3b987"}}
        p{margin:12px 0 0;color:#a6a7a5;font-size:13px;word-break:keep-all;overflow-wrap:anywhere}
      </style></head><body><main class="state"><small>LAKOMICS</small><strong>${ok ? "연결됨" : "연결 실패"}</strong>${ok || !reason ? "" : `<p>${escapeHtml(reason)}</p>`}</main></body>`;
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render, { once: true });
    else render();
  }

  // A pairing can succeed in the worker while this page sees a failure: the page ran
  // twice (the second use of the one-time link is rejected) or the reply was lost or
  // late. A connection saved after this attempt started means it did connect.
  async function pairedSince(startedAt) {
    const settings = await runtimeMessage({ type: "settings:get" });
    return Boolean(settings?.paired) && Number(settings.pairedAt) >= startedAt;
  }

  async function pairFromLocation(value = location.href) {
    if (!pairingLocation(value)) return { ok: false, code: "not_pairing_url" };
    try { history.replaceState(null, "", `${location.origin}/extension-pair`); } catch {}
    const startedAt = Date.now() - 1000;
    let result = await runtimeMessage({ type: "pair", value });
    if (!result?.ok && await pairedSince(startedAt)) result = { ok: true, recovered: true };
    renderResult(Boolean(result?.ok), result?.ok ? "" : failureReason(result));
    if (result?.ok) setTimeout(() => { try { window.close(); } catch {} }, 600);
    return result;
  }

  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsPairingBridge = { pairingLocation, runtimeMessage, failureReason, pairFromLocation };
    return;
  }
  if (globalThis.__lakomicsPairingBridgeInstalled) return;
  globalThis.__lakomicsPairingBridgeInstalled = true;
  void pairFromLocation();
})();
