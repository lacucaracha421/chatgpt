import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const finite = value => typeof value === 'number' && Number.isFinite(value);
export function parseTimingLog(text) {
  const rows = []; let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || typeof row.launchId !== 'string' || !row.launchId) { malformed++; continue; }
      rows.push(row);
    } catch { malformed++; }
  }
  return { rows, malformed };
}
export function statistics(values, cancelled = 0) {
  const sorted = values.filter(value => finite(value) && value >= 0).sort((a, b) => a - b);
  const count = sorted.length;
  return { count, median: count ? (sorted[Math.floor((count - 1) / 2)] + sorted[Math.floor(count / 2)]) / 2 : null,
    p90: count ? sorted[Math.ceil(count * .9) - 1] : null, min: count ? sorted[0] : null, max: count ? sorted[count - 1] : null, cancelled };
}
function point(points, name, at, clock) {
  const entry = points[name] ?? { count: 0, firstMs: null, clock };
  entry.count++;
  if (finite(at) && (entry.firstMs === null || at < entry.firstMs)) entry.firstMs = at;
  points[name] = entry;
}
export function summarize(rows) {
  const launches = new Map(), metrics = new Map();
  function add(target, name, duration, cancelled) {
    const metric = target.get(name) ?? { values: [], cancelled: 0 };
    if (cancelled) metric.cancelled++; else if (finite(duration) && duration >= 0) metric.values.push(duration);
    target.set(name, metric);
  }
  for (const row of rows) {
    const launch = launches.get(row.launchId) ?? { launchId: row.launchId, metrics: new Map(), milestones: {}, inputs: {}, points: {}, processStartUnixMs: null, timeOrigin: null };
    launches.set(row.launchId, launch);
    if (row.event === 'native' && finite(row.processStartUnixMs)) launch.processStartUnixMs = row.processStartUnixMs;
    if (finite(row.timeOrigin)) launch.timeOrigin = row.timeOrigin;
    if (row.event === 'startup' && typeof row.name === 'string' && finite(row.startMs)) launch.milestones[row.name] = row.startMs;
    let name, duration = row.durationMs, cancelled = row.status === 'cancelled';
    if (row.event === 'native-startup' && typeof row.name === 'string') {
      const fields = row.fields && typeof row.fields === 'object' ? row.fields : {};
      const timed = finite(fields.durationMs) ? fields.durationMs : finite(fields.serveMs) ? fields.serveMs : null;
      if (timed !== null) {
        name = row.name === 'ipc.dispatch' && typeof fields.command === 'string' ? `native.ipc.dispatch.${fields.command}` : `native.${row.name}`;
        duration = timed; cancelled = false;
      } else point(launch.points, `native.${row.name}`, row.processMs, 'process');
    } else if (row.event === 'startup-detail' && typeof row.name === 'string') {
      if (row.name.endsWith('.reply') && finite(row.durationMs)) { name = `startup-read.${row.name.slice(0, -6)}`; cancelled = row.status === 'error'; }
      else point(launch.points, `detail.${row.name}`, row.startMs, 'frontend');
    } else if (row.event === 'startup-input' && typeof row.name === 'string' && finite(row.startMs)) {
      launch.inputs[row.name] = Math.min(launch.inputs[row.name] ?? Infinity, row.startMs);
    } else if (row.event === 'interaction' && typeof row.name === 'string' && ['ok', 'cancelled'].includes(row.status)) name = `${row.name}.${row.label}`;
    else if (row.event === 'measure' && typeof row.name === 'string' && row.name.startsWith('w4:')) name = row.name.slice(3);
    if (name) {
      if (row.event === 'interaction' && row.name === 'startup') name = 'startup.process-to-home';
      add(metrics, name, duration, cancelled);
      add(launch.metrics, name, duration, cancelled);
    }
  }
  const stats = map => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)).map(([name, metric]) => [name, statistics(metric.values, metric.cancelled)]));
  const result = [...launches.values()].map(launch => {
    const milestones = Object.fromEntries(Object.entries(launch.milestones).map(([name, startMs]) => [name, { startMs,
      processMs: finite(launch.processStartUnixMs) && finite(launch.timeOrigin) ? launch.timeOrigin + startMs - launch.processStartUnixMs : null }]));
    const startupMs = milestones.homeFullyShown?.processMs;
    if (finite(startupMs) && startupMs >= 0) { add(metrics, 'startup.process-to-home', startupMs, false); add(launch.metrics, 'startup.process-to-home', startupMs, false); }
    const sorted = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
    return { ...launch, metrics: stats(launch.metrics), milestones, inputs: sorted(launch.inputs), points: sorted(launch.points) };
  });
  return { metrics: stats(metrics), launches: result };
}
export function timingTable(summary) {
  const ms = value => value === null ? '-' : value.toFixed(2);
  const table = metrics => [
    'Metric | count | median ms | p90 ms | min ms | max ms | cancelled',
    '--- | ---: | ---: | ---: | ---: | ---: | ---:',
    ...Object.entries(metrics).map(([name, stat]) => `${name} | ${stat.count} | ${ms(stat.median)} | ${ms(stat.p90)} | ${ms(stat.min)} | ${ms(stat.max)} | ${stat.cancelled}`),
  ];
  const lines = ['All launches', ...table(summary.metrics)];
  for (const launch of summary.launches) {
    lines.push(`\nLaunch ${launch.launchId}`, ...table(launch.metrics), '', 'Startup milestone | frontend ms | process ms', '--- | ---: | ---:');
    for (const [name, value] of Object.entries(launch.milestones).sort(([, a], [, b]) => a.startMs - b.startMs)) lines.push(`${name} | ${ms(value.startMs)} | ${ms(value.processMs)}`);
    if (Object.keys(launch.inputs ?? {}).length) {
      lines.push('', 'Startup input ready | frontend ms', '--- | ---:');
      for (const [name, at] of Object.entries(launch.inputs).sort(([, a], [, b]) => a - b)) lines.push(`${name} | ${ms(at)}`);
    }
    if (Object.keys(launch.points ?? {}).length) {
      lines.push('', 'Startup point | count | first ms | clock', '--- | ---: | ---: | ---');
      for (const [name, entry] of Object.entries(launch.points)) lines.push(`${name} | ${entry.count} | ${ms(entry.firstMs)} | ${entry.clock}`);
    }
  }
  return lines.join('\n');
}
export async function main(args) {
  const files = []; let output;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') { output = args[++i]; if (!output || output.startsWith('--')) throw new Error('--json needs an output path'); }
    else if (args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`);
    else files.push(args[i]);
  }
  if (!files.length) throw new Error('Usage: node pc-timing-summary.mjs <log.jsonl> [more.jsonl] [--json out.json]');
  const rows = []; let malformed = 0;
  for (const file of files) { const parsed = parseTimingLog(await readFile(file, 'utf8')); rows.push(...parsed.rows); malformed += parsed.malformed; }
  if (!rows.length) throw new Error('No timing rows with a launchId');
  const summary = { ...summarize(rows), malformed };
  console.log(timingTable(summary));
  if (malformed) console.error(`Skipped ${malformed} malformed/incomplete lines`);
  if (output) await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
