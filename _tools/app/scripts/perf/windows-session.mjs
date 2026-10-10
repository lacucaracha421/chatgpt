#!/usr/bin/env node
// Whole-experience measurement of an already running Lakomics release build on Windows.
//
// Attaches to the app's WebView2 over the Chrome DevTools Protocol (CDP), then for a fixed
// duration records long tasks, an optional CPU profile, Performance.getMetrics before/after,
// per-second CPU / memory of lakomics.exe and its msedgewebview2.exe children, and (with --scroll)
// requestAnimationFrame frame times while the main grid is scrolled programmatically.
//
// Node >= 22, built-in fetch / WebSocket only. No dependencies. It never launches or stops the app.
// See scripts/perf/README.md ("Windows session") for the exact PowerShell recipe.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 2) => finite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] : null;
const sum = values => values.reduce((total, value) => total + value, 0);

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------
export const USAGE = `Usage: node scripts/perf/windows-session.mjs [options]
  --port <n>               WebView2 remote debugging port (default 9222)
  --seconds <n>            recording length (default 30)
  --cpu-profile            also record a V8 CPU profile (500 us sampling; adds some overhead)
  --save-profile           with --cpu-profile, also write the raw .cpuprofile next to the report
  --scroll                 scroll the main grid programmatically and report frame times
  --scroll-selector <css>  scroller to use (default: first visible .asset-gallery__scroll / .gallery-scroll)
  --scroll-step-px <n>     pixels per step (default 240)
  --scroll-interval-ms <n> time between steps (default 100)
  --process-name <exe>     root process to sample (default lakomics.exe)
  --process-interval-ms <n> pause between process samples (default 1000)
  --target <text>          choose the page whose url or title contains this text
  --powershell <exe>       PowerShell executable for process sampling (default powershell)
  --out <dir>              output directory (default %TEMP%)
  --self-test              run the parsers on built-in fixtures; needs no app
  --help`;

export function parseArgs(argv) {
  const options = {
    port: 9222, seconds: 30, cpuProfile: false, saveProfile: false, scroll: false, scrollSelector: null,
    scrollStepPx: 240, scrollIntervalMs: 100, processName: 'lakomics.exe', processIntervalMs: 1000,
    target: null, powershell: 'powershell', out: process.env.TEMP || tmpdir(), selfTest: false, help: false,
  };
  const number = (name, value, min) => {
    const parsed = Number(value);
    if (value === undefined || !Number.isFinite(parsed) || parsed < min) throw new Error(`${name} needs a number >= ${min}`);
    return parsed;
  };
  const text = (name, value) => {
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--port': options.port = number(arg, argv[++i], 1); break;
      case '--seconds': options.seconds = number(arg, argv[++i], 1); break;
      case '--cpu-profile': options.cpuProfile = true; break;
      case '--save-profile': options.saveProfile = true; break;
      case '--scroll': options.scroll = true; break;
      case '--scroll-selector': options.scrollSelector = text(arg, argv[++i]); break;
      case '--scroll-step-px': options.scrollStepPx = number(arg, argv[++i], 1); break;
      case '--scroll-interval-ms': options.scrollIntervalMs = number(arg, argv[++i], 16); break;
      case '--process-name': options.processName = text(arg, argv[++i]); break;
      case '--process-interval-ms': options.processIntervalMs = number(arg, argv[++i], 200); break;
      case '--target': options.target = text(arg, argv[++i]); break;
      case '--powershell': options.powershell = text(arg, argv[++i]); break;
      case '--out': options.out = text(arg, argv[++i]); break;
      case '--self-test': options.selfTest = true; break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`Unknown option: ${arg}\n${USAGE}`);
    }
  }
  if (!/^[\w.\-]+$/.test(options.processName)) throw new Error('--process-name may only contain letters, digits, dot, dash and underscore');
  return options;
}

