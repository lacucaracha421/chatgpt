import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("../options/options.js", import.meta.url), "utf8");

test("secondary donut settings expose usage ordering and hide/reveal controls", () => {
  assert.match(source, /secondary-presentation:get/);
  assert.match(source, /secondary-presentation:set-hidden/);
  assert.match(source, /2차 도넛 자동 정렬 · 숨김/);
  assert.match(source, /toggle\.textContent = isHidden \? "다시 표시" : "숨기기"/);
  assert.match(source, /adaptiveSecondaryLayout\(/);
});
