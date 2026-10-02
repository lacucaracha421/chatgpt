import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseProcStat, processInterval } from './perf-stats.mjs';

// Restrict to this driver's descendants and the exact test executable; never pgrep all user apps.
export function createSampler(driverPid, appPath) {
  const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
  const pageSize = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }));
  const read = () => {
    const rows = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try { rows.push(parseProcStat(readFileSync(`/proc/${entry}/stat`, 'utf8'), pageSize)); } catch { /* Process exited. */ }
    }
    const descendants = new Set([driverPid]);
    let changed = true;
    while (changed) { changed = false; for (const p of rows) if (descendants.has(p.ppid) && !descendants.has(p.pid)) { descendants.add(p.pid); changed = true; } }
    const appPids = new Set();
    for (const p of rows) if (descendants.has(p.pid)) {
      try { if (readlinkSync(`/proc/${p.pid}/exe`) === appPath) appPids.add(p.pid); } catch { /* exited */ }
    }
    changed = true;
    while (changed) { changed = false; for (const p of rows) if (appPids.has(p.ppid) && !appPids.has(p.pid)) { appPids.add(p.pid); changed = true; } }
    return { atMs: performance.now(), processes: rows.filter(p => appPids.has(p.pid)) };
  };
  let previous = read();
  const samples = [];
  const tick = () => { const current = read(); samples.push(processInterval(previous, current, clockTicks)); previous = current; };
  const timer = setInterval(tick, 250);
  let stopped = false;
  return { samples, read, reset() { samples.length = 0; previous = read(); }, stop() { if (!stopped) { stopped = true; clearInterval(timer); tick(); } return samples; } };
}