// ---------------------------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------------------------
export async function listTargets(port, fetchImpl = fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json`);
  if (!response.ok) throw new Error(`/json answered HTTP ${response.status}`);
  return response.json();
}
export function pickTarget(targets, text = null) {
  const pages = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl && !String(target.url).startsWith('devtools://'));
  if (text) return pages.find(target => `${target.url} ${target.title}`.toLowerCase().includes(text.toLowerCase())) ?? null;
  return pages.find(target => /tauri\.localhost|localhost|127\.0\.0\.1/.test(target.url)) ?? pages[0] ?? null;
}

class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const cdp = new Cdp(socket);
      socket.addEventListener('open', () => resolve(cdp), { once: true });
      socket.addEventListener('error', () => reject(new Error(`Cannot open ${url}. If WebView2 answers 403, relaunch the app with --remote-allow-origins=* added to WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.`)), { once: true });
    });
  }
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map(); this.closed = false;
    socket.addEventListener('message', event => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      const waiting = message.id ? this.pending.get(message.id) : null;
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const waiting of this.pending.values()) waiting.reject(new Error('The DevTools connection closed (did the app exit or reload?)'));
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('The DevTools connection is closed'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) throw new Error(`Page script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result?.value;
  }
  close() { try { this.socket.close(); } catch { /* already closed */ } }
}

// ---------------------------------------------------------------------------------------------
// In-page scripts
// ---------------------------------------------------------------------------------------------
export const INSTALL_OBSERVERS = `(() => {
  if (window.__lkSession) return 'already';
  const session = window.__lkSession = { t0: performance.now(), origin: performance.timeOrigin, longtasks: [], loaf: [], observers: [] };
  const watch = (type, sink, map) => {
    try {
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) sink.push(map(entry)); });
      observer.observe({ type, buffered: true });
      session.observers.push({ observer, sink, map });
      return true;
    } catch { return false; }
  };
  session.supported = {
    longtask: watch('longtask', session.longtasks, e => ({ start: e.startTime, duration: e.duration })),
    loaf: watch('long-animation-frame', session.loaf, e => ({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration,
      scripts: (e.scripts || []).slice(0, 4).map(s => ({ invoker: s.invoker, fn: s.sourceFunctionName, file: String(s.sourceURL || '').split('/').pop().split('?')[0], duration: s.duration })) })),
  };
  return 'installed';
})()`;
export const READ_OBSERVERS = `(() => {
  const session = window.__lkSession;
  if (!session) return null;
  for (const { observer, sink, map } of session.observers) for (const entry of observer.takeRecords()) sink.push(map(entry));
  return { t0: session.t0, now: performance.now(), origin: session.origin, supported: session.supported, longtasks: session.longtasks, loaf: session.loaf };
})()`;
export function scrollScript(config) {
  return `(async (cfg) => {
  const pick = () => {
    const selectors = cfg.selector ? [cfg.selector] : ['.asset-gallery__scroll', '.gallery-scroll'];
    for (const selector of selectors) for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && el.scrollHeight > el.clientHeight + 8 && !el.closest('[inert], [aria-hidden="true"]')) return el;
    }
    return null;
  };
  const el = pick();
  if (!el) return { found: false };
  const frames = [];
  let last = 0, running = true;
  const tick = now => { if (last) frames.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const startTop = el.scrollTop, start = performance.now();
  let direction = 1, scrolled = 0;
  await new Promise(resolve => {
    const timer = setInterval(() => {
      const before = el.scrollTop, max = el.scrollHeight - el.clientHeight;
      if (before + direction * cfg.stepPx > max) direction = -1; else if (before + direction * cfg.stepPx < 0) direction = 1;
      el.scrollTop = before + direction * cfg.stepPx;
      scrolled += Math.abs(el.scrollTop - before);
      if (performance.now() - start >= cfg.ms) { clearInterval(timer); resolve(); }
    }, cfg.intervalMs);
  });
  running = false;
  el.scrollTop = startTop;
  return { found: true, element: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\\s+/).join('.') : ''), frames, scrolledPx: scrolled, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
})(${JSON.stringify(config)})`;
}

// ---------------------------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------------------------
export function summarizeDurations(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  return { count: sorted.length, total: round(sum(sorted)), p50: round(percentile(sorted, .5)), p95: round(percentile(sorted, .95)), max: round(sorted.at(-1) ?? null) };
}

