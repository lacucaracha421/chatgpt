// Pure report math, shared by offline tests and the live driver. No app access.
export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}
export function frameStats(deltas, budgetMs = 1000 / 60) {
  if (!(budgetMs > 0)) throw new Error('frame budget must be positive');
  const values = deltas.filter(n => Number.isFinite(n) && n > 0);
  return { count: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95),
    maxMs: values.length ? Math.max(...values) : null, budgetMs,
    jankCount: values.length ? values.filter(n => n > budgetMs * 1.5).length : null };
}
export function parseProcStat(text, pageSize = 4096) {
  // comm may contain spaces and closing parentheses. Fields after its final ')' start at state (3).
  const end = text.lastIndexOf(')');
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const f = text.slice(end + 1).trim().split(/\s+/);
  const result = { pid, ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]),
    startTicks: Number(f[19]), rssBytes: Number(f[21]) * pageSize };
  if (end < 0 || f.length < 22 || Object.values(result).some(n => !Number.isFinite(n))) throw new Error('invalid /proc stat');
  return result;
}
export function processInterval(before, after, clockTicks) {
  const elapsed = after.atMs - before.atMs;
  if (!(elapsed > 0 && clockTicks > 0)) throw new Error('invalid sampling interval');
  let ticks = 0;
  for (const current of after.processes) {
    const previous = before.processes.find(p => p.pid === current.pid && p.startTicks === current.startTicks);
    // New processes start at zero, exited processes are unavailable; sampling undercounts short-lived children.
    ticks += Math.max(0, current.ticks - (previous?.ticks ?? 0));
  }
  return { atMs: after.atMs, elapsedMs: elapsed, cpuPercent: ticks / clockTicks / (elapsed / 1000) * 100,
    rssBytes: after.processes.reduce((sum, p) => sum + p.rssBytes, 0), processes: after.processes.length };
}
export function baselineDiff(current, baseline) {
  const out = [];
  function walk(now, old, path) {
    if (typeof now === 'number' && Number.isFinite(now) && typeof old === 'number' && Number.isFinite(old)) {
      out.push({ metric: path, before: old, after: now, delta: now - old,
        percent: old === 0 ? null : (now - old) / Math.abs(old) * 100 });
    } else if (now && old && typeof now === 'object' && typeof old === 'object' && !Array.isArray(now)) {
      for (const key of Object.keys(now)) if (Object.hasOwn(old, key)) walk(now[key], old[key], path ? `${path}.${key}` : key);
    }
  }
  walk(current, baseline, '');
  return out;
}
export function summarizeScenario(row, frameBudgetMs) {
  const samples = row.processSamples ?? [];
  const seconds = samples.reduce((sum, x) => sum + x.elapsedMs, 0);
  return { durationMs: row.durationMs ?? null, hostDurationMs: row.hostDurationMs ?? null,
    frames: frameStats(row.frames ?? [], frameBudgetMs),
    longTasks: row.longTasksSupported ? { count: row.longTasks.length, totalMs: row.longTasks.reduce((sum, x) => sum + x.duration, 0) } : null,
    heapBytes: row.heapBytes ?? null,
    process: { sampleCount: samples.length, cpuMeanPercent: seconds ? samples.reduce((sum, x) => sum + x.cpuPercent * x.elapsedMs, 0) / seconds : null,
      cpuP95Percent: percentile(samples.map(x => x.cpuPercent), .95), rssPeakBytes: samples.length ? Math.max(...samples.map(x => x.rssBytes)) : null } };
}
const fmt = x => x == null ? 'n/a' : Number(x).toFixed(2);
export function buildReport(recording, baseline) {
  if (recording.version !== 1 || !Array.isArray(recording.scenarios)) throw new Error('invalid recording version/scenarios');
  const metrics = Object.fromEntries(recording.scenarios.map(row => [row.id, summarizeScenario(row, recording.frameBudgetMs)]));
  const before = baseline?.metrics ?? (baseline ? buildReport(baseline).metrics : null);
  if (baseline && baseline.frameBudgetMs !== recording.frameBudgetMs) throw new Error('baseline frame budget differs');
  const comparable = Object.fromEntries(Object.entries(metrics).filter(([id]) => !recording.scenarios.find(row => row.id === id)?.error && !baseline?.scenarios?.find(row => row.id === id)?.error));
  const deltas = before ? baselineDiff(comparable, before) : [];
  const lines = ['# Native performance measurement', '', `Evidence: ${recording.evidence ?? 'native WebView'}. CPU is app + descendant processes, 100% = one core; RSS sums shared pages.`, '',
    '| Scenario | Result | WebView ms | Host ms | Frame p50/p95 ms | Jank | CPU mean % | RSS peak MiB | Long tasks | Heap MiB |', '|---|---|---:|---:|---|---:|---:|---:|---:|---:|'];
  for (const row of recording.scenarios) {
    const m = metrics[row.id];
    lines.push(`| ${row.id} | ${row.error ? `FAILED: ${row.error.replaceAll('|', '/')}` : 'ok'} | ${fmt(m.durationMs)} | ${fmt(m.hostDurationMs)} | ${fmt(m.frames.p50Ms)}/${fmt(m.frames.p95Ms)} | ${m.frames.jankCount ?? "n/a"} | ${fmt(m.process.cpuMeanPercent)} | ${fmt(m.process.rssPeakBytes == null ? null : m.process.rssPeakBytes / 1048576)} | ${m.longTasks?.count ?? "n/a"} | ${fmt(m.heapBytes == null ? null : m.heapBytes / 1048576)} |`);
  }
  if (before) {
    lines.push('', '## Baseline deltas (after minus before; descriptive, not pass/fail)', '', '| Metric | Before | After | Delta | % |', '|---|---:|---:|---:|---:|');
    for (const d of deltas) lines.push(`| ${d.metric} | ${fmt(d.before)} | ${fmt(d.after)} | ${fmt(d.delta)} | ${fmt(d.percent)} |`);
    const missing = Object.keys(before).filter(id => !Object.hasOwn(metrics, id));
    const added = Object.keys(metrics).filter(id => !Object.hasOwn(before, id));
    lines.push('', `Unmatched scenarios: removed=${missing.join(', ') || 'none'}; added=${added.join(', ') || 'none'}.`);
  }
  return { ...recording, metrics, deltas, markdown: lines.join('\n') + '\n' };
}
