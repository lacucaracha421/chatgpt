import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';
import { DEFAULTS, normalize } from './helpers/youtube-classic.mjs';

const contentSource = await readFile(new URL('../src/youtube/content.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../src/youtube/content.css', import.meta.url), 'utf8');
const KEY = 'lakomics:youtube:settings:';
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Real DOM for the content script; layout and animation are stubbed deterministically when `motion` is set.
async function mount(t, { stored = {}, reduce = false, motion = false } = {}) {
  const dom = new JSDOM('<div id="movie_player"><video></video></div>', {
    url: 'https://www.youtube.com/watch?v=v', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  const animations = [];
  let changed = null;
  w.console.info = () => {};
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.matchMedia = () => ({ matches: reduce });
  if (motion) {
    // Overlay bottom at 500 px; every line is 40 px tall and stacked upwards from the bottom.
    w.HTMLElement.prototype.getBoundingClientRect = function rect() {
      if (this.id === 'lakomics-yt-overlay') return { top: 0, bottom: 500, width: 300 };
      const lines = [...this.parentNode.children];
      const bottom = 500 - 40 * (lines.length - 1 - lines.indexOf(this));
      const width = 300; // a line fills the 300 px wide overlay
      return { top: bottom - 40, bottom, width };
    };
    w.HTMLElement.prototype.animate = function animate(keyframes, options) {
      const record = { el: this, keyframes, options };
      animations.push(record);
      return record;
    };
  }
  w.chrome = { storage: { onChanged: { addListener(fn) { changed = fn; } }, local: { get: async () => ({ [KEY + 'rolling']: true, ...stored }) } },
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) } };
  const video = w.document.querySelector('video');
  let now = 0;
  Object.defineProperty(video, 'currentTime', { get: () => now, configurable: true });
  Object.defineProperty(video, 'paused', { get: () => true, configurable: true });
  const context = dom.getInternalVMContext();
  vm.runInContext(contentSource.split('  // ---------------------------------------------------------------- start')[0] + `
    renderButton = showToast = hideToast = () => {};
    globalThis.hook = { state, mergePartial, applyMode, sync, appearance, previousLineIndex,
      overlay: () => overlay };
  })();`, context);
  await tick(); await tick();
  const hook = w.hook;
  hook.state.videoId = 'v'; hook.state.status = 'ready';
  const lines = () => [...hook.overlay().children];
  return { w, hook, video, animations, lines,
    load: (cues) => hook.mergePartial({ startMs: 0, endMs: 60000, cues }),
    at: (seconds) => { now = seconds; hook.sync(); },
    overlay: () => hook.overlay(),
    setting: (key, value) => changed({ [KEY + key]: { newValue: value } }, 'local') };
}
const cue = (startMs, endMs, text, orig) => ({ startMs, endMs, text, ...(orig ? { orig } : {}) });
const shown = (h) => h.lines().map((node) => [node.className.split(' ')[1], node.textContent]);

test('a new cue pushes the previous one into the top slot and the old element moves up', async (t) => {
  const h = await mount(t);
  h.load([cue(0, 1000, 'first line'), cue(1080, 3000, 'second line')]);
  h.at(0.5);
  assert.deepEqual(shown(h), [['lakomics-yt-cur', 'first line']]);
  const firstElement = h.lines()[0];
  h.at(1.2);
  assert.deepEqual(shown(h), [['lakomics-yt-prev', 'first line'], ['lakomics-yt-cur', 'second line']]);
  assert.equal(h.lines()[0], firstElement, 'the same element slides up instead of being recreated');
  assert.equal(h.overlay().style.display, 'block');
});

test('roll-up: the top line stays until the next cue replaces it, however long the current cue lasts', async (t) => {
  const h = await mount(t);
  h.load([cue(0, 1000, '열두글자짜리문장입니다'), cue(1080, 9000, 'second'), cue(9080, 12000, 'third')]);
  for (const seconds of [1.1, 2.3, 5, 8.9]) {
    h.at(seconds);
    assert.deepEqual(shown(h), [['lakomics-yt-prev', '열두글자짜리문장입니다'], ['lakomics-yt-cur', 'second']], `at ${seconds} s`);
  }
  h.at(9.2);
  assert.deepEqual(shown(h), [['lakomics-yt-prev', 'second'], ['lakomics-yt-cur', 'third']]);
  assert.equal(h.hook.previousLineIndex([cue(0, 100, 'a'), cue(150, 400, 'b')], 1), 0);
  assert.equal(h.hook.previousLineIndex([cue(0, 100, 'a')], 0), -1);
});