export function summarizeLongTasks(read) {
  if (!read) return { supported: false };
  const within = entries => entries.filter(entry => entry.start >= read.t0);
  const tasks = within(read.longtasks ?? []), frames = within(read.loaf ?? []);
  const rel = entry => round(entry.start - read.t0, 1);
  return {
    windowMs: round(read.now - read.t0, 1),
    supported: read.supported,
    longtasks: {
      ...summarizeDurations(tasks.map(task => task.duration)),
      longest: [...tasks].sort((a, b) => b.duration - a.duration).slice(0, 10).map(task => ({ atMs: rel(task), durationMs: round(task.duration) })),
    },
    longAnimationFrames: {
      ...summarizeDurations(frames.map(frame => frame.duration)),
      blockingTotalMs: round(sum(frames.map(frame => frame.blocking).filter(finite))),
      longest: [...frames].sort((a, b) => b.duration - a.duration).slice(0, 10).map(frame => ({ atMs: rel(frame), durationMs: round(frame.duration), blockingMs: round(frame.blocking), scripts: frame.scripts })),
    },
  };
}

const SPECIAL_FRAMES = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);
const baseName = url => String(url).split('/').pop().split('?')[0];

/** Self time per function with caller chains. Unnamed native frames are charged to their JS caller. */
export function summarizeProfile(profile, { top = 25, chainsPerFunction = 3, chainDepth = 6 } = {}) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const jsLabel = node => `${node.callFrame.functionName || '(anonymous)'} ${baseName(node.callFrame.url)}:${(node.callFrame.lineNumber ?? 0) + 1}`;
  const isScript = node => node.callFrame.url !== '';
  const isUnnamedNative = node => !isScript(node) && !SPECIAL_FRAMES.has(node.callFrame.functionName) && (node.callFrame.functionName === '' || node.callFrame.functionName === '(anonymous)');
  const ancestors = id => { const list = []; for (let at = parent.get(id); at !== undefined; at = parent.get(at)) list.push(nodes.get(at)); return list; };
  const labelCache = new Map(), chainCache = new Map();
  const labelOf = id => {
    if (labelCache.has(id)) return labelCache.get(id);
    const node = nodes.get(id), name = node.callFrame.functionName;
    let label;
    if (SPECIAL_FRAMES.has(name)) label = name;
    else if (isScript(node)) label = jsLabel(node);
    else if (!isUnnamedNative(node)) label = `[native] ${name}`;
    else {
      const caller = ancestors(id).find(candidate => isScript(candidate));
      label = caller ? `[native] <- ${jsLabel(caller)}` : '[native] <- (no JS caller)';
    }
    labelCache.set(id, label);
    return label;
  };
  const chainOf = id => {
    if (chainCache.has(id)) return chainCache.get(id);
    const labels = ancestors(id).filter(isScript).slice(0, chainDepth).map(jsLabel);
    const chain = labels.join(' <- ') || '(top level)';
    chainCache.set(id, chain);
    return chain;
  };
  const interval = profile.timeDeltas.length > 1 ? sum(profile.timeDeltas) / profile.timeDeltas.length : 500;
  const byLabel = new Map();
  const totals = { total: 0, idle: 0, program: 0, gc: 0 };
  profile.samples.forEach((id, index) => {
    const ms = (profile.timeDeltas[index + 1] ?? interval) / 1000;
    const label = labelOf(id);
    totals.total += ms;
    if (label === '(idle)') { totals.idle += ms; return; }
    if (label === '(program)') totals.program += ms;
    else if (label === '(garbage collector)') totals.gc += ms;
    const entry = byLabel.get(label) ?? { ms: 0, chains: new Map() };
    entry.ms += ms;
    const chain = chainOf(id);
    entry.chains.set(chain, (entry.chains.get(chain) ?? 0) + ms);
    byLabel.set(label, entry);
  });
  const busy = totals.total - totals.idle;
  return {
    samples: profile.samples.length, intervalUs: round(interval, 1), totalMs: round(totals.total), idleMs: round(totals.idle), busyMs: round(busy),
    programMs: round(totals.program), gcMs: round(totals.gc),
    top: [...byLabel].sort((a, b) => b[1].ms - a[1].ms).slice(0, top).map(([label, entry]) => ({
      label, selfMs: round(entry.ms), pctOfBusy: busy > 0 ? round(entry.ms / busy * 100, 1) : null,
      chains: [...entry.chains].sort((a, b) => b[1] - a[1]).slice(0, chainsPerFunction).map(([chain, ms]) => ({ chain, ms: round(ms) })),
    })),
  };
}

