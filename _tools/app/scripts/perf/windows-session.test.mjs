import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, selfTest, summarizeProfile } from './windows-session.mjs';

test('built-in fixtures parse and summarize', () => {
  assert.equal(selfTest(), 'self-test ok');
});
test('arguments are validated', () => {
  assert.equal(parseArgs([]).port, 9222);
  assert.throws(() => parseArgs(['--seconds', '0']));
  assert.throws(() => parseArgs(['--out']));
});
test('a profile with only idle samples reports no busy functions', () => {
  const profile = { nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2] }, { id: 2, callFrame: { functionName: '(idle)', url: '' }, children: [] }], samples: [2, 2], timeDeltas: [500, 500, 500] };
  const summary = summarizeProfile(profile);
  assert.equal(summary.busyMs, 0);
  assert.deepEqual(summary.top, []);
});