test('after the current cue ends in silence, both lines leave together; the next cue after a long silence starts alone', async (t) => {
  const h = await mount(t);
  h.load([cue(0, 1000, 'one'), cue(1080, 2000, 'two'), cue(3500, 5000, 'three')]);
  h.at(1.5); assert.equal(h.lines().length, 2);
  h.at(2.5);
  assert.equal(h.overlay().style.display, 'none', 'no cue within 300 ms: the overlay is empty, top line included');
  h.at(3.6);
  assert.deepEqual(shown(h), [['lakomics-yt-cur', 'three']], 'the 1.5 s silence before it keeps the old line away');
});

test('after a silence longer than 1.2 s the new cue starts alone; a gap of exactly 1.2 s still rolls', async (t) => {
  const h = await mount(t);
  h.load([cue(0, 1000, 'a'), cue(2300, 4000, '길이가 충분히 긴 문장입니다 길이가 충분히 긴 문장입니다 하나 둘 셋'), cue(5200, 8000, 'after exactly 1.2 s')]);
  h.at(2.4); assert.deepEqual(shown(h).map(([role]) => role), ['lakomics-yt-cur'], 'a 1.3 s silence before the cue');
  h.at(5.3); assert.deepEqual(shown(h).map(([role]) => role), ['lakomics-yt-prev', 'lakomics-yt-cur']);
});

test('with the setting off the overlay keeps the single-line structure', async (t) => {
  const h = await mount(t, { stored: { [KEY + 'rolling']: false } });
  assert.equal(h.hook.appearance.rolling, false);
  h.load([cue(0, 1000, 'first line'), cue(1080, 3000, 'second line')]);
  h.at(1.2);
  const children = [...h.overlay().children];
  assert.equal(children.length, 1);
  assert.equal(children[0].tagName, 'SPAN');
  assert.equal(children[0].textContent, 'second line');
  assert.equal(h.overlay().querySelector('.lakomics-yt-line'), null);
});

test('switching the setting live redraws the overlay without leftovers', async (t) => {
  const h = await mount(t);
  h.load([cue(0, 1000, 'first line'), cue(1080, 3000, 'second line')]);
  h.at(1.2);
  assert.equal(h.lines().length, 2);
  h.setting('rolling', false);
  assert.deepEqual([...h.overlay().children].map((node) => node.tagName), ['SPAN']);
  assert.equal(h.overlay().textContent, 'second line');
  h.setting('rolling', true);
  assert.deepEqual(shown(h), [['lakomics-yt-prev', 'first line'], ['lakomics-yt-cur', 'second line']]);
});

