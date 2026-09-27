(() => {
  "use strict";

  const PAGE_BUTTON_ID = "lakomics-av-send-page";

  function pageCodeElement(doc, href) {
    let url;
    try { url = new URL(href); } catch { return null; }
    if (url.protocol !== "https:" || url.hostname !== "www.javlibrary.com") return null;
    if (!url.searchParams.get("v") && !/\/vl_searchbyid\.php$/.test(url.pathname)) return null;
    const direct = doc.querySelector("#video_id .text");
    if (direct) return direct;
    for (const row of doc.querySelectorAll("tr")) {
      const cells = Array.from(row.querySelectorAll("th, td"));
      if (/^(?:品番|ID)\s*[:：]?$/i.test(cells[0]?.textContent.trim() || "")) return cells[1] || null;
    }
    return null;
  }

  function runtimeRequest(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          resolve(chrome.runtime.lastError ? { ok: false, code: "worker_failed" } : response);
        });
      } catch { resolve({ ok: false, code: "worker_failed" }); }
    });
  }

  function createController({ doc = document, win = window, lookup = globalThis.LakomicsAvLookup,
    sendMessage = runtimeRequest } = {}) {
    const operations = new Map();
    const buttons = new Map();
    let toast = null;
    let timer = null;

    function showToast(message, retry) {
      if (timer !== null) win.clearTimeout(timer);
      toast?.remove();
      let layer = doc.querySelector(".lakomics-list-toasts");
      if (!layer) {
        layer = doc.createElement("div");
        layer.className = "lakomics-list-toasts";
        doc.documentElement.append(layer);
      }
      toast = doc.createElement("div");
      toast.className = "lakomics-list-toast lakomics-av-toast";
      toast.setAttribute("role", "status");
      toast.textContent = message;
      if (retry) {
        toast.classList.add("actionable");
        const button = doc.createElement("button");
        button.type = "button";
        button.textContent = "다시";
        button.addEventListener("click", () => {
          win.clearTimeout(timer);
          toast?.remove();
          retry();
        });
        toast.append(button);
      }
      layer.append(toast);
      timer = win.setTimeout(() => { toast?.remove(); toast = null; }, 3000);
    }

    function renderButtons() {
      for (const [button, { code, label }] of buttons) {
        const state = operations.get(code)?.state || "idle";
        button.dataset.state = state;
        button.textContent = state === "sending" ? "보내는 중" : state === "sent" ? "보냄" : label;
        button.disabled = state !== "idle";
      }
    }

    function setButton(button, value, label) {
      buttons.set(button, { code: lookup.productCodeFromText(value), label });
      renderButtons();
    }

    function receive(request, result) {
      const operation = operations.get(request.productCode);
      // Context-menu results use the same state and retry path as the page/chip.
      const current = operation?.request.requestId === request.requestId ? operation : { request };
      current.state = result?.ok ? "sent" : "idle";
      operations.set(request.productCode, current);
      renderButtons();
      if (result?.ok) showToast(`PC로 보냈어요 · ${request.productCode}`);
      else if (result?.code === "unpaired" || result?.code === "revoked") showToast("Lakomics와 먼저 연결해 주세요");
      else showToast("보내지 못했어요", () => attempt(current));
    }

    async function attempt(operation) {
      if (operation.state === "sending" || operation.state === "sent") return;
      operation.state = "sending";
      renderButtons();
      let result;
      try { result = await sendMessage({ type: "av-send", request: operation.request }); }
      catch { result = { ok: false, code: "worker_failed" }; }
      receive(operation.request, result);
      return result;
    }

    function send(value) {
      const code = lookup.productCodeFromText(value);
      if (!code) return;
      let operation = operations.get(code);
      if (!operation) {
        operation = { request: lookup.createSendRequest(code, win.location.href), state: "idle" };
        operations.set(code, operation);
      }
      return attempt(operation);
    }

    function injectPageButton() {
      if (doc.getElementById(PAGE_BUTTON_ID)) return null;
      const target = pageCodeElement(doc, win.location.href);
      const code = lookup.productCodeFromText(target?.textContent);
      if (!code) return null;
      const button = doc.createElement("button");
      button.id = PAGE_BUTTON_ID;
      button.type = "button";
      button.className = "lakomics-av-send-button";
      setButton(button, code, "컬렉션에 보내기");
      button.addEventListener("click", () => { void send(code); });
      target.append(button);
      return button;
    }

    return { send, receive, setButton, injectPageButton, destroy() {
      if (timer !== null) win.clearTimeout(timer);
      toast?.remove();
      doc.getElementById(PAGE_BUTTON_ID)?.remove();
      buttons.clear(); operations.clear();
    } };
  }

  if (globalThis.__LAKOMICS_TEST__) globalThis.LakomicsAvSend = { createController, pageCodeElement };
  else if (globalThis.LakomicsAvLookup) {
    const controller = createController();
    globalThis.LakomicsAvSend = controller;
    controller.injectPageButton();
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === "av-send-result") controller.receive(message.request, message.result);
    });
  }
})();
