import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMeasurements, compactTable, compareResults } from './report.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help') { console.log('node scripts/perf/run.mjs [--out result.json] [--baseline result.json] [--log vitest.log]'); process.exit(0); }
  if (!['--out', '--baseline', '--log'].includes(arg) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`invalid option: ${arg}`);
  options[arg.slice(2)] = process.argv[++i];
}
const baseline = options.baseline ? JSON.parse(readFileSync(options.baseline, 'utf8')) : null;
if (baseline && (baseline.version !== 1 || baseline.quiet !== (process.env.LAKOMICS_PERF_QUIET === '1'))) throw new Error('baseline version/quiet mode differs');
let log, exitCode = 0;
if (options.log) log = readFileSync(options.log, 'utf8');
else {
  const temporary = mkdtempSync(join(tmpdir(), 'lakomics-perf-'));
  const logPath = join(temporary, 'vitest.log');
  const fd = openSync(logPath, 'w');
  const run = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'src/app/App.perf.test.tsx', '--silent=false', '--reporter=verbose', '--maxWorkers=1'],
    { cwd: root, env: { ...process.env, LAKOMICS_PERF: '1' }, encoding: 'utf8', stdio: ['ignore', fd, fd] });
  closeSync(fd);
  log = readFileSync(logPath, 'utf8');
  rmSync(temporary, { recursive: true });
  exitCode = run.status ?? 1;
  if (run.error) { console.error(run.error.message); process.exit(1); }
  if (exitCode) console.error(log);
}
const results = parseMeasurements(log);
const report = { version: 1, evidence: 'jsdom, fake time, mocked IPC; commits are not paint or latency',
  testExitCode: options.log ? null : exitCode, quiet: process.env.LAKOMICS_PERF_QUIET === '1', results,
  deltas: baseline ? compareResults(results, baseline.results) : [] };
console.log(compactTable(results));
if (baseline) {
  console.log('\nBefore/after deltas (after minus before):');
  for (const d of report.deltas.filter(d => d.delta !== 0)) console.log(`${d.metric}: ${d.before} -> ${d.after} (${d.delta > 0 ? '+' : ''}${d.delta}; ${d.percent == null ? 'n/a' : d.percent.toFixed(1) + '%'})`);
  console.log(`Missing scenarios: ${Object.keys(baseline.results).filter(k => !results[k]).join(', ') || 'none'}`);
  console.log(`New scenarios: ${Object.keys(results).filter(k => !baseline.results[k]).join(', ') || 'none'}`);
}
if (options.out) writeFileSync(options.out, JSON.stringify(report, null, 2) + '\n');
process.exitCode = exitCode;
