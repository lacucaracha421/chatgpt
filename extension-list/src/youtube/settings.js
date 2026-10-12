(() => {
  "use strict";
  const PREFIX = "lakomics:youtube:settings:";
  const DEFAULTS = Object.freeze({ enabled: true, model: "claude-haiku-5-5", translate: true,
    register: "auto", speakers: false, glossarySonnet: false, fontScale: 1, position: "default", showOriginal: false, rolling: false, localAsr: true, speakerColors: true });
  const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
  function normalize(value = {}) {
    const settings = { ...DEFAULTS };
    for (const key of ["enabled", "translate", "speakers", "glossarySonnet", "showOriginal", "rolling", "localAsr", "speakerColors"]) {
      if (typeof value[key] === "boolean") settings[key] = value[key];
    }
    if (MODELS.includes(value.model)) settings.model = value.model;
    if (["auto", "haeyo", "hapnida", "banmal"].includes(value.register)) settings.register = value.register;
    if ([0.85, 1, 1.15, 1.3].includes(value.fontScale)) settings.fontScale = value.fontScale;
    if (value.position === "raised") settings.position = "raised";
    return settings;
  }
  async function read() {
    const stored = await chrome.storage.local.get(Object.keys(DEFAULTS).map(key => PREFIX + key));
    return normalize(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, stored[PREFIX + key]])));
  }
  async function update(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
        Object.keys(patch).some(key => !Object.hasOwn(DEFAULTS, key))) return { ok: false, code: "invalid_settings" };
    const next = normalize({ ...await read(), ...patch });
    if (Object.keys(patch).some(key => next[key] !== patch[key])) return { ok: false, code: "invalid_settings" };
    await chrome.storage.local.set(Object.fromEntries(Object.entries(next).map(([key, value]) => [PREFIX + key, value])));
    return { ok: true, settings: next };
  }
  (globalThis.LakomicsYouTube ??= {}).settings = { PREFIX, DEFAULTS, MODELS, normalize, read, update };
})();
