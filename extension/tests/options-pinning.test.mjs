import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
const source=fs.readFileSync(new URL("../options/options.js",import.meta.url),"utf8");
test("pin state persists as one queued radial-state write with path labels",()=>{ assert.match(source,/getFirstLevelPinCandidates\(entries, pinnedIds\)/); assert.match(source,/type: "radial-state:set"/); assert.match(source,/pinnedPersistQueue = pinnedPersistQueue\.then/); assert.match(source,/classificationPathLabel\(entry\)/); });
