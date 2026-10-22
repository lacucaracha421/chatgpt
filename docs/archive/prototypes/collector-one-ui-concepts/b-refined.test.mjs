import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../_tools/app/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const html = readFileSync(new URL('b-refined.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('b-refined.js', import.meta.url), 'utf8');

function fixture(t, reducedMotion = false) {
  const dom = new JSDOM(html, { url: 'file:///preview.html', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, animations = [];
  let onPreferenceChange;
  const preference = { matches: reducedMotion, addEventListener(type, callback) { onPreferenceChange = callback; } };
  w.matchMedia = () => preference;
  w.Element.prototype.animate = function (frames, options) {
    const animation = {
      target: this, frames, options, cancelled: false, finished: false, onfinish: null,
      cancel() { this.cancelled = true; },
      finish() { this.finished = true; this.onfinish?.(); },
    };
    animations.push(animation);
    return animation;
  };
  w.eval(script);
  const screen = d.querySelector('.screen'), menu = d.querySelector('.menu');
  const click = target => target.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 1 }));
  const sector = id => d.querySelector('.sector[data-id="' + id + '"]');
  const tap = id => click(sector(id));
  const enter = id => { tap(id); tap(id); };
  const key = (target, value) => target.dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: value, cancelable: true }));
  const actions = () => [...d.querySelectorAll('.center-button')];
  const active = () => animations.filter(animation => !animation.cancelled && !animation.finished);
  return {
    w, d, animations, screen, menu, click, sector, tap, enter, key, actions, active,
    notice: () => d.querySelector('.static-notice').textContent,
    replay: () => click(d.querySelector('#replay')),
    reduce() { preference.matches = true; onPreferenceChange(); },
  };
}

test('entry never delays selection and retains the accepted icon-only layout', t => {
  const f = fixture(t);
  assert.equal(f.screen.dataset.open, 'true');
  assert.equal(f.d.querySelectorAll('.sector').length, 6);
  assert.equal(f.d.querySelectorAll('.rear-layer').length, 2);
  assert.equal(f.actions().length, 2);
  assert.equal(f.d.querySelectorAll('.center-button text').length, 0);
  assert.equal(f.active().length, 2);
  assert.ok(f.active().every(animation => animation.options.duration === 140));
  f.tap('photo');
  assert.equal(f.sector('photo').getAttribute('aria-pressed'), 'true');
  assert.match(f.actions()[0].getAttribute('aria-label'), /사진/);
  assert.ok(f.active().every(animation => !animation.finished));
});

test('first tap selects immediately; second tap enters without waiting for any animation', t => {
  const f = fixture(t);
  f.tap('characters');
  assert.equal(f.screen.dataset.depth, '0');
  assert.equal(f.sector('characters').getAttribute('aria-pressed'), 'true');
  f.tap('characters');
  assert.equal(f.screen.dataset.folder, 'characters');
  assert.equal(f.screen.dataset.depth, '1');
  assert.ok(f.sector('original'));
  assert.equal(f.d.activeElement, f.sector('original'));
  assert.equal(f.actions()[1].getAttribute('aria-label'), '이전 폴더로');
  assert.equal(f.active().filter(animation => animation.target.classList.contains('folder-sectors')).length, 1);
  assert.equal(f.active().at(-1).options.duration, 180);
});

test('rapid nested entry and back replace motion while restoring previous selection', t => {
  const f = fixture(t);
  f.enter('characters');
  const firstTransition = f.active().at(-1);
  f.enter('original');
  assert.equal(f.screen.dataset.depth, '2');
  assert.equal(firstTransition.cancelled, true);
  assert.equal(f.d.querySelectorAll('.sector').length, 4);
  f.click(f.actions()[1]);
  assert.equal(f.screen.dataset.folder, 'characters');
  assert.equal(f.sector('original').getAttribute('aria-pressed'), 'true');
  f.click(f.actions()[1]);
  assert.equal(f.screen.dataset.folder, 'root');
  assert.equal(f.sector('characters').getAttribute('aria-pressed'), 'true');
  assert.equal(f.active().filter(animation => animation.target.classList.contains('folder-sectors')).length, 1);
});

test('keyboard selection, child entry and return work during transition', t => {
  const f = fixture(t);
  f.key(f.sector('games'), 'Enter');
  assert.equal(f.screen.dataset.depth, '0');
  f.key(f.sector('games'), 'ArrowRight');
  assert.equal(f.screen.dataset.folder, 'games');
  f.key(f.sector('rpg'), 'ArrowDown');
  assert.equal(f.d.activeElement, f.sector('adventure'));
  f.key(f.sector('adventure'), 'ArrowLeft');
  assert.equal(f.screen.dataset.folder, 'root');
  assert.equal(f.sector('games').getAttribute('aria-pressed'), 'true');
});

test('save commits its simulated result immediately and dismisses in parallel with icon feedback', t => {
  const f = fixture(t);
  f.actions()[0].focus();
  f.click(f.actions()[0]);
  assert.equal(f.screen.dataset.open, 'false');
  assert.equal(f.menu.inert, true);
  assert.equal(f.menu.getAttribute('aria-hidden'), 'true');
  assert.equal(f.menu.style.pointerEvents, 'none');
  assert.equal(f.menu.hidden, false);
  assert.equal(f.d.activeElement, f.d.querySelector('#replay'));
  assert.match(f.notice(), /일러스트 저장 효과 미리보기 · 실제 저장 없음/);
  const dismissal = f.active().find(animation => animation.target === f.menu);
  assert.equal(dismissal.options.duration, 100);
  const snapshot = f.notice();
  f.click(f.actions()[1]);
  assert.equal(f.notice(), snapshot);
  dismissal.finish();
  assert.equal(f.menu.hidden, true);
});