test('the bottom line stays anchored: it is always the last slot, the overlay is positioned by its bottom edge only', async (t) => {
  const h = await mount(t);
  h.load([cue(0, 1000, 'one'), cue(1080, 2000, 'two'), cue(2080, 3000, 'three')]);
  const bottoms = [];
  for (const seconds of [0.5, 1.2, 2.1, 2.5]) {
    h.at(seconds);
    const last = h.lines().at(-1);
    assert.equal(last.className.split(' ')[1], 'lakomics-yt-cur');
    bottoms.push(last.textContent);
    assert.equal(h.overlay().style.top, '');
    assert.equal(h.overlay().style.height, '');
  }
  assert.deepEqual(bottoms, ['one', 'two', 'three', 'three']);
  const rule = cssSource.match(/#lakomics-yt-overlay \{[^}]*\}/)[0];
  assert.match(rule, /\n  bottom: /);
  assert.doesNotMatch(rule, /\n  top:/);
  assert.match(cssSource, /\.lakomics-yt-prev \{[^}]*opacity: 0\.72/);
});

test('the 80 ms guard between bridged cues does not empty the slots', async (t) => {
  const h = await mount(t);
  h.load([cue(0, 1000, 'one'), cue(1080, 2000, 'two')]);
  h.at(0.5);
  const element = h.lines()[0];
  h.at(1.04);
  assert.equal(h.overlay().style.display, 'block');
  assert.equal(h.lines()[0], element);
  h.at(1.1);
  assert.deepEqual(shown(h), [['lakomics-yt-prev', 'one'], ['lakomics-yt-cur', 'two']]);
  h.at(2.5);
  assert.equal(h.overlay().style.display, 'none', 'real silence empties the overlay');
});

test('original text shows on the current line only', async (t) => {
  const h = await mount(t, { stored: { [KEY + 'showOriginal']: true } });
  h.load([cue(0, 1000, 'first', 'primero'), cue(1080, 3000, 'second', 'segundo')]);
  h.at(1.2);
  const [top, bottom] = h.lines();
  assert.equal(top.querySelector('.lakomics-yt-orig'), null);
  assert.equal(top.textContent, 'first');
  assert.equal(bottom.querySelector('.lakomics-yt-orig').textContent, 'segundo');
});

test('motion: the first line fades in; later cue changes only slide the old line up, never touching opacity', async (t) => {
  const h = await mount(t, { motion: true });
  h.load([cue(0, 1000, 'zero zero'), cue(1080, 2000, 'one'), cue(2080, 9000, 'two')]);
  h.at(0.5);
  assert.match(h.lines()[0].className, /lakomics-yt-in/, 'after silence the line fades in');
  h.animations.length = 0;
  h.at(1.2); // 'zero zero' is pushed up
  const slide = h.animations.find((a) => a.keyframes.transform);
  assert.equal(slide.el.textContent, 'zero zero');
  assert.deepEqual([...slide.keyframes.transform], ['translateY(40px)', 'none']);
  assert.equal(slide.options.duration, 140);
  assert.doesNotMatch(h.lines()[1].className, /lakomics-yt-in/, 'a replaced bottom line never dips to opacity 0');
  h.animations.length = 0;
  h.at(2.15); // 'one' is pushed up and 'zero zero' (the old top) is replaced
  assert.deepEqual(h.lines().map((node) => node.textContent), ['one', 'two']);
  assert.deepEqual([...h.overlay().children].map((node) => node.textContent), ['one', 'two'], 'the replaced top line is gone at once');
  assert.ok(!h.animations.some((a) => a.keyframes.opacity !== undefined), 'no opacity animation on a cue change');
  for (const el of h.overlay().children) assert.doesNotMatch(el.className, /lakomics-yt-in/);
  h.animations.length = 0;
  h.at(8); // roll-up: 'one' stays above 'two' until something replaces it
  assert.equal(h.animations.length, 0);
  assert.deepEqual(h.lines().map((node) => node.textContent), ['one', 'two']);
});

test('motion: the overlay fades out into a silence (160 ms) and fades back in after it', async (t) => {
  const h = await mount(t, { motion: true });
  h.load([cue(0, 1000, 'one'), cue(1080, 2000, 'two'), cue(5000, 6000, 'three')]);
  h.at(1.5); h.animations.length = 0;
  h.at(3); // the silence begins
  const out = h.animations.find((a) => a.el === h.overlay() && a.keyframes.opacity);
  assert.equal(out.options.duration, 160);
  assert.equal(h.overlay().style.display, 'block', 'stays until the fade is over');
  out.onfinish();
  assert.equal(h.overlay().style.display, 'none');
  h.at(5.2);
  assert.match(h.lines()[0].className, /lakomics-yt-in/, 'speech after the silence fades in');
  // a cue that starts while the fade-out runs cancels it and shows at once
  const g = await mount(t, { motion: true });
  g.load([cue(0, 1000, 'one'), cue(1500, 2500, 'two')]);
  g.at(0.5); g.at(1.2);
  const fade = g.animations.find((a) => a.el === g.overlay());
  let cancelled = false; fade.cancel = () => { cancelled = true; };
  g.at(1.6);
  assert.equal(cancelled, true);
  assert.deepEqual(g.lines().map((node) => node.textContent), ['one', 'two']);
  assert.equal(g.overlay().style.display, 'block');
});

test('single-line mode: consecutive cues replace the text without a gap; fades only at the edges of silence', async (t) => {
  const h = await mount(t, { stored: { [KEY + 'rolling']: false }, motion: true });
  h.load([cue(0, 1000, 'one'), cue(1080, 2000, 'two'), cue(5000, 6000, 'three')]);
  h.at(4); // silence: the overlay fades out, then nothing is shown
  h.animations.find((x) => x.el === h.overlay() && x.keyframes.opacity).onfinish();
  assert.equal(h.overlay().style.display, 'none');
  h.at(5.2);
  assert.match(h.overlay().firstChild.className, /lakomics-yt-in/, 'after silence the line fades in');
  h.at(0.5);
  h.animations.length = 0;
  h.at(1.04); // inside the 80 ms guard
  assert.equal(h.overlay().textContent, 'one');
  h.at(1.1);
  assert.equal(h.overlay().textContent, 'two');
  assert.doesNotMatch(h.overlay().firstChild.className, /lakomics-yt-in/);
  assert.equal(h.animations.length, 0);
  h.at(3);
  assert.ok(h.animations.some((a) => a.el === h.overlay() && a.keyframes.opacity));
});

test('time sweep at 30 fps: consecutive cues never leave an empty frame, in rolling and single-line mode', async (t) => {
  for (const rolling of [true, false]) {
    const h = await mount(t, { stored: { [KEY + 'rolling']: rolling } });
    // 1080 ms-spaced cues with 80 ms gaps, a 250 ms gap, then a real 2 s silence, then a cue after 1.2 s.
    const cues = [cue(0, 1000, 'a'), cue(1080, 2000, 'b'), cue(2080, 3000, 'c'), cue(3250, 4000, 'd'),
      cue(6000, 7000, 'e'), cue(7500, 8000, 'f'), cue(9200, 10000, 'g')];
    h.load(cues);
    const bottoms = new Set();
    let empty = [];
    for (let ms = 0; ms < 10300; ms += 33) {
      h.at(ms / 1000);
      const visible = h.overlay().style.display === 'block' ? h.overlay().textContent : '';
      if (visible) { bottoms.add(h.lines().at(-1)); continue; }
      empty.push(ms);
    }
    const inGap = (ms) => cues.some((c, k) => k && ms >= cues[k - 1].endMs && ms < c.startMs && c.startMs - cues[k - 1].endMs > 300);
    assert.ok(empty.length > 0, 'the real silences are empty');
    assert.deepEqual(empty.filter((ms) => !inGap(ms) && ms < 10000), [], `rolling=${rolling}: no empty frame between close cues`);
    for (const ms of empty) assert.ok(inGap(ms) || ms >= 10000, `empty frame at ${ms} ms`);
  }
});

test('time sweep, roll-up: the previous line stays until the next cue starts and goes with the current one in silence', async (t) => {
  const h = await mount(t);
  const cues = [cue(0, 1000, 'a'), cue(1080, 5000, 'b'), cue(5080, 6000, 'c'), cue(8000, 9000, 'd'), cue(9300, 10000, 'e')];
  h.load(cues);
  const seen = [];
  for (let ms = 0; ms < 10300; ms += 33) {
    h.at(ms / 1000);
    seen.push([ms, h.overlay().style.display === 'block' ? h.lines().map((node) => node.textContent).join('|') : '']);
  }
  const at = (ms) => seen.find(([t0]) => t0 >= ms)[1];
  assert.equal(at(1200), 'a|b');
  assert.equal(at(4900), 'a|b', 'a long current cue does not expire the top line');
  assert.equal(at(5200), 'b|c');
  assert.equal(at(5900), 'b|c');
  assert.equal(at(7000), '', 'silence after c: both lines leave together');
  assert.equal(at(8100), 'd', 'after a 2 s silence the cue starts alone');
  assert.equal(at(9400), 'd|e', 'a 300 ms gap still rolls');
  const bottomNode = [];
  const g = await mount(t);
  g.load(cues);
  for (let ms = 5100; ms < 5900; ms += 33) { g.at(ms / 1000); bottomNode.push(g.lines().at(-1)); }
  assert.equal(new Set(bottomNode).size, 1, 'the bottom element is reused while the same cue shows');
});

test('the top slot is clamped to one visual line with an ellipsis', async (t) => {
  assert.match(cssSource, /.lakomics-yt-prev {[^}]*white-space: nowrap[^}]*overflow: hidden[^}]*text-overflow: ellipsis/);
  const h = await mount(t);
  h.load([cue(0, 1000, '저도 직접 했는데, 몇 분밖에 안 걸렸고 덕후 방에서 영상까지 나오는 완벽한 보안 시스템이'), cue(1080, 3000, '바로 돌아갔어요.')]);
  h.at(1.2);
  const [top, bottom] = h.lines();
  assert.match(top.className, /lakomics-yt-prev/);
  assert.doesNotMatch(bottom.className, /lakomics-yt-prev/);
  assert.equal(h.overlay().querySelectorAll('.lakomics-yt-prev').length, 1);
});

