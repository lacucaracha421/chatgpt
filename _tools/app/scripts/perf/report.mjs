import { baselineDiff } from '../native-check/perf-stats.mjs';
export function parseMeasurements(log) {
  const results = {};
  for (const line of log.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const match = line.match(/^PERF (.+) (\{.*\})\s*$/);
    if (!match) continue;
    if (Object.hasOwn(results, match[1])) throw new Error(`duplicate measurement: ${match[1]}`);
    const row = JSON.parse(match[2]);
    if (match[1] === 'thumbnail-scroll-back' && Number.isInteger(row.mounts) && Number.isInteger(row.unversioned)) { results[match[1]] = row; continue; }
    if (!Number.isInteger(row.commits) || row.commits < 0 || !row.gateway || !row.renders || !row.invoke) throw new Error(`invalid measurement: ${match[1]}`);
    results[match[1]] = row;
  }
  if (!Object.keys(results).length) throw new Error('No PERF results. Set LAKOMICS_PERF=1 and --silent=false.');
  return results;
}
export function compactTable(results) {
  const sum = values => Object.values(values).reduce((a, b) => a + b, 0);
  return ['Scenario | commits | probe calls | gateway calls | IPC calls | Profiler ms (diagnostic)',
    ...Object.entries(results).map(([label, row]) => `${label} | ${row.commits ?? "n/a"} | ${sum(row.renders ?? {})} | ${sum(row.gateway ?? {})} | ${sum(row.invoke ?? {})} | ${row.profilerActualMs ?? "n/a"}`)].join('\n');
}
export function compareResults(results, baseline) {
  // Absent counter keys mean zero calls; absent scenarios mean missing coverage, not a zero-cost win.
  const normalize = (rows, other) => Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, {
    ...row, ...Object.fromEntries(['renders', 'gateway', 'invoke'].map(group => [group,
      Object.fromEntries([...new Set([...Object.keys(row[group] ?? {}), ...Object.keys(other[id]?.[group] ?? {})])].map(key => [key, row[group]?.[key] ?? 0]))]))
  }]));
  return baselineDiff(normalize(results, baseline), normalize(baseline, results));
}