test('reopening interrupts dismissal and stale completion cannot hide the new menu', t => {
  const f = fixture(t);
  f.click(f.actions()[0]);
  const dismissal = f.active().find(animation => animation.target === f.menu);
  const staleFinish = dismissal.onfinish;
  f.replay();
  assert.equal(dismissal.cancelled, true);
  staleFinish();
  assert.equal(f.menu.hidden, false);
  assert.equal(f.menu.inert, false);
  assert.equal(f.screen.dataset.open, 'true');
  f.tap('photo');
  assert.equal(f.sector('photo').getAttribute('aria-pressed'), 'true');
});

test('temporary save uses the same immediate dismissal without a real download', t => {
  const f = fixture(t);
  f.key(f.actions()[1], ' ');
  assert.equal(f.screen.dataset.open, 'false');
  assert.match(f.notice(), /실제 다운로드 없음/);
  assert.equal(f.active().find(animation => animation.target === f.menu).options.duration, 100);
});

test('reduced motion preserves the complete workflow without scheduling animations', t => {
  const f = fixture(t, true);
  f.enter('characters');
  assert.equal(f.screen.dataset.folder, 'characters');
  f.click(f.actions()[1]);
  assert.equal(f.screen.dataset.folder, 'root');
  f.click(f.actions()[0]);
  assert.equal(f.menu.hidden, true);
  assert.equal(f.animations.length, 0);
  f.replay();
  assert.equal(f.menu.hidden, false);
  assert.equal(f.animations.length, 0);
});

test('enabling reduced motion during dismissal settles cleanup immediately', t => {
  const f = fixture(t);
  f.click(f.actions()[0]);
  f.reduce();
  assert.equal(f.menu.hidden, true);
  assert.equal(f.active().length, 0);
  f.replay();
  assert.equal(f.menu.hidden, false);
  assert.equal(f.active().length, 0);
});

test('internal gaps do not dismiss or save; an outside click dismisses', t => {
  const f = fixture(t), svg = f.d.querySelector('.menu svg');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 440, height: 524 });
  svg.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, clientX: 355, clientY: 265 }));
  assert.equal(f.screen.dataset.open, 'true');
  svg.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, clientX: 100, clientY: 265 }));
  assert.equal(f.screen.dataset.open, 'false');
});

test('folder navigation retains an inert outgoing frame while new choices work immediately', t => {
  const f = fixture(t);
  f.enter('characters');
  const outgoing = f.d.querySelector('.folder-exit');
  assert.ok(outgoing, 'the previous page should remain visible instead of being removed immediately');
  assert.equal(outgoing.getAttribute('aria-hidden'), 'true');
  assert.equal(outgoing.getAttribute('pointer-events'), 'none');
  assert.equal(outgoing.querySelectorAll('[tabindex], [role], [data-id], .sector').length, 0);
  assert.match(outgoing.textContent, /즐겨찾기/);
  f.tap('portraits');
  assert.equal(f.sector('portraits').getAttribute('aria-pressed'), 'true');
  const incoming = f.active().find(animation => animation.target.classList.contains('folder-sectors'));
  assert.equal(incoming.frames[0].opacity, 0);
  assert.ok(incoming.frames.every(frame => !frame.transform));
  f.active().find(animation => animation.target === outgoing).finish();
  assert.equal(outgoing.isConnected, false);
  assert.equal(f.sector('portraits').getAttribute('aria-pressed'), 'true');
});

test('interrupted crossfades keep at most one outgoing frame and clear it on replay', t => {
  const f = fixture(t);
  f.enter('characters');
  const oldLayer = f.d.querySelector('.folder-exit');
  assert.ok(oldLayer);
  const oldMotion = f.active().find(animation => animation.target === oldLayer);
  const staleFinish = oldMotion.onfinish;
  f.enter('original');
  const newLayer = f.d.querySelector('.folder-exit');
  assert.equal(oldLayer.isConnected, false);
  assert.equal(f.d.querySelectorAll('.folder-exit').length, 1);
  staleFinish();
  assert.equal(newLayer.isConnected, true);
  f.replay();
  assert.equal(f.d.querySelectorAll('.folder-exit').length, 0);
});

test('reduced motion or save cleanup removes outgoing visual frames', t => {
  const f = fixture(t);
  f.enter('characters');
  f.reduce();
  assert.equal(f.d.querySelectorAll('.folder-exit').length, 0);
  assert.equal(f.screen.dataset.folder, 'characters');
  const saved = fixture(t);
  saved.enter('characters');
  saved.click(saved.actions()[0]);
  saved.active().find(animation => animation.target === saved.menu).finish();
  assert.equal(saved.d.querySelectorAll('.folder-exit').length, 0);
  assert.equal(saved.active().filter(animation => animation.target.classList.contains('folder-sectors')).length, 0);
});

test('page departure cancels motion and leaves no visible overlay', t => {
  const f = fixture(t);
  f.enter('characters');
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  assert.equal(f.screen.dataset.open, 'false');
  assert.equal(f.menu.hidden, true);
  assert.equal(f.active().length, 0);
});
