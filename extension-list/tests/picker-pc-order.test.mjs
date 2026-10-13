import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Execute the actual Rust-generated window probe with fake storage and invoke;
// no browser, running PC window or production library is involved.
const rust = await readFile(new URL('../../_tools/app/src-tauri/src/extension_api/picker.rs', import.meta.url), 'utf8');
const literal = rust.match(/"\(function\(\).*?\)\(\);"/)[0];
const template = JSON.parse(literal).replaceAll('{{', '{').replaceAll('}}', '}');
const folders = [['en', 'Alpha'], ['z', 'Zulu'], ['ko-z', '하늘'], ['ko-a', '가나'], ['quote', '"\n\\']];
function probe(preferences) {
  let answer;
  const script = template.replace('{nonce}', 'test123').replace('{folders}', JSON.stringify(folders));
  runInNewContext(script, { window: {
    localStorage: { getItem: () => JSON.stringify(preferences) },
    __TAURI_INTERNALS__: { invoke: (command, value) => { assert.equal(command, 'report_picker_privacy'); answer = value; } },
  } });
  return answer && JSON.parse(JSON.stringify(answer));
}

test('PC window probe follows saved folder ranks, Korean fallback and pin order', () => {
  const result = probe({ classificationOrderIds: ['z', 'en'], pinnedClassificationIds: ['ko-z', 'z'], nsfwFilter: true });
  const fallback = folders.filter(([id]) => !['z', 'en'].includes(id)).sort((a, b) => a[1].localeCompare(b[1], 'ko')).map(([id]) => id);
  assert.deepEqual(result.orderIds, ['z', 'en', ...fallback]);
  assert.deepEqual(result.pinnedIds, ['ko-z', 'z']);
  assert.equal(result.nonce, 'test123'); assert.equal(result.nsfwFilter, true);
});

test('missing or malformed pin preferences fail soft without changing privacy', () => {
  for (const pins of [undefined, null, 'bad', {}, [null, 3]]) {
    const result = probe({ pinnedClassificationIds: pins, privacyMode: true });
    assert.deepEqual(result.pinnedIds, []); assert.equal(result.privacyMode, true);
    assert.equal(result.orderIds.length, folders.length);
  }
  assert.deepEqual(probe(null).pinnedIds, []);
});