export function summarizeMetrics(before, after) {
  const map = list => Object.fromEntries((list ?? []).map(metric => [metric.name, metric.value]));
  const a = map(before), b = map(after);
  return Object.fromEntries(Object.keys(b).map(name => [name, { before: round(a[name], 4), after: round(b[name], 4), delta: round(b[name] - (a[name] ?? 0), 4) }]));
}

export function summarizeFrames(frames) {
  const sorted = frames.filter(finite).sort((a, b) => a - b);
  return {
    count: sorted.length, p50: round(percentile(sorted, .5)), p95: round(percentile(sorted, .95)), p99: round(percentile(sorted, .99)), max: round(sorted.at(-1) ?? null),
    over25ms: sorted.filter(frame => frame > 25).length, over50ms: sorted.filter(frame => frame > 50).length,
  };
}

export const roleOf = (proc, rootName) => {
  if (proc.name?.toLowerCase() === rootName.toLowerCase()) return 'app';
  if (proc.name?.toLowerCase() === 'msedgewebview2.exe') return `webview-${proc.type ?? 'browser'}`;
  return proc.name ?? 'other';
};

/** ticks: [{ t (unix ms), procs: [{ pid, name, type, cpu100ns, ws, priv }] }]. CPU% is of the whole machine. */
export function summarizeProcesses(ticks, { cpus, rootName }) {
  const mb = bytes => bytes / 1048576;
  const series = [];
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i], previous = ticks[i - 1];
    const roles = {};
    const add = (role, field, value) => { (roles[role] ??= { cpuSeconds: 0, wsMb: 0, privMb: 0 })[field] += value; };
    const before = new Map((previous?.procs ?? []).map(proc => [proc.pid, proc]));
    for (const proc of tick.procs ?? []) {
      const role = roleOf(proc, rootName);
      add(role, 'wsMb', mb(proc.ws)); add(role, 'privMb', mb(proc.priv));
      const old = before.get(proc.pid);
      if (old && proc.cpu100ns >= old.cpu100ns) add(role, 'cpuSeconds', (proc.cpu100ns - old.cpu100ns) / 1e7);
      else add(role, 'cpuSeconds', 0);
    }
    const elapsed = previous ? (tick.t - previous.t) / 1000 : null;
    const point = { tSec: round((tick.t - ticks[0].t) / 1000, 2), roles: {} };
    let total = { cores: 0, wsMb: 0, privMb: 0 };
    for (const [role, value] of Object.entries(roles)) {
      const cores = elapsed ? value.cpuSeconds / elapsed : null;
      point.roles[role] = { cpuPct: cores === null ? null : round(cores / cpus * 100, 2), cores: round(cores, 3), wsMb: round(value.wsMb, 1), privMb: round(value.privMb, 1) };
      total = { cores: total.cores + (cores ?? 0), wsMb: total.wsMb + value.wsMb, privMb: total.privMb + value.privMb };
    }
    point.roles.total = { cpuPct: elapsed ? round(total.cores / cpus * 100, 2) : null, cores: elapsed ? round(total.cores, 3) : null, wsMb: round(total.wsMb, 1), privMb: round(total.privMb, 1) };
    series.push(point);
  }
  const names = [...new Set(series.flatMap(point => Object.keys(point.roles)))].sort((a, b) => a === 'total' ? 1 : b === 'total' ? -1 : a.localeCompare(b));
  const stats = Object.fromEntries(names.map(name => {
    const points = series.map(point => point.roles[name]).filter(Boolean);
    const cpu = points.map(point => point.cpuPct).filter(finite).sort((a, b) => a - b);
    return [name, {
      samples: points.length,
      cpuPctMean: cpu.length ? round(sum(cpu) / cpu.length) : null, cpuPctP95: round(percentile(cpu, .95)), cpuPctMax: round(cpu.at(-1) ?? null),
      wsMbMax: round(Math.max(...points.map(point => point.wsMb)), 1), wsMbLast: points.at(-1)?.wsMb ?? null,
      privMbMax: round(Math.max(...points.map(point => point.privMb)), 1), privMbLast: points.at(-1)?.privMb ?? null,
    }];
  }));
  return { cpus, ticks: ticks.length, stats, series };
}

