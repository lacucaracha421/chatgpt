import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const layoutSource = fs.readFileSync(new URL("../src/layout.js", import.meta.url), "utf8");
const gestureSource = fs.readFileSync(new URL("../src/gesture.js", import.meta.url), "utf8");
const contentSource = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");

test("sends one final selection and cancellation sends nothing", async () => {
  const sent = [];
  const api = loadContent(async (payload) => { sent.push(payload); return { ok: true, status: "added" }; });
  const controller = api.createCollectorController({ send: api.send, status() {}, snapshot: api.snapshot });
  const candidate = {
    mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig",
    sourceUrl: "https://x.com/user/status/1/photo/1",
  };
  const entries = [{ id: "tag", kind: "tag", name: "Tag", parentId: null }];
  const layout = api.radial.resetLayout(entries);

  controller.begin(candidate, { x: 100, y: 100 }, entries, layout);
  controller.move({ x: 100, y: 16 }, 0);
  await controller.release();
  await controller.release();
  assert.equal(sent.length, 1);
  assert.deepEqual(plain(sent[0]), {
    source: "x",
    mediaUrl: candidate.mediaUrl,
    sourceUrl: candidate.sourceUrl,
    classificationId: "tag",
  });

  controller.begin(candidate, { x: 100, y: 100 }, entries, layout);
  controller.move({ x: 100, y: 16 }, 0);
  controller.cancel();
  await controller.release();
  assert.equal(sent.length, 1);
});

test("retry resends the identical failed payload", async () => {
  const sent = [];
  const api = loadContent(async (payload) => {
    sent.push(payload);
    return sent.length === 1 ? { ok: false, code: "download_failed" } : { ok: true, status: "added" };
  });
  const controller = api.createCollectorController({ send: api.send, status() {}, snapshot: api.snapshot });
  const entries = [{ id: "tag", kind: "tag", name: "Tag", parentId: null }];
  const candidate = { mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig", sourceUrl: "https://x.com/u/status/1" };
  controller.begin(candidate, { x: 0, y: 0 }, entries, api.radial.resetLayout(entries));
  controller.move({ x: 0, y: -84 }, 0);
  await controller.release();
  await controller.retry();

  assert.equal(sent.length, 2);
  assert.deepEqual(plain(sent[1]), plain(sent[0]));
});

test("worker transport failures remain retryable", async () => {
  const sent = [];
  const statuses = [];
  const api = loadContent(async (payload) => {
    sent.push(payload);
    if (sent.length === 1) throw new Error("worker stopped");
    return { ok: true, status: "added" };
  });
  const controller = api.createCollectorController({
    send: api.send,
    status(message, retry) { statuses.push({ message, retry }); },
    snapshot: api.snapshot,
  });
  const entries = [{ id: "tag", kind: "tag", name: "Tag", parentId: null }];
  const candidate = { mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig", sourceUrl: "https://x.com/u/status/1" };
  controller.begin(candidate, { x: 0, y: 0 }, entries, api.radial.resetLayout(entries));
  controller.move({ x: 0, y: -84 }, 0);

  assert.deepEqual(plain(await controller.release()), { ok: false, code: "worker_failed" });
  assert.equal(statuses.at(-1).retry, true);
  assert.deepEqual(plain(await controller.retry()), { ok: true, status: "added" });
  assert.deepEqual(plain(sent[1]), plain(sent[0]));
});

test("click suppression consumes only the first click after a radial drag", () => {
  const api = loadContent(async () => ({ ok: true }));
  const suppressor = api.createClickSuppressor();
  const ordinary = clickEvent();
  assert.equal(suppressor.consume(ordinary), false);
  assert.equal(ordinary.defaultPrevented, false);
  assert.equal(ordinary.immediatePropagationStopped, false);

  suppressor.arm();
  const first = clickEvent();
  assert.equal(suppressor.consume(first), true);
  assert.equal(first.defaultPrevented, true);
  assert.equal(first.immediatePropagationStopped, true);

  const second = clickEvent();
  assert.equal(suppressor.consume(second), false);
  assert.equal(second.defaultPrevented, false);
  assert.equal(second.immediatePropagationStopped, false);
});

test("secondary ring expands on dwell and renders child slots", async () => {
  const api = loadContent(async () => ({ ok: true, status: "added" }));
  const controller = api.createCollectorController({ send: api.send, status() {}, snapshot: api.snapshot });
  const entries = [
    { id: "parent", kind: "root", name: "Parent", parentId: null },
    { id: "child", kind: "tag", name: "Child", parentId: "parent" },
  ];
  const layout = api.radial.resetLayout(entries);
  controller.begin({ mediaUrl: "https://x.com/img.jpg", sourceUrl: "https://x.com/u/1" }, { x: 100, y: 100 }, entries, layout);
  controller.move({ x: 100, y: 16 }, 0);
  controller.tick(300);
  const lastSnapshot = api.lastSnapshot;
  assert.notEqual(lastSnapshot.secondaryLevel, null);
  assert.equal(lastSnapshot.secondaryLevel.slots[0].id, "child");
});

function loadContent(send) {
  const context = {
    globalThis: null,
    __LAKOMICS_TEST__: true,
    __send: send,
  };
  context.globalThis = context;
  vm.runInNewContext(layoutSource, context, { filename: "layout.js" });
  vm.runInNewContext(gestureSource, context, { filename: "gesture.js" });
  vm.runInNewContext(contentSource, context, { filename: "content.js" });
  let lastSnapshot = null;
  return {
    ...context.LakomicsContent,
    radial: context.LakomicsRadial,
    send,
    snapshot(next) { lastSnapshot = next; },
    get lastSnapshot() { return lastSnapshot; },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function clickEvent() {
  return {
    defaultPrevented: false,
    immediatePropagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
  };
}
