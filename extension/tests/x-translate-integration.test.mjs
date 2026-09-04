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

test("OpenRouter translation hardens malformed JSON responses", () => {
  assert.match(source, /type: 'json_schema'/);
  assert.match(source, /OPENROUTER_FORMAT_RETRY/);
  assert.match(source, /OPENROUTER_FORMAT_MODEL_FALLBACK/);
  assert.match(source, /OPENROUTER_FORMAT_SPLIT/);
  assert.match(source, /openRouterStructuredOutputRejected/);
  assert.doesNotMatch(source, /state\.openRouterModelCooldowns/);
});

test("settings keep common controls visible and rare recovery tools collapsed", () => {
  assert.match(optionsHtml, /id="x-translate-enabled"/);
  assert.match(optionsHtml, /<details class="advanced-block">/);
  assert.doesNotMatch(optionsHtml, /id="touch-persistent"/);
  assert.doesNotMatch(optionsHtml, /id="suppress-context-menu"/);
  assert.match(optionsHtml, /id="save-mode"/);
});


test("server portability controls replace plaintext JSON backup", () => {
  assert.match(optionsHtml, /id="push-portable-backup"/);
  assert.match(optionsHtml, /id="restore-portable-backup"/);
  assert.match(optionsHtml, /AES-GCM/);
  assert.doesNotMatch(optionsHtml, /id="connection-backup-json"/);
});


test("radial settings switch targets directly without hierarchical enter/back navigation", () => {
  const optionsJs = fs.readFileSync(new URL("../options/options.js", import.meta.url), "utf8");
  assert.match(optionsJs, /radial-editor-target/);
  assert.match(optionsJs, /activeEditorParentId/);
  assert.doesNotMatch(optionsJs, /function openSelected/);
  assert.doesNotMatch(optionsJs, /selectedHasChildren/);
  assert.doesNotMatch(optionsJs, /path\.pop/);
});

test("translator FAB explicitly closes an already-open panel", () => {
  assert.match(source, /if \(ui\.panel\.classList\.contains\('open'\)\) \{\s*ui\.panel\.classList\.remove\('open'\);\s*return;/);
});