// ---------------------------------------------------------------------------------------------
// Process sampler (one long-lived PowerShell loop, one CIM query per tick)
// ---------------------------------------------------------------------------------------------
export function samplerScript(rootName, intervalMs) {
  return `$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$root = '${rootName}'
$pause = ${Math.round(intervalMs)}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime)
  $keep = New-Object 'System.Collections.Generic.HashSet[uint32]'
  foreach ($p in $all) { if ($p.Name -ieq $root) { [void]$keep.Add($p.ProcessId) } }
  do {
    $added = 0
    foreach ($p in $all) { if (-not $keep.Contains($p.ProcessId) -and $keep.Contains($p.ParentProcessId)) { [void]$keep.Add($p.ProcessId); $added++ } }
  } while ($added -gt 0)
  $procs = @(foreach ($p in $all) {
    if ($keep.Contains($p.ProcessId)) {
      $type = $null
      if ($p.CommandLine -match '--type=([A-Za-z0-9_\\-]+)') { $type = $Matches[1] }
      [pscustomobject]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = $p.Name; type = $type; cpu100ns = [uint64]($p.KernelModeTime + $p.UserModeTime); ws = [uint64]$p.WorkingSetSize; priv = [uint64]$p.PrivatePageCount }
    }
  })
  [Console]::Out.WriteLine((@{ t = $t; procs = $procs } | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $pause
}`;
}

export function parseSamplerLines(text) {
  const ticks = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const tick = JSON.parse(line);
      if (!finite(tick.t)) continue;
      tick.procs = Array.isArray(tick.procs) ? tick.procs : tick.procs ? [tick.procs] : [];
      ticks.push(tick);
    } catch { /* a partial final line */ }
  }
  return ticks;
}

