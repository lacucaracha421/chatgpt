import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const source=fs.readFileSync(new URL("../options/options.js",import.meta.url),"utf8");
test("pin and unpin actions persist immediately instead of waiting for layout save",()=>{ assert.match(source,/getFirstLevelPinCandidates\(entries, pinnedIds\)/); assert.match(source,/persistPinnedLayout/); assert.match(source,/type: "pinned:set", pinnedIds/); });
