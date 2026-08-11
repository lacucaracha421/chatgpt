import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/options-connection.js", import.meta.url), "utf8");
const optionsHtml = fs.readFileSync(new URL("../options/options.html", import.meta.url), "utf8");

test("connection form has one unambiguous submit action", () => {
  assert.equal(optionsHtml.includes('id="save-token"'), false);
  assert.equal(optionsHtml.includes('id="refresh-classifications"'), true);
  assert.equal(optionsHtml.includes("저장하고 연결"), true);
});

test("connection check saves a typed key before refreshing", async () => {
  const messages = [];
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "options-connection.js" });

  const response = await context.LakomicsOptionsConnection.saveAndRefresh(
    async (message) => {
      messages.push(message);
      return message.type === "settings:set-token" ? { ok: true } : { ok: true, entries: [] };
    },
    " 0123456789abcdef0123456789abcdef ",
  );

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: "settings:set-token", token: "0123456789abcdef0123456789abcdef" },
    { type: "classifications:refresh" },
  ]);
  assert.equal(response.ok, true);
});

test("invalid typed keys stop before refresh", async () => {
  const messages = [];
  const context = { globalThis: null };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "options-connection.js" });

  const response = await context.LakomicsOptionsConnection.saveAndRefresh(
    async (message) => {
      messages.push(message);
      return { ok: false, code: "invalid_connection_key" };
    },
    "wrong",
  );

  assert.equal(response.code, "invalid_connection_key");
  assert.equal(messages.length, 1);
});
