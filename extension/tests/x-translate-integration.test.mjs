import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const source = fs.readFileSync(new URL("../src/x-translate.js", import.meta.url), "utf8");
const optionsHtml = fs.readFileSync(new URL("../options/options.html", import.meta.url), "utf8");

test("manifest loads integrated X Translate at document_start with required API hosts", () => {
  const script = manifest.content_scripts.find((entry) => entry.js?.includes("src/x-translate.js"));
  assert.ok(script);
  assert.equal(script.run_at, "document_start");
  for (const host of [
    "https://openrouter.ai/*",
    "https://ollama.com/*",
    "https://generativelanguage.googleapis.com/*",
    "https://ai-gateway.vercel.sh/*",
  ]) assert.ok(manifest.host_permissions.includes(host));
});

test("integrated translator is based on AI X Translate Lite v1.4.14 OpenRouter", () => {
  assert.match(source, /@version\s+1\.4\.14/);
  assert.match(source, /OPENROUTER_BASE_URL = 'https:\/\/openrouter\.ai\/api\/v1'/);
  assert.match(source, /provider: 'openrouter'/);
  assert.match(source, /qwen\/qwen3\.5-flash-02-23/);
  assert.doesNotMatch(source, /chrome\.storage\.local\.get\(null/);
  assert.match(source, /const GM_KEYS = \[/);
});

test("settings keep common controls visible and rare recovery tools collapsed", () => {
  assert.match(optionsHtml, /id="x-translate-enabled"/);
  assert.match(optionsHtml, /<details class="advanced-block">/);
  assert.doesNotMatch(optionsHtml, /id="touch-persistent"/);
  assert.doesNotMatch(optionsHtml, /id="suppress-context-menu"/);
  assert.doesNotMatch(optionsHtml, /id="save-mode"/);
});


test("translator FAB explicitly closes an already-open panel", () => {
  assert.match(source, /if \(ui\.panel\.classList\.contains\('open'\)\) \{\s*ui\.panel\.classList\.remove\('open'\);\s*return;/);
});