test('empty cues never draw an empty slot, span or original line', async (t) => {
  const h = await mount(t, { stored: { [KEY + 'showOriginal']: true } });
  const empties = () => [...h.overlay().querySelectorAll('.lakomics-yt-line, .lakomics-yt-orig-line, span')]
    .filter((node) => node.textContent === '');
  h.load([cue(0, 1000, ''), cue(1080, 2000, 'two', '   '), cue(2080, 3000, '  ', 'orig only'), cue(3080, 4000, 'four')]);
  h.at(0.5); // the current cue has no text: nothing is drawn
  assert.equal(h.overlay().style.display, 'none');
  h.at(1.2); // the top cue is empty, so the current line stands alone; a blank original adds no line
  assert.deepEqual(shown(h), [['lakomics-yt-cur', 'two']]);
  assert.equal(h.overlay().querySelector('.lakomics-yt-orig-line'), null);
  assert.deepEqual(empties(), []);
  h.at(2.2); // blank translation, even with an original: not drawn
  assert.equal(h.overlay().style.display, 'none');
  h.at(3.2); // the previous cue is blank
  assert.deepEqual(shown(h), [['lakomics-yt-cur', 'four']]);
  assert.deepEqual(empties(), []);
  assert.match(cssSource, /span:empty[^{]*{[^}]*display: none/);
  assert.equal(h.hook.previousLineIndex([cue(0, 100, ''), cue(150, 400, 'b')], 1, 200), -1);
});

test('reduced motion: no animation calls, no entrance fade', async (t) => {
  const h = await mount(t, { motion: true, reduce: true });
  h.load([cue(0, 1000, 'one'), cue(1080, 9000, 'two')]);
  h.at(0.5); h.at(1.2);
  assert.equal(h.animations.length, 0);
  assert.doesNotMatch(h.lines()[1].className, /lakomics-yt-in/);
  h.at(2.4);
  assert.deepEqual(h.lines().map((node) => node.textContent), ['one', 'two']);
  h.at(9.5);
  assert.equal(h.overlay().style.display, 'none');
  assert.equal(h.animations.length, 0);
  assert.match(cssSource, /prefers-reduced-motion: reduce\)[\s\S]*lakomics-yt-in \{ animation: none/);
});

test('a re-sent identical cue keeps its element; changed text is swapped in place', async (t) => {
  const h = await mount(t);
  h.load([cue(0, 1000, 'one'), cue(1080, 9000, 'two')]);
  h.at(1.2);
  const [top, bottom] = h.lines();
  h.load([cue(0, 1000, 'one'), cue(1080, 9000, 'two')]);
  assert.deepEqual(h.lines(), [top, bottom]);
  h.load([cue(0, 1000, 'one'), cue(1080, 9000, 'two, revised')]);
  assert.deepEqual(h.lines(), [top, bottom]);
  assert.equal(bottom.textContent, 'two, revised');
});

test('replacing a cue in a partial result redraws that line', async (t) => {
  const h = await mount(t);
  h.load([cue(0, 3000, 'old')]);
  h.at(1);
  h.load([cue(0, 3000, 'new')]);
  assert.equal(h.overlay().textContent, 'new');
});

test('the rolling setting defaults to off', async () => {
  assert.equal(DEFAULTS.rolling, false);
  assert.equal(normalize({}).rolling, false);
  assert.equal(normalize({ rolling: false }).rolling, false);
  assert.equal(normalize({ rolling: 'no' }).rolling, false);
});
