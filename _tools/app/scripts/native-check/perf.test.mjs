import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frameStats, parseProcStat, processInterval, baselineDiff, buildReport } from './perf-stats.mjs';
import { parseArgs, validateScenarios } from './perf-cli.mjs';
test('frame nearest-rank percentiles and explicit jank budget', () => {
  assert.deepEqual(frameStats([10, 20, 30, 40, NaN, -1], 20), { count: 4, p50Ms: 20, p95Ms: 40, maxMs: 40, budgetMs: 20, jankCount: 1 });
  assert.equal(frameStats([]).p95Ms, null);
  assert.equal(frameStats([]).jankCount, null);
  assert.throws(() => frameStats([1], 0));
});
test('/proc comm may contain spaces/parentheses; uses utime+stime and RSS pages', () => {
  const fields = Array(22).fill('0');
  fields[0] = 'S'; fields[1] = '12'; fields[11] = '100'; fields[12] = '50'; fields[19] = '99'; fields[21] = '20';
  assert.deepEqual(parseProcStat(`42 (WebKit ) content) ${fields.join(' ')}`, 8192), { pid: 42, ppid: 12, ticks: 150, startTicks: 99, rssBytes: 163840 });
  assert.throws(() => parseProcStat('broken'));
});
test('CPU is elapsed-normalized, one core = 100%; PID reuse cannot subtract old ticks', () => {
  const p = { pid: 1, startTicks: 1, ticks: 10, rssBytes: 20 };
  assert.equal(processInterval({ atMs: 0, processes: [p] }, { atMs: 500, processes: [{ ...p, ticks: 35 }] }, 100).cpuPercent, 50);
  assert.equal(processInterval({ atMs: 0, processes: [p] }, { atMs: 500, processes: [{ ...p, startTicks: 2, ticks: 5 }] }, 100).cpuPercent, 10);
});
test('baseline zero has no percentage and missing values are not treated as zero', () => {
  assert.deepEqual(baselineDiff({ n: 3, unsupported: null, added: 1 }, { n: 0, unsupported: 2 }), [{ metric: 'n', before: 0, after: 3, delta: 3, percent: null }]);
});
test('offline report preserves failures and unsupported metrics', () => {
  const record = { version: 1, frameBudgetMs: 16.667, scenarios: [{ id: 'idle', durationMs: 60000, frames: [], longTasksSupported: false, processSamples: [], error: 'hidden unavailable' }] };
  const result = buildReport(record, record);
  assert.equal(result.metrics.idle.longTasks, null);
  assert.equal(result.metrics.idle.process.cpuMeanPercent, null);
  assert.match(result.markdown, /FAILED: hidden unavailable/);
  assert.match(result.markdown, /Baseline deltas/);
  assert.throws(() => buildReport(record, { ...record, frameBudgetMs: 8.33 }), /budget differs/);
});
test('CLI accepts offline sample/baseline and rejects typos/missing args', () => {
  assert.equal(parseArgs(['--perf', 'scenarios.json', '/tmp/out', '--sample', 'sample.json']).sample, 'sample.json');
  assert.throws(() => parseArgs(['--perf', 'a', 'b', '--baseline']));
  assert.throws(() => parseArgs(['--pef', 'a', 'b']));
  assert.throws(() => parseArgs(['a', 'b', '--sample', 'c']));
});
test('complete shipped scenario list validates, fails closed on unrecognized steps', () => {
  const config = JSON.parse(readFileSync(new URL('./scenarios/perf-all.json', import.meta.url)));
  assert.equal(validateScenarios(config).scenarios.length, 11);
  assert.throws(() => validateScenarios({ ...config, scenarios: [{ id: 'x', steps: [{ typo: true }] }] }));
});
