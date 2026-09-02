import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const helperUrl = new URL("../src/options-mobile-access.js", import.meta.url);
const helperSource = fs.existsSync(helperUrl) ? fs.readFileSync(helperUrl, "utf8") : "";
const optionsHtml = fs.readFileSync(new URL("../options/options.html", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

const MOBILE_ORIGIN = "https://lacucaracha421.github.io/*";
const MOBILE_MATCH = "https://lacucaracha421.github.io/chatgpt/*";

function loadHelper() {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(helperSource, context, { filename: "options-mobile-access.js" });
  assert.ok(context.LakomicsMobileAccess, "Mobile access helper must be exposed");
  return context.LakomicsMobileAccess;
}

function permissionHarness({ contains = [], request = [], containsError = null, requestError = null } = {}) {
  const calls = [];
  return {
    calls,
    permissions: {
      async contains(query) {
        calls.push({ type: "contains", query });
        if (containsError) throw containsError;
        return contains.length ? contains.shift() : false;
      },
      async request(query) {
        calls.push({ type: "request", query });
        if (requestError) throw requestError;
        return request.length ? request.shift() : false;
      },
    },
  };
}

test("permissions.contains reports granted host access", async () => {
  const helper = loadHelper();
  const harness = permissionHarness({ contains: [true] });
  assert.equal((await helper.checkMobileAccess(harness.permissions)).state, "granted");
  assert.equal(harness.calls[0].type, "contains");
  assert.deepEqual([...harness.calls[0].query.origins], [MOBILE_ORIGIN]);
});

test("permissions.contains reports withheld host access", async () => {
  const helper = loadHelper();
  const harness = permissionHarness({ contains: [false] });
  assert.equal((await helper.checkMobileAccess(harness.permissions)).state, "needed");
});

test("permissions.contains errors become an unavailable state", async () => {
  const helper = loadHelper();
  const harness = permissionHarness({ containsError: new Error("unsupported") });
  assert.equal((await helper.checkMobileAccess(harness.permissions)).state, "error");
});

test("permission request is followed by contains and reports granted", async () => {
  const helper = loadHelper();
  const harness = permissionHarness({ request: [true], contains: [true] });
  assert.equal((await helper.requestMobileAccess(harness.permissions)).state, "granted");
  assert.deepEqual(harness.calls.map((call) => call.type), ["request", "contains"]);
});

test("permission request denial is confirmed by contains", async () => {
  const helper = loadHelper();
  const harness = permissionHarness({ request: [false], contains: [false] });
  assert.equal((await helper.requestMobileAccess(harness.permissions)).state, "needed");
  assert.deepEqual(harness.calls.map((call) => call.type), ["request", "contains"]);
});

test("permission request errors still recheck contains and report unsupported", async () => {
  const helper = loadHelper();
  const harness = permissionHarness({ requestError: new Error("runtime error"), contains: [false] });
  assert.equal((await helper.requestMobileAccess(harness.permissions)).state, "error");
  assert.deepEqual(harness.calls.map((call) => call.type), ["request", "contains"]);
});

test("only the exact Mobile GitHub Pages origin is requested", async () => {
  const helper = loadHelper();
  const harness = permissionHarness({ request: [true], contains: [true] });
  await helper.requestMobileAccess(harness.permissions);
  const origins = harness.calls.flatMap((call) => call.query.origins || []);
  assert.deepEqual(origins, [MOBILE_ORIGIN, MOBILE_ORIGIN]);
  assert.equal(origins.includes("<all_urls>"), false);
});

test("options UI and existing Mobile content-script match remain present", () => {
  assert.match(optionsHtml, /id="mobile-site-access"/);
  assert.match(optionsHtml, /사이트 접근 권한/);
  assert.match(optionsHtml, /Mobile Lakomics 열기/);
  assert.ok(manifest.host_permissions.includes(MOBILE_ORIGIN));
  assert.ok(manifest.content_scripts.some((entry) => entry.matches.includes(MOBILE_MATCH)));
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
});
