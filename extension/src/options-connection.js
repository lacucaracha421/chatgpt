(() => {
  "use strict";

  async function saveAndRefresh(send, tokenInput) {
    const token = String(tokenInput ?? "").trim();
    if (token) {
      const saved = await send({ type: "settings:set-token", token });
      if (!saved.ok) return saved;
    }
    return send({ type: "classifications:refresh" });
  }

  globalThis.LakomicsOptionsConnection = { saveAndRefresh };
})();