function startSampler({ powershell, processName, processIntervalMs }) {
  const encoded = Buffer.from(samplerScript(processName, processIntervalMs), 'utf16le').toString('base64');
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '', errors = '', failed = null;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.on('error', error => { failed = error.message; });
  return {
    async stop() {
      child.kill();
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 1500); });
      return { ticks: parseSamplerLines(output), error: failed ?? (errors.replace(/#< CLIXML[\s\S]*?(<\/Objs>|$)/g, '').trim().slice(0, 500) || null) };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
export function markdownReport(report) {
  const lines = [`# Lakomics Windows session`, '',
    `Recorded ${report.environment.seconds} s on port ${report.environment.port} (${report.environment.userAgent ?? 'user agent unknown'}), ${report.environment.cpus} logical CPUs.`,
    `Flags: ${[report.environment.cpuProfile && 'cpu-profile', report.environment.scroll && 'scroll'].filter(Boolean).join(', ') || 'none'}.`, ''];
  const lt = report.longTasks;
  lines.push('## Main-thread stalls', '');
  if (lt?.longtasks) {
    lines.push('Kind | count | total ms | p50 | p95 | max', '--- | ---: | ---: | ---: | ---: | ---:',
      `longtask | ${lt.longtasks.count} | ${lt.longtasks.total} | ${lt.longtasks.p50} | ${lt.longtasks.p95} | ${lt.longtasks.max}`,
      `long animation frame | ${lt.longAnimationFrames.count} | ${lt.longAnimationFrames.total} | ${lt.longAnimationFrames.p50} | ${lt.longAnimationFrames.p95} | ${lt.longAnimationFrames.max}`, '');
    if (lt.longtasks.longest.length) lines.push(`Longest long tasks (ms from start): ${lt.longtasks.longest.slice(0, 5).map(task => `${task.durationMs} @ ${task.atMs}`).join(', ')}`, '');
  } else lines.push('Not available (page script did not run).', '');
  if (report.frames) {
    lines.push('## Scroll frame times', '');
    if (!report.frames.found) lines.push('No scrollable grid was found; open Assets or a folder with more than one screen of tiles and retry (or pass --scroll-selector).', '');
    else lines.push(`Scroller \`${report.frames.element}\`, ${report.frames.scrolledPx} px scrolled.`, '', 'frames | p50 ms | p95 ms | p99 ms | max ms | >25 ms | >50 ms', '--- | ---: | ---: | ---: | ---: | ---: | ---:',
      `${report.frames.count} | ${report.frames.p50} | ${report.frames.p95} | ${report.frames.p99} | ${report.frames.max} | ${report.frames.over25ms} | ${report.frames.over50ms}`, '');
    if (report.frames.found && report.frames.count === 0) lines.push('Zero frames: the window is probably minimised or covered, so the browser did not paint.', '');
  }
  if (report.metrics) {
    const keys = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount', 'JSHeapUsedSize', 'Nodes'];
    lines.push('## Performance.getMetrics (delta over the session)', '', 'Metric | before | after | delta', '--- | ---: | ---: | ---:');
    for (const key of keys) if (report.metrics[key]) lines.push(`${key} | ${report.metrics[key].before} | ${report.metrics[key].after} | ${report.metrics[key].delta}`);
    lines.push('');
  }
  if (report.processes) {
    lines.push('## Processes', '');
    if (report.processes.error) lines.push(`Sampler warning: ${report.processes.error}`, '');
    if (report.processes.ticks) {
      lines.push(`CPU% is of the whole machine (${report.processes.cpus} logical CPUs).`, '', 'Role | CPU% mean | CPU% p95 | CPU% max | WS MB max | private MB max | private MB last', '--- | ---: | ---: | ---: | ---: | ---: | ---:');
      for (const [role, s] of Object.entries(report.processes.stats)) lines.push(`${role} | ${s.cpuPctMean} | ${s.cpuPctP95} | ${s.cpuPctMax} | ${s.wsMbMax} | ${s.privMbMax} | ${s.privMbLast}`);
      lines.push('');
    } else lines.push(`No samples. Is ${report.environment.processName} running?`, '');
  }
  if (report.cpuProfile) {
    const p = report.cpuProfile;
    lines.push('## CPU profile', '', `${p.samples} samples at ${p.intervalUs} us; busy ${p.busyMs} ms of ${p.totalMs} ms (idle ${p.idleMs}, program/native ${p.programMs}, GC ${p.gcMs}).`, '',
      'Self ms | % busy | Function', '---: | ---: | ---');
    for (const item of p.top.slice(0, 15)) lines.push(`${item.selfMs} | ${item.pctOfBusy} | ${item.label}`);
    lines.push('', 'Caller chains of the top 5:');
    for (const item of p.top.slice(0, 5)) for (const chain of item.chains.slice(0, 2)) lines.push(`- ${item.label}: ${chain.ms} ms via ${chain.chain}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------
const stamp = () => {
  const now = new Date(), two = number => String(number).padStart(2, '0');
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
};
const progress = message => process.stderr.write(`${message}\n`);

export async function runSession(options) {
  const targets = await listTargets(options.port).catch(error => {
    throw new Error(`Cannot reach http://127.0.0.1:${options.port}/json (${error.message}). Start the release app from a shell that has WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${options.port}.`);
  });
  const target = pickTarget(targets, options.target);
  if (!target) throw new Error(`No page target found. Targets: ${targets.map(item => `${item.type}:${item.url}`).join(' | ') || 'none'}`);
  const version = await fetch(`http://127.0.0.1:${options.port}/json/version`).then(response => response.json()).catch(() => ({}));
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const cpus = availableParallelism();
  const report = {
    environment: {
      node: process.version, cpus, port: options.port, seconds: options.seconds, processName: options.processName, userAgent: version['User-Agent'] ?? null,
      browser: version.Browser ?? null, cpuProfile: options.cpuProfile, scroll: options.scroll, targetUrl: String(target.url).replace(/[?#].*$/, ''), startedAt: new Date().toISOString(),
    },
  };
  let sampler;
  try {
    await cdp.send('Performance.enable');
    if (options.cpuProfile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); }
    await cdp.evaluate(INSTALL_OBSERVERS);
    const metricsBefore = (await cdp.send('Performance.getMetrics')).metrics;
    sampler = startSampler(options);
    if (options.cpuProfile) await cdp.send('Profiler.start');
    progress(`Recording ${options.seconds} s. Use the app now (or let --scroll drive it).`);
    const scrolling = options.scroll
      ? cdp.evaluate(scrollScript({ selector: options.scrollSelector, stepPx: options.scrollStepPx, intervalMs: options.scrollIntervalMs, ms: options.seconds * 1000 }), true)
      : Promise.resolve(null);
    await new Promise(resolve => setTimeout(resolve, options.seconds * 1000));
    const scrollResult = await scrolling;
    const profile = options.cpuProfile ? (await cdp.send('Profiler.stop')).profile : null;
    const metricsAfter = (await cdp.send('Performance.getMetrics')).metrics;
    const read = await cdp.evaluate(READ_OBSERVERS);
    const processes = await sampler.stop(); sampler = null;
    report.longTasks = summarizeLongTasks(read);
    report.metrics = summarizeMetrics(metricsBefore, metricsAfter);
    report.processes = { ...summarizeProcesses(processes.ticks, { cpus, rootName: options.processName }), error: processes.error };
    if (scrollResult) report.frames = scrollResult.found ? { found: true, element: scrollResult.element, scrolledPx: scrollResult.scrolledPx, ...summarizeFrames(scrollResult.frames) } : { found: false };
    if (profile) report.cpuProfile = summarizeProfile(profile);
    report.rawProfile = profile;
  } finally {
    await sampler?.stop();
    cdp.close();
  }
  return report;
}

async function writeReport(report, options) {
  await mkdir(options.out, { recursive: true });
  const base = join(options.out, `lakomics-session-${stamp()}`);
  const { rawProfile, ...clean } = report;
  await writeFile(`${base}.json`, JSON.stringify(clean, null, 2) + '\n');
  const markdown = markdownReport(clean);
  await writeFile(`${base}.md`, markdown + '\n');
  const written = [`${base}.json`, `${base}.md`];
  if (options.saveProfile && rawProfile) { await writeFile(`${base}.cpuprofile`, JSON.stringify(rawProfile)); written.push(`${base}.cpuprofile`); }
  return { markdown, written };
}

// ---------------------------------------------------------------------------------------------
// Self test: built-in fixtures, no app
// ---------------------------------------------------------------------------------------------
export function selfTest() {
  const assert = (condition, message) => { if (!condition) throw new Error(`self-test failed: ${message}`); };
  const equal = (actual, expected, message) => assert(Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);

  const args = parseArgs(['--seconds', '5', '--scroll', '--cpu-profile', '--port', '9333']);
  equal([args.seconds, args.scroll, args.cpuProfile, args.port], [5, true, true, 9333], 'parseArgs');
  assert((() => { try { parseArgs(['--bogus']); return false; } catch { return true; } })(), 'unknown option is rejected');
  assert((() => { try { parseArgs(['--process-name', 'a;b']); return false; } catch { return true; } })(), 'unsafe process name is rejected');

  const pick = pickTarget([{ type: 'page', url: 'devtools://x', webSocketDebuggerUrl: 'ws://a' }, { type: 'page', url: 'http://tauri.localhost/', title: 'Lakomics', webSocketDebuggerUrl: 'ws://b' }]);
  equal(pick?.webSocketDebuggerUrl, 'ws://b', 'pickTarget skips devtools');

  // CPU profile: root -> render (JS) -> unnamed native; root -> idle; root -> program.
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2, 4, 5] },
      { id: 2, callFrame: { functionName: 'render', url: 'http://tauri.localhost/assets/index-abc.js', lineNumber: 9 }, children: [3] },
      { id: 3, callFrame: { functionName: '', url: '' }, children: [] },
      { id: 4, callFrame: { functionName: '(idle)', url: '' }, children: [] },
      { id: 5, callFrame: { functionName: '(program)', url: '' }, children: [] },
    ],
    samples: [3, 3, 2, 4, 4, 4, 5],
    timeDeltas: [500, 500, 500, 500, 500, 500, 500, 500],
  };
  const profileSummary = summarizeProfile(profile);
  equal(profileSummary.idleMs, 1.5, 'idle ms');
  equal(profileSummary.top[0].label, '[native] <- render index-abc.js:10', 'unnamed native frame is charged to its JS caller');
  equal(profileSummary.top[0].selfMs, 1, 'native self ms');
  equal(profileSummary.top[0].chains[0].chain, 'render index-abc.js:10', 'caller chain');
  equal(profileSummary.programMs, 0.5, 'program ms');

  const lt = summarizeLongTasks({ t0: 100, now: 1100, supported: { longtask: true, loaf: false },
    longtasks: [{ start: 50, duration: 900 }, { start: 200, duration: 60 }, { start: 400, duration: 120 }], loaf: [] });
  equal(lt.longtasks.count, 2, 'long tasks before the window are ignored');
  equal(lt.longtasks.max, 120, 'long task max');
  equal(lt.longtasks.longest[0].atMs, 300, 'long task offset');

  const metrics = summarizeMetrics([{ name: 'LayoutCount', value: 10 }], [{ name: 'LayoutCount', value: 25 }]);
  equal(metrics.LayoutCount.delta, 15, 'metric delta');

  const frames = summarizeFrames([16, 17, 16, 33, 80, 16, 16, 16, 16, 16]);
  equal([frames.count, frames.p50, frames.max, frames.over25ms, frames.over50ms], [10, 16, 80, 2, 1], 'frame stats');

  const proc = (cpu, ws = 100 * 1048576) => ({ pid: 10, name: 'lakomics.exe', cpu100ns: cpu, ws, priv: ws });
  const child = (cpu, type) => ({ pid: 20, name: 'msedgewebview2.exe', type, cpu100ns: cpu, ws: 50 * 1048576, priv: 40 * 1048576 });
  const sampled = summarizeProcesses([
    { t: 1000, procs: [proc(0), child(0, 'renderer')] },
    { t: 2000, procs: [proc(5_000_000), child(10_000_000, 'renderer')] },
  ], { cpus: 4, rootName: 'lakomics.exe' });
  equal(sampled.series[1].roles.app.cpuPct, 12.5, 'app CPU% = 0.5 core / 4');
  equal(sampled.series[1].roles['webview-renderer'].cpuPct, 25, 'renderer CPU% = 1 core / 4');
  equal(sampled.series[1].roles.total.cpuPct, 37.5, 'total CPU%');
  equal(sampled.stats.app.privMbMax, 100, 'private MB');

  const parsed = parseSamplerLines('{"t":1,"procs":{"pid":1,"name":"a.exe","cpu100ns":1,"ws":1,"priv":1}}\n{"t":2,"procs":[]}\n{"t":3,"pro');
  equal([parsed.length, parsed[0].procs.length], [2, 1], 'sampler lines: single object becomes an array, partial line skipped');
  assert(samplerScript('lakomics.exe', 1000).includes("$root = 'lakomics.exe'"), 'sampler script embeds the process name');

  const markdown = markdownReport({
    environment: { seconds: 5, port: 9222, cpus: 4, processName: 'lakomics.exe', cpuProfile: true, scroll: true }, longTasks: lt, metrics,
    frames: { found: true, element: 'div.asset-gallery__scroll', scrolledPx: 1000, ...frames }, processes: { ...sampled, error: null }, cpuProfile: profileSummary,
  });
  assert(markdown.includes('Scroll frame times') && markdown.includes('webview-renderer'), 'markdown has the expected sections');
  return 'self-test ok';
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { console.log(USAGE); return; }
  if (options.selfTest) { console.log(selfTest()); return; }
  if (typeof WebSocket !== 'function') throw new Error('Node 22 or newer is required (built-in WebSocket).');
  const report = await runSession(options);
  const { markdown, written } = await writeReport(report, options);
  console.log(markdown);
  console.log(`\nWrote:\n${written.map(file => `  ${file}`).join('\n')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
