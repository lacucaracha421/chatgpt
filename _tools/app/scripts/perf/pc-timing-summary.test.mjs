import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTimingLog, statistics, summarize, timingTable, main } from './pc-timing-summary.mjs';

test('statistics exclude cancellations and report nearest-rank p90', () => {
  assert.deepEqual(statistics([10, 20, 30, 40], 2), { count: 4, median: 25, p90: 40, min: 10, max: 40, cancelled: 2 });
  assert.deepEqual(statistics([], 1), { count: 0, median: null, p90: null, min: null, max: null, cancelled: 1 });
});
test('groups launches, aligns frontend milestones, tolerates a partial final write', () => {
  const parsed = parseTimingLog([
    {launchId:'a',event:'native',processStartUnixMs:1000},
    {launchId:'a',event:'startup',name:'homeFullyShown',timeOrigin:1100,startMs:200},
    {launchId:'a',event:'interaction',name:'tab.switch',label:'home',status:'ok',durationMs:90},
    {launchId:'b',event:'interaction',name:'tab.switch',label:'home',status:'cancelled',durationMs:1},
    {launchId:'b',event:'measure',name:'w4:collections.query.done',durationMs:5},
  ].map(JSON.stringify).join('\n') + '\n{"partial":');
  assert.equal(parsed.malformed, 1);
  const summary = summarize(parsed.rows);
  assert.equal(summary.launches.length, 2);
  assert.equal(summary.metrics['tab.switch.home'].median, 90);
  assert.equal(summary.metrics['tab.switch.home'].cancelled, 1);
  assert.equal(summary.metrics['startup.process-to-home'].median, 300);
  assert.equal(summary.launches[1].metrics['tab.switch.home'].count, 0);
  assert.match(timingTable(summary), /homeFullyShown \| 200.00 \| 300.00/);
});
test('CLI accepts multiple files and writes JSON using the same report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pc-timing-'));
  try {
    const files = [join(directory, 'a.jsonl'), join(directory, 'b.jsonl')], out = join(directory, 'out.json');
    for (const [index, file] of files.entries()) await writeFile(file, JSON.stringify({ launchId: String(index), event:'measure', name:'w4:test.done', durationMs: index + 1 }) + '\n');
    let stdout = '';
    const original = console.log;
    try {
      console.log = value => { stdout += value; };
      await main([...files, '--json', out]);
    } finally { console.log = original; }
    assert.match(stdout, /test.done \| 2 \| 1.50/);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).launches.length, 2);
  } finally { await rm(directory, { recursive:true, force:true }); }
});
test('summarizes native-startup, startup-detail reads, startup inputs and viewer/work interactions', () => {
  const summary = summarize(parseTimingLog([
    { launchId: 'a', event: 'native-startup', name: 'db.open', processMs: 40, fields: { durationMs: 12.5, line: 1 } },
    { launchId: 'a', event: 'native-startup', name: 'ipc.dispatch', processMs: 50, fields: { command: 'list_collections', durationMs: 3 } },
    { launchId: 'a', event: 'native-startup', name: 'media.response', processMs: 60, fields: { serveMs: 7 } },
    { launchId: 'a', event: 'native-startup', name: 'launch.maintenance.ready', processMs: 900, fields: {} },
    { launchId: 'a', event: 'startup-detail', name: 'home.media.issued', startMs: 100 },
    { launchId: 'a', event: 'startup-detail', name: 'home.media.reply', startMs: 160, durationMs: 60, status: 'ok' },
    { launchId: 'a', event: 'startup-detail', name: 'home.media.reply', startMs: 200, durationMs: 5, status: 'error' },
    { launchId: 'a', event: 'startup-input', name: 'home.shelf', startMs: 300 },
    { launchId: 'a', event: 'startup-input', name: 'home.shelf', startMs: 250 },
    { launchId: 'a', event: 'interaction', name: 'viewer.open', label: 'full-res-visible', status: 'ok', durationMs: 120 },
    { launchId: 'a', event: 'interaction', name: 'viewer.open', label: 'first-visible', status: 'cancelled', durationMs: 1 },
    { launchId: 'a', event: 'interaction', name: 'collections.work', label: 'open', status: 'ok', durationMs: 80 },
  ].map(JSON.stringify).join('\n')).rows);
  assert.equal(summary.metrics['native.db.open'].median, 12.5);
  assert.equal(summary.metrics['native.ipc.dispatch.list_collections'].median, 3);
  assert.equal(summary.metrics['native.media.response'].median, 7);
  assert.equal(summary.metrics['startup-read.home.media'].count, 1);
  assert.equal(summary.metrics['startup-read.home.media'].cancelled, 1);
  assert.equal(summary.metrics['viewer.open.full-res-visible'].median, 120);
  assert.equal(summary.metrics['viewer.open.first-visible'].cancelled, 1);
  assert.equal(summary.metrics['collections.work.open'].median, 80);
  const launch = summary.launches[0];
  assert.equal(launch.inputs['home.shelf'], 250);
  assert.deepEqual(launch.points['native.launch.maintenance.ready'], { count: 1, firstMs: 900, clock: 'process' });
  assert.equal(launch.points['detail.home.media.issued'].firstMs, 100);
  const table = timingTable(summary);
  assert.match(table, /home.shelf \| 250.00/);
  assert.match(table, /native.launch.maintenance.ready \| 1 \| 900.00 \| process/);
});
