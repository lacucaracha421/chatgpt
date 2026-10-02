import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { release, cpus } from 'node:os';
import { installProbe, settleSurface, scrollSurface } from './perf-webview.mjs';
import { createSampler } from './proc-sampler.mjs';
import { buildReport } from './perf-stats.mjs';

export function writeReport(recording, outDir, baselineFile) {
  const result = buildReport(recording, baselineFile ? JSON.parse(readFileSync(baselineFile, 'utf8')) : null);
  writeFileSync(join(outDir, 'perf.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(outDir, 'perf.md'), result.markdown);
  console.log(result.markdown);
  return result;
}
export async function runPerformance({ config, run, call, s, driverPid, app, outDir, baseline, launchAt, startupSampler }) {
  const recording = { version: 1, evidence: 'native WebView (instrumented)', recordedAt: new Date().toISOString(),
    frameBudgetMs: config.frameBudgetMs, conditions: config.conditions, scenarios: [],
    environment: await run(`return (${installProbe.toString()})();`), platform: process.platform, kernel: release(), cpu: cpus()[0]?.model,
    binary: { path: app, bytes: statSync(app).size, modifiedAt: statSync(app).mtime.toISOString() },
    startupCoverage: 'Fresh process after unmeasured path bootstrap; OS/file caches are warm. Host launch-to-grid includes WebDriver session startup. WebView probes start after session creation.' };
  if (config.notesFixture) await run(`
    const native = window.__TAURI_INTERNALS__;
    const original = native.invoke.bind(native);
    let note = { id: 'native-check-note', title: 'Native check fixture', body: '', pinned: false, deleted: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', localRevision: 0, pending: false, conflict: false };
    native.invoke = (command, args, ...rest) => {
      if (command !== 'notes_request') return original(command, args, ...rest);
      if (args?.operation === 'save') { note = { ...note, ...args.input, localRevision: Number(args.input?.expectedRevision ?? 0) + 1 }; return Promise.resolve(note); }
      return Promise.resolve({ unlocked: true, notes: [note], lastSyncedAt: null });
    };
  `);
  await call('POST', s('/window/rect'), { width: 1440, height: 1000 });
  await call('POST', s('/timeouts'), { script: 30000, implicit: 0 });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const asyncRun = (fn, arg) => call('POST', s('/execute/async'), { script: `(${fn.toString()})(arguments[0], arguments[arguments.length - 1]);`, args: [arg] });
  async function waitFor(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await run(`return Boolean(${expression});`)) return; await sleep(50); }
    throw new Error(`timed out: ${expression}`);
  }
  async function element(selector) {
    const result = await call('POST', s('/element'), { using: 'css selector', value: selector });
    return result['element-6066-11e4-a52e-4f735466cecf'] ?? Object.values(result)[0];
  }
  async function step(item) {
    if (item.wait !== undefined) { await sleep(item.wait); return; }
    if (item.assert) { if (!await run(`return Boolean(${item.assert});`)) throw new Error(`assert failed: ${item.assert}`); return; }
    if (item.waitFor) return waitFor(`document.querySelector(${JSON.stringify(item.waitFor)})`);
    if (item.hidden || item.visible) {
      await call('POST', s(item.hidden ? '/window/minimize' : '/window/rect'), item.hidden ? {} : { width: 1440, height: 1000 });
      return waitFor(`document.visibilityState === '${item.hidden ? 'hidden' : 'visible'}'`);
    }
    if (item.settle || item.scroll) {
      const result = await asyncRun(item.settle ? settleSurface : scrollSurface, item.settle ?? item.scroll);
      if (result.error) throw new Error(result.error);
      return result;
    }
    if (item.clickText) {
      const index = await run('return [...document.querySelectorAll(arguments[0])].findIndex(e => e.textContent.trim() === arguments[1]);', [item.clickText.selector, item.clickText.text]);
      if (index < 0) throw new Error(`missing button: ${item.clickText.text}`);
      const elements = await call('POST', s('/elements'), { using: 'css selector', value: item.clickText.selector });
      const id = elements[index]['element-6066-11e4-a52e-4f735466cecf'];
      return call('POST', s(`/element/${id}/click`), {});
    }
    if (item.type) {
      const id = await element(item.type.selector);
      await call('POST', s(`/element/${id}/click`), {});
      // Send one character per driver command, record the cadence in the scenario file.
      for (const text of item.type.text) { await call('POST', s(`/element/${id}/value`), { text }); if (item.type.intervalMs) await sleep(item.type.intervalMs); }
      return;
    }
    if (item.click) return call('POST', s(`/element/${await element(item.click)}/click`), {});
    if (item.dblclick) {
      const id = await element(item.dblclick);
      return call('POST', s('/actions'), { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
        { type: 'pointerMove', origin: { 'element-6066-11e4-a52e-4f735466cecf': id }, x: 0, y: 0 },
        ...[0, 1].flatMap(() => [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }]) ] }] });
    }
    if (item.key) {
      const value = { Enter: '\uE007', Escape: '\uE00C', ArrowRight: '\uE014' }[item.key] ?? item.key;
      const before = item.key === 'ArrowRight' ? await run('return document.querySelector(".asset-viewer__media:not([data-stable-image-loading])")?.src ?? null;') : null;
      await call('POST', s('/actions'), { actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
      // StableImage retains the old painted image while decoding. DOM quiet alone would
      // mistakenly time the old page; require a new visible source before settling it.
      if (before) await waitFor(`document.querySelector('.asset-viewer__media:not([data-stable-image-loading])')?.src && document.querySelector('.asset-viewer__media:not([data-stable-image-loading])').src !== ${JSON.stringify(before)}`);
      return;
    }
  }
  if (config.scenarios[0].id !== 'startup') startupSampler.stop();
  for (const scenario of config.scenarios) {
    const row = { id: scenario.id, definition: scenario, frames: [], longTasks: [], processSamples: [] };
    let sampler = scenario.id === 'startup' ? startupSampler : null;
    let hostStart = scenario.id === 'startup' ? launchAt : performance.now();
    let probeStarted = false;
    try {
      for (const item of scenario.setup ?? []) await step(item);
      if (!sampler) { sampler = createSampler(driverPid, app); hostStart = performance.now(); }
      await run('window.__nativeCheckPerf.start(arguments[0], arguments[1]);', [scenario.id, !!scenario.motion]);
      probeStarted = true;
      for (const [index, item] of scenario.steps.entries()) {
        const label = `${scenario.id}:${index}:${Object.keys(item)[0]}`;
        await run('window.__nativeCheckPerf.mark(arguments[0]);', [`${label}:start`]);
        await step(item);
        await run('window.__nativeCheckPerf.measure(arguments[0], arguments[1]);', [label, `${label}:start`]);
      }
    } catch (error) { row.error = error.message; }
    finally {
      if (probeStarted) { try { Object.assign(row, await run('return window.__nativeCheckPerf.stop();')); } catch (error) { row.error ??= error.message; } }
      row.hostDurationMs = performance.now() - hostStart;
      row.processSamples = sampler?.stop() ?? [];
      if (!row.processSamples.some(p => p.processes > 0)) row.error ??= 'No app /proc samples; process metrics unavailable';
      recording.scenarios.push(row);
      writeReport(recording, outDir, baseline);
    }
  }
  return recording.scenarios.every(row => !row.error);
}
