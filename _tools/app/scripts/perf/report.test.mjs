import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeasurements, compareResults, compactTable } from './report.mjs';
const row = { commits: 2, profilerActualMs: 1, renders: { App: 2 }, gateway: { list: 3 }, invoke: {} };
test('parses labels with spaces, rejects empty/duplicate logs', () => {
  const log = `noise\nPERF scene (2 steps) ${JSON.stringify(row)}\nnoise`;
  assert.deepEqual(parseMeasurements(log), { 'scene (2 steps)': row });
  assert.throws(() => parseMeasurements(''), /No PERF/);
  assert.throws(() => parseMeasurements(log + '\n' + log), /duplicate/);
  assert.match(compactTable({ scene: row }), /scene \| 2 \| 2 \| 3 \| 0 \| 1/);
});
test('missing counters compare as zero, missing scenarios do not', () => {
  const diff = compareResults({ scene: { ...row, gateway: {} } }, { scene: row, removed: row });
  assert.equal(diff.find(x => x.metric === 'scene.gateway.list').delta, -3);
  assert.ok(!diff.some(x => x.metric.startsWith('removed')));
});
