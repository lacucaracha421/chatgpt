import { loadWorker } from "./helpers/youtube-classic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEAKER_INSTRUCTION } from "./helpers/youtube-classic.mjs";

for (const [trackKey, baseMode, storedMode] of [
  ["ko:asr", "clean", "clean"],
  ["en:asr", "translate-ko", "translate-ko-auto"],
]) {
  test(`background isolates speaker caches and in-flight jobs for ${baseMode}`, async (t) => {
    const originalChrome = globalThis.chrome;
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.chrome = originalChrome;
      globalThis.fetch = originalFetch;
    });

    const stored = { "lakomics:translation:v1": {anthropicApiKey:"test-key"} };
    const messages = [];
    let listener;
    globalThis.chrome = {
      storage: { local: {
        get: async (keys) => {
          const names = Array.isArray(keys) ? keys : [keys];
          return structuredClone(Object.fromEntries(names.filter((key) => key in stored).map((key) => [key, stored[key]])));
        },
        set: async (values) => Object.assign(stored, structuredClone(values)),
        remove: async (key) => { delete stored[key]; },
      } },
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        getPlatformInfo: () => {},
      },
      tabs: { sendMessage: async (_tab, message) => { messages.push(message); } },
    };

    const requests = [];
    let notifyRequest;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.output_config.format.schema.required.includes("terms")) return {
        ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ register: "haeyo", terms: [] }) }],
          usage: { input_tokens: 1, output_tokens: 1 } }),
      };
      return new Promise((resolve) => {
        requests.push({ body: JSON.parse(init.body), resolve });
        if (notifyRequest) notifyRequest();
      });
    };
    const waitForRequest = async (count) => {
      while (requests.length < count) await new Promise((resolve) => { notifyRequest = resolve; });
      notifyRequest = null;
    };
    loadWorker();
    const send = (message) => new Promise((resolve) => {
      assert.equal(listener(message, { tab: { id: 1 } }, resolve), true);
    });
    const process = {
      type: "youtube:process", videoId: "video12", trackKey,
      json3: { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "응" }] }] },
    };
    const getCached = () => send({ type: "youtube:getCached", videoId: "video12" });
    const finish = (request, text) => request.resolve({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: JSON.stringify({ lines: [{ from: 0, to: 0, text }], register: "haeyo" }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });

    // Same flag deduplicates; a changed flag starts a separate job while the first is pending.
    const off = send(process);
    const offDuplicate = send(process);
    await waitForRequest(1);
    stored["lakomics:youtube:settings:speakers"] = true;
    const on = send(process);
    const onDuplicate = send(process);
    await waitForRequest(2);
    assert.ok(!requests[0].body.system.includes(SPEAKER_INSTRUCTION));
    assert.ok(requests[1].body.system.endsWith(SPEAKER_INSTRUCTION));
    finish(requests[0], "응.");
    finish(requests[1], "- 응.");
    const results = await Promise.all([off, offDuplicate, on, onDuplicate]);
    assert.ok(results.every((r) => r.ok));
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[2], results[3]);
    assert.equal(requests.length, 2);

    const offKey = `lakomics:youtube:subs:v2:video12:${trackKey}:${storedMode}+t8`;
    const onKey = `lakomics:youtube:subs:v2:video12:${trackKey}:${storedMode}+spk+t8`;
    assert.equal(stored[offKey].cues[0].text, "응.");
    assert.equal(stored[onKey].cues[0].text, "- 응.");
    assert.deepEqual(new Set(stored["lakomics:youtube:subs:index"].video12), new Set([
      `${trackKey}|${storedMode}+t8`, `${trackKey}|${storedMode}+spk+t8`,
    ]));
    assert.ok(messages.filter((m) => m.type === "youtube:progress").every((m) => m.mode === baseMode));
    assert.equal((await getCached()).cached.cues[0].text, "- 응.");
    assert.equal((await send(process)).cached, true);

    stored["lakomics:youtube:settings:speakers"] = false;
    assert.equal((await getCached()).cached.cues[0].text, "응.");
    assert.equal((await send(process)).cached, true);
    delete stored["lakomics:youtube:settings:speakers"];
    assert.equal((await getCached()).cached.cues[0].text, "응.");
    stored["lakomics:youtube:settings:speakers"] = true;
    delete stored[onKey];
    stored["lakomics:youtube:subs:index"].video12 = [`${trackKey}|${storedMode}+t8`];
    assert.equal((await getCached()).cached, null);
    assert.equal(requests.length, 2);
  });
}
