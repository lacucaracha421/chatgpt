import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const defaultsSource = fs.readFileSync(new URL("../src/defaults.js", import.meta.url), "utf8");
const layoutSource = fs.readFileSync(new URL("../src/layout.js", import.meta.url), "utf8");
const gestureSource = fs.readFileSync(new URL("../src/gesture.js", import.meta.url), "utf8");
const xSourceSource = fs.readFileSync(new URL("../src/x-source.js", import.meta.url), "utf8");
const contentSource = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");

function loadWithDocument() {
  const listeners = new Map();
  const classList = { toggled: [], toggle(name, force) { this.toggled.push([name, force]); } };
  const documentStub = {
    cookie: "",
    documentElement: { classList, append() {}, remove() {} },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
  };
  const context = {
    URL,
    setTimeout,
    clearTimeout,
    globalThis: null,
    document: documentStub,
    window: {
      setTimeout,
      clearTimeout,
      addEventListener() {},
    },
    location: { origin: "https://x.com" },
    navigator: { language: "ko-KR" },
  };
  context.globalThis = context;
  vm.runInNewContext(defaultsSource, context, { filename: "defaults.js" });
  vm.runInNewContext(layoutSource, context, { filename: "layout.js" });
  vm.runInNewContext(gestureSource, context, { filename: "gesture.js" });
  vm.runInNewContext(xSourceSource, context, { filename: "x-source.js" });
  vm.runInNewContext(contentSource, context, { filename: "content.js" });
  // Drive the gesture with a stub video candidate: a press starting near a
  // video (e.g. on surrounding post text) still opens a save session.
  const candidateElement = { setPointerCapture() {} };
  context.LakomicsXSource = {
    findCandidate: () => ({ type: "video", element: candidateElement }),
  };
  return {
    listeners,
    fire(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function domEvent(overrides = {}) {
  return {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: 100,
    clientY: 200,
    timeStamp: 0,
    target: {},
    defaultPrevented: false,
    immediatePropagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    ...overrides,
  };
}

test("mouse save gesture suppresses native selection only while active", () => {
  const driver = loadWithDocument();

  // 1. No gesture: ordinary page selection must work untouched.
  const idle = domEvent();
  driver.fire("selectstart", idle);
  assert.equal(idle.defaultPrevented, false);

  // 2. Press on saveable video media opens a gesture session: a selectstart
  // from the ensuing drag must not create a native highlight.
  driver.fire("pointerdown", domEvent());
  const during = domEvent();
  driver.fire("selectstart", during);
  assert.equal(during.defaultPrevented, true);

  // 3. Release ends the session: selection works normally again.
  driver.fire("pointerup", domEvent());
  const after = domEvent();
  driver.fire("selectstart", after);
  assert.equal(after.defaultPrevented, false);
});

test("cancelled mouse save gesture restores normal selection", () => {
  const driver = loadWithDocument();

  driver.fire("pointerdown", domEvent());
  const during = domEvent();
  driver.fire("selectstart", during);
  assert.equal(during.defaultPrevented, true);

  driver.fire("pointercancel", domEvent());
  const after = domEvent();
  driver.fire("selectstart", after);
  assert.equal(after.defaultPrevented, false);
});
