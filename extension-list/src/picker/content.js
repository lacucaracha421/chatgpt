(() => {
  "use strict";
  // Entry point on https://arca.live/b/*/write*: the toolbar button, the Alt+Shift+L toggle
  // (routed here by the service worker) and the panel. Nothing is injected anywhere else.
  function start({ doc = document, win = window, runtime = globalThis.chrome?.runtime, storage = globalThis.chrome?.storage?.local } = {}) {
    const Model = globalThis.LakomicsPickerModel, Insert = globalThis.LakomicsPickerInsert, Toolbar = globalThis.LakomicsPickerToolbar, Panel = globalThis.LakomicsPickerPanel;
    if (!Model || !Insert || !Toolbar || !Panel || win.top !== win || !Model.isArcaWriteUrl(win.location.href)) return null;
    const editor = Insert.createEditorAdapter({ doc, win });
    const bridge = Insert.createBridgeTransport({ win }), direct = Insert.createDirectTransport({ doc, win });
    let transport = null;
    // The page-world bridge when it answers; otherwise the content script dispatches itself.
    const getTransport = async () => (transport ||= await Insert.chooseTransport(bridge, direct));
    const inserter = Insert.createInserter({ editor, getTransport });
    const send = message => new Promise(resolve => {
      try { runtime.sendMessage(message, reply => resolve(runtime.lastError || !reply ? { ok: false, kind: "offline" } : reply)); }
      catch { resolve({ ok: false, kind: "offline" }); }
    });
    let toolbar = null;
    const panel = Panel.createPanel({ doc, win, css: globalThis.LakomicsPickerCss, send, storage, editor, inserter, detectTheme: Toolbar.detectTheme, onOpenChange: open => toolbar?.setPressed(open) });
    toolbar = Toolbar.createToolbarButton({ doc, win, onClick: () => { if (panel.isOpen) panel.close(); else void panel.open(); } });
    toolbar.start();
    runtime.onMessage.addListener(message => { if (message?.type === "picker:toggle") void panel.toggle(); return false; });
    return { panel, toolbar, editor };
  }
  globalThis.LakomicsPickerContent = { start };
  if (typeof chrome !== "undefined" && chrome.runtime?.id && !globalThis.__LAKOMICS_TEST__) start();
})();
