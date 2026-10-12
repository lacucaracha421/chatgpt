(() => {
  "use strict";
  // Runs in the page's own JS world on Arca Live's write page only (manifest `world: "MAIN"`).
  // The extension's content script cannot hand a File to the editor's own handlers without the
  // cross-realm problems of an isolated world, so it posts the picture here and this script
  // dispatches the paste (or drop) event. It accepts one image per message, only from this
  // window, and only aims at the post body; it has no other powers.
  if (window.top !== window) return;
  const EDITOR = "form#article_write_form .write-body .fr-element.fr-view";
  const EDITOR_FALLBACK = ".write-body .fr-element.fr-view";
  const MAX_BYTES = 21 * 1024 * 1024;
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.lakomicsPicker !== 1 || typeof data.id !== "string") return;
    const reply = fields => window.postMessage({ lakomicsPickerReply: 1, id: data.id, ...fields }, location.origin);
    if (data.kind === "ping") { reply({ ok: true }); return; }
    if (data.kind !== "paste" && data.kind !== "drop") return;
    const file = data.file;
    if (!(file instanceof File) || !/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(file.type) || file.size > MAX_BYTES) { reply({ ok: false, handled: false, error: "file" }); return; }
    const editor = document.querySelector(EDITOR) || document.querySelector(EDITOR_FALLBACK);
    if (!editor) { reply({ ok: false, handled: false, error: "editor" }); return; }
    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      let synthetic;
      if (data.kind === "paste") synthetic = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
      else {
        const rect = editor.getBoundingClientRect();
        synthetic = new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8 });
      }
      editor.dispatchEvent(synthetic);
      reply({ ok: true, handled: synthetic.defaultPrevented });
    } catch { reply({ ok: false, handled: false, error: "dispatch" }); }
  });
})();
