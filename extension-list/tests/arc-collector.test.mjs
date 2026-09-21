import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const dom = new JSDOM('<!doctype html><body><button id="opener">image</button></body>', { url: 'https://example.test/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;

const realNow = globalThis.performance.now.bind(globalThis.performance);
let virtualOffset = 0, frameId = 0;
const frameQueue = new Map();
Object.defineProperty(globalThis.performance, 'now', { configurable: true, value: () => realNow() + virtualOffset });
dom.window.requestAnimationFrame = callback => { const id = ++frameId; frameQueue.set(id, callback); return id; };
dom.window.cancelAnimationFrame = id => frameQueue.delete(id);
async function advanceTime(ms) {
  const target = globalThis.performance.now() + ms;
  while (frameQueue.size && globalThis.performance.now() < target) {
    const step = Math.min(16, target - globalThis.performance.now());
    virtualOffset += step;
    const callbacks = [...frameQueue.values()]; frameQueue.clear();
    for (const callback of callbacks) callback(globalThis.performance.now());
    await Promise.resolve();
  }
  const remainder = target - globalThis.performance.now();
  if (remainder > 0) virtualOffset += remainder;
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

await import('../src/classification-tree.js');
await import('../src/arc-collector.js');
const entries = [
  { id: 'games', name: '게임', parentId: null },
  ...Array.from({ length: 6 }, (_, i) => ({ id: `root${i}`, name: `최상위 ${i}`, parentId: null })),
  ...Array.from({ length: 12 }, (_, i) => ({ id: `game${i}`, name: `게임 ${i}`, parentId: 'games' })),
  ...Array.from({ length: 14 }, (_, i) => ({ id: `child${i}`, name: `하위 ${i}`, parentId: 'game7' })),
];
let views = [];
afterEach(() => { for (const view of views) view.dispose(); views = []; delete dom.window.Element.prototype.animate; delete dom.window.matchMedia; });
function mount(options = {}) {
  const view = globalThis.LakomicsArcCollector.mount({ entries, profile: {}, onSave: async () => ({ ok: true }), ...options });
  views.push(view);
  return { ...view, $: selector => view.host.shadowRoot.querySelector(selector), $$: selector => [...view.host.shadowRoot.querySelectorAll(selector)] };
}
const row = (view, id) => view.$(`[data-classification-id="${id}"]`);
const currentIds = view => view.$$('.sector:not(:disabled)[data-classification-id]').map(button => button.dataset.classificationId);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settleDial = () => advanceTime(760);
const visibleIds = view => view.$$('.sector:not(:disabled)[data-classification-id]').map(button => button.dataset.classificationId);
function wheel(view, deltaY = 120, target = null) {
  const event = new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
  (target || view.$('.arc')).dispatchEvent(event);
  return event;
}
const tap = (view, id) => row(view, id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
const enter = (view, id) => { tap(view, id); tap(view, id); };


test('rounded spaced sectors expose a rear surface for branches and icon-only central actions', () => {
  const view = mount();
  const branch = row(view, 'games'), leaf = row(view, 'root0');
  assert.match(branch.style.clipPath, /^path\("M .* Q /);
  assert.notEqual(branch.style.getPropertyValue('--sector-face'), branch.style.clipPath);
  assert.equal(leaf.style.getPropertyValue('--sector-face'), leaf.style.clipPath);
  assert.equal(view.$('.center').firstElementChild.className, 'save-current');
  assert.equal(view.$$('.center svg').length, 2);
  assert.equal(view.$('.destination').hidden, true);
  assert.equal(view.$('.back').getAttribute('aria-label'), '임시 저장');
});

function mockMotion() {
  const animations = [];
  dom.window.Element.prototype.animate = function(frames, options) {
    const animation = { target: this, frames, options, cancelled: false,
      cancel() { this.cancelled = true; }, finish() { this.onfinish?.(); } };
    animations.push(animation); return animation;
  };
  return animations;
}

test('folder crossfade keeps one inert snapshot while new controls work immediately', () => {
  const animations = mockMotion();
  const view = mount();
  assert.equal(animations[0].options.duration, 140);
  enter(view, 'games');
  const outgoing = view.$('.folder-exit-host');
  assert.ok(outgoing.inert);
  assert.equal(outgoing.getAttribute('aria-hidden'), 'true');
  assert.ok(outgoing.shadowRoot.querySelector('.sector[data-classification-id="games"]'));
  assert.equal(view.$$('.sector').length, 14, 'snapshot controls stay outside live queries');
  assert.deepEqual(animations.slice(-2).map(a => a.options.duration), [140, 180]);
  row(view, 'game2').click();
  assert.equal(view.$('.destination').textContent, '게임 2');
  view.$('.back').click();
  assert.equal(outgoing.isConnected, false);
  assert.equal(view.$$('.folder-exit-host').length, 1);
  view.dispose();
  assert.equal(view.host.isConnected, false);
  assert.ok(animations.every(a => a.cancelled));
});

test('dispose is unconditional, silent and blocks late save completion', async () => {
  let complete, closes = 0;
  const opener = document.querySelector('#opener'); opener.focus();
  const view = mount({ onSave: () => new Promise(resolve => { complete = resolve; }), onClose: () => closes++ });
  row(view, 'root0').click(); view.$('.save-current').click();
  view.lockInput(); view.close(); assert.equal(view.host.isConnected, true);
  const focus = document.createElement('button'); document.body.append(focus); focus.focus();
  view.dispose(); view.dispose();
  complete({ ok: true }); await tick();
  assert.equal(closes, 0); assert.equal(document.activeElement, focus);
  assert.equal(view.host.isConnected, false); focus.remove();
});

test('success releases ownership immediately and its exit cannot remove a new menu', async () => {
  const animations = mockMotion(); let complete, closes = 0;
  const first = mount({ onSave: () => new Promise(resolve => { complete = resolve; }), onClose: () => closes++ });
  row(first, 'root0').click(); first.$('.save-current').click();
  assert.equal(animations.some(a => a.options.duration === 100), false);
  complete({ ok: true }); await tick();
  assert.equal(closes, 1); assert.equal(first.host.inert, true);
  const exit = animations.find(a => a.target === first.$('.panel') && a.options.duration === 100);
  assert.ok(exit);
  const second = mount(); exit.finish();
  assert.equal(first.host.isConnected, false); assert.equal(second.host.isConnected, true);
});

test('reduced motion skips entrance and folder fades and wheel coasting', () => {
  const animations = mockMotion();
  dom.window.matchMedia = () => ({ matches: true });
  const view = mount(); enter(view, 'games'); wheel(view);
  assert.equal(animations.length, 0); assert.equal(view.$('.folder-exit-host'), null);
  assert.equal(view.$('.panel').dataset.dialIndex, '1');
  assert.equal(frameQueue.size, 0);
});

test('resize preserves pooled physical slots after dial movement', async () => {
  const view = mount(); enter(view, 'games'); wheel(view); await settleDial();
  const before = [...view.$$('.sector')].map(button => [button, button.style.clipPath]);
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  for (const [button, clip] of before) assert.equal(button.style.clipPath, clip);
});

test('resting runtime labels snap to device pixels for crisp text', () => {
  const previousDpr = dom.window.devicePixelRatio;
  Object.defineProperty(dom.window, 'devicePixelRatio', { configurable: true, value: 2.25 });
  try {
    const view = mount();
    const label = view.$('.dial-label[data-classification-id="root0"]');
    const left = parseFloat(label.style.left) * dom.window.devicePixelRatio;
    const top = parseFloat(label.style.top) * dom.window.devicePixelRatio;
    assert.ok(Math.abs(left - Math.round(left)) < 1e-6, `expected device-pixel left, got ${left}`);
    assert.ok(Math.abs(top - Math.round(top)) < 1e-6, `expected device-pixel top, got ${top}`);
  } finally {
    Object.defineProperty(dom.window, 'devicePixelRatio', { configurable: true, value: previousDpr });
  }
});

test('runtime dial labels are outside clipped sector buttons', () => {
  const view = mount();
  const label = view.$('.dial-label[data-classification-id="root1"]');
  assert.ok(label);
  assert.equal(label.closest('.sector'), null);
});

test('runtime labels travel in the same direction as the rotating sectors', async () => {
  const view = mount();
  const label = view.$('.dial-label[data-classification-id="root1"]');
  const before = parseFloat(label.style.top);
  wheel(view, 53);
  await advanceTime(120);
  const after = parseFloat(label.style.top);
  assert.doesNotMatch(view.$('.arc').style.getPropertyValue('--dial-angle'), /^-/);
  assert.ok(after < before, `expected label and sector to travel upward together, got ${before} -> ${after}`);
});

test('long child lists mount every label once instead of recycling the sector pool', () => {
  const longEntries = [
    { id: 'long-parent', name: '리버스', parentId: null },
    ...Array.from({ length: 24 }, (_, i) => ({ id: `long${i}`, name: `긴 하위 ${i}`, parentId: 'long-parent' })),
  ];
  const view = mount({ entries: longEntries }); enter(view, 'long-parent');
  assert.equal(view.$$('.dial-label[data-classification-id]').length, 24);
  assert.ok(view.$('.dial-label[data-classification-id="long23"]'));
});

test('an incoming label fades through the arc edge instead of switching on at a slot boundary', () => {
  const view = mount(); enter(view, 'games');
  const arc = view.$('.arc');
  arc.getBoundingClientRect = () => ({ left: 700, right: 924, top: 100, bottom: 548, width: 224, height: 448 });
  const point = degrees => {
    const radians = degrees * Math.PI / 180, r = 180;
    return { x: 924 - r * Math.cos(radians), y: 324 + r * Math.sin(radians) };
  };
  for (const [type, degrees] of [['pointerdown', 32], ['pointermove', 2]]) {
    const { x, y } = point(degrees), event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 31 }); arc.dispatchEvent(event);
  }
  const opacity = Number(view.$('.dial-label[data-classification-id="game6"]').style.opacity);
  assert.ok(opacity > 0 && opacity < 1, `expected edge fade opacity, got ${opacity}`);
});

test('resting runtime dial points a sector center at the screen center axis', () => {
  const view = mount();
  const centered = row(view, 'root1');
  assert.equal(centered.dataset.slot, '2');
  const radius = parseFloat(view.$('.panel').style.getPropertyValue('--radius'));
  const labelTop = parseFloat(centered.querySelector('.sector-label').style.top);
  assert.ok(Math.abs(labelTop - radius) < 0.01, `expected label center ${labelTop} to align with radius ${radius}`);
});

test('sixth visible runtime wedge stays fully inside the semicircle while a middle wedge faces center', () => {
  const view = mount();
  const radius = parseFloat(view.$('.panel').style.getPropertyValue('--radius'));
  const centered = row(view, 'root1');
  const last = row(view, 'root4');
  const centerTop = parseFloat(centered.querySelector('.sector-label').style.top);
  const lastTop = parseFloat(last.querySelector('.sector-label').style.top);
  assert.ok(Math.abs(centerTop - radius) < 0.01, `expected middle wedge to face center, got ${centerTop}`);
  assert.ok(lastTop < radius * 1.74, `expected sixth wedge center inside the lower edge, got ${lastTop} for radius ${radius}`);
});

test('runtime root keeps six visible folders and mouse wheel reveals overflow through the dial', async () => {
  const view = mount();
  assert.deepEqual(visibleIds(view), ['games', 'root0', 'root1', 'root2', 'root3', 'root4']);
  assert.equal(view.$('.root-next').hidden, true);
  const event = wheel(view);
  assert.equal(event.defaultPrevented, true);
  await settleDial();
  assert.deepEqual(visibleIds(view), ['root0', 'root1', 'root2', 'root3', 'root4', 'root5']);
  assert.equal(view.$('.panel').dataset.dialIndex, '1');
});

test('runtime child dial uses all six wedges and scrolls without a paging sector', async () => {
  const view = mount(); enter(view, 'games');
  assert.deepEqual(visibleIds(view), ['game0', 'game1', 'game2', 'game3', 'game4', 'game5']);
  assert.equal(view.$('.next'), null);
  wheel(view); await settleDial();
  assert.deepEqual(visibleIds(view), ['game1', 'game2', 'game3', 'game4', 'game5', 'game6']);
});

test('six-item short dial centers the whole group inside the semicircle', () => {
  const shortEntries = [
    { id: 'parent', name: '엔필', parentId: null },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `short${i}`, name: `하위 ${i}`, parentId: 'parent' })),
  ];
  const view = mount({ entries: shortEntries }); enter(view, 'parent');
  const radius = parseFloat(view.$('.panel').style.getPropertyValue('--radius'));
  const first = parseFloat(view.$('.dial-label[data-classification-id="short0"]').style.top);
  const last = parseFloat(view.$('.dial-label[data-classification-id="short5"]').style.top);
  assert.ok(Math.abs(first + last - radius * 2) < 1, `expected symmetric short-list labels, got ${first} + ${last}`);
  assert.ok(last < radius * 1.74, `expected last label fully inside the arc, got ${last} for radius ${radius}`);
});

test('runtime dial compacts preserved null holes instead of showing blank wedges', () => {
  const holeEntries = [
    { id: 'parent', name: '리버스', parentId: null },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: `캐릭터 ${i}`, parentId: 'parent' })),
  ];
  const arcLayout = LakomicsClassificationTree.reconcileArcLayout(holeEntries, {});
  arcLayout.parent.slots = ['c0', 'c1', null, 'c2', 'c3', null, 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'];
  const view = mount({ entries: holeEntries, arcLayout });
  enter(view, 'parent');
  assert.deepEqual(currentIds(view), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
});


test('back restores the parent dial position instead of resetting the ring', async () => {
  const view = mount(); enter(view, 'games');
  wheel(view, 53); await settleDial();
  wheel(view, 53); await settleDial();
  assert.equal(view.$('.panel').dataset.dialIndex, '2');
  enter(view, 'game7');
  assert.equal(view.$('.panel').dataset.depth, '2');
  view.$('.back').click();
  assert.equal(view.$('.panel').dataset.depth, '1');
  assert.equal(view.$('.panel').dataset.dialIndex, '2');
  assert.ok(row(view, 'game7'));
  view.$('.back').click();
  assert.equal(view.$('.panel').dataset.depth, '0');
});

test('pinned nested folders return straight to the root page they came from', () => {
  const view = mount({ profile: { pinnedClassificationIds: ['game7'] } });
  enter(view, 'game7'); assert.match(view.$('.path').textContent, /게임 \/ 게임 7/);
  view.$('.back').click(); assert.equal(view.$('.back').disabled, true);
  assert.equal(view.$('.save-current').disabled, false);
  assert.equal(view.$('.destination').textContent, '게임 7');
  assert.equal(row(view, 'game7').dataset.slot, '0');
});

test('leaf taps only select and central save sends exactly that destination', async () => {
  const saved = []; const view = mount({ onSave: async id => { saved.push(id); return { ok: true }; } });
  enter(view, 'games'); row(view, 'game2').click();
  assert.deepEqual(saved, []);
  assert.match(view.$('.save-current').getAttribute('aria-label'), /게임 \/ 게임 2에 저장/);
  view.$('.save-current').click(); await tick();
  assert.deepEqual(saved, ['game2']); assert.equal(view.host.isConnected, false);
});

test('branch destinations remain saveable and failures retain selection and prevent duplicate requests', async () => {
  let complete, calls = 0;
  const view = mount({ onSave: () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
  enter(view, 'games'); wheel(view); await settleDial();
  view.$('.save-current').click(); view.$('.save-current').click();
  assert.equal(calls, 1); assert.equal(view.$('.back').disabled, true);
  view.host.shadowRoot.querySelector('.backdrop').click();
  assert.equal(view.host.isConnected, true);
  complete({ ok: false, message: 'offline' }); await tick();
  assert.equal(view.host.isConnected, true); assert.equal(view.$('.notice').textContent, 'offline');
  assert.equal(view.$('.panel').dataset.dialIndex, '1'); assert.equal(view.$('.destination').textContent, '게임');
  view.$('.save-current').click(); assert.equal(calls, 2);
  complete({ ok: true }); await tick(); assert.equal(view.host.isConnected, false);
});

test('opening finger lock blocks navigation, saving, temporary action and dismissal until release', () => {
  let temporary = 0;
  const view = mount({ inputLocked: true, onTemporary: () => { temporary++; } });
  enter(view, 'games'); view.$('.temporary').click(); view.host.shadowRoot.querySelector('.backdrop').click();
  assert.equal(view.$('.panel').dataset.depth, '0'); assert.equal(temporary, 0); assert.equal(view.host.isConnected, true);
  view.unlockInput(); enter(view, 'games'); assert.equal(view.$('.panel').dataset.depth, '1');
});

test('central temporary save stays root-only and blocks back double taps before becoming synchronous again', async () => {
  let temporary = 0, permanent = 0;
  const view = mount({ onTemporary: () => { temporary++; return false; }, onSave: () => { permanent++; } });
  assert.equal(view.$('footer .temporary'), null);
  assert.ok(view.$('.center .temporary'));
  enter(view, 'games'); assert.equal(view.$('.temporary'), null);
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  let queuedTemporaryTimer = null;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 400) return realSetTimeout(callback, delay, ...args);
    queuedTemporaryTimer = () => callback(...args);
    return queuedTemporaryTimer;
  };
  globalThis.clearTimeout = id => { if (id === queuedTemporaryTimer) queuedTemporaryTimer = null; else realClearTimeout(id); };
  try {
    view.$('.back').click(); view.$('.back').click();
    assert.equal(temporary, 0);
    assert.equal(view.$('.temporary').disabled, true);
    await advanceTime(420);
    const runTemporaryTimer = queuedTemporaryTimer; queuedTemporaryTimer = null; runTemporaryTimer?.();
    view.$('.temporary').click();
    assert.equal(temporary, 1); assert.equal(permanent, 0); assert.equal(view.host.isConnected, true);
  } finally {
    globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
  }
});

test('the opening press chooses the nearest screen edge without direction or close buttons', () => {
  const left = mount({ origin: { x: 100, y: 300 } });
  assert.equal(left.$('.panel').dataset.side, 'left');
  assert.equal(left.$('.panel').style.left, '0px');
  assert.equal(left.$('.side'), null); assert.equal(left.$('.close'), null);
  left.close();
  const right = mount({ origin: { x: 900, y: 300 } });
  assert.equal(right.$('.panel').dataset.side, 'right');
  assert.equal(right.$('.panel').style.right, '0px');
});

test('drag or cancelled touch never selects or saves a sector', () => {
  const view = mount(), button = row(view, 'games');
  function pointer(type, x) {
    const e = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 20 });
    Object.defineProperty(e, 'pointerId', { value: 1 }); button.dispatchEvent(e);
  }
  pointer('pointerdown', 10); pointer('pointermove', 60); pointer('pointerup', 60); button.click();
  assert.equal(view.$('.panel').dataset.depth, '0');
  pointer('pointerdown', 10); pointer('pointercancel', 10); button.click();
  assert.equal(view.$('.panel').dataset.depth, '0');
});

test('a simple sector press does not capture the pointer away from its button click target', () => {
  const view = mount(), arc = view.$('.arc'), button = row(view, 'games');
  let captures = 0; arc.setPointerCapture = () => { captures += 1; };
  const event = new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 740, clientY: 200 });
  Object.defineProperty(event, 'pointerId', { value: 21 });
  button.dispatchEvent(event);
  assert.equal(captures, 0);
});

test('arc drag rotates the runtime dial and settles on the next visible group', async () => {
  const view = mount(), arc = view.$('.arc');
  arc.getBoundingClientRect = () => ({ left: 700, right: 924, top: 100, bottom: 548, width: 224, height: 448 });
  const point = degrees => {
    const radians = degrees * Math.PI / 180, r = 180;
    return { x: 924 - r * Math.cos(radians), y: 324 + r * Math.sin(radians) };
  };
  function pointer(type, degrees) {
    const { x, y } = point(degrees);
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 7 }); arc.dispatchEvent(event);
  }
  pointer('pointerdown', 32); pointer('pointermove', -12); pointer('pointerup', -12);
  await settleDial();
  assert.equal(view.$('.panel').dataset.dialIndex, '1');
  assert.deepEqual(visibleIds(view), ['root0', 'root1', 'root2', 'root3', 'root4', 'root5']);
  assert.equal(view.$('.save-current').disabled, true);
});

test('a Chromium-sized mouse wheel notch advances one dial slot', async () => {
  const view = mount();
  const event = wheel(view, 53);
  assert.equal(event.defaultPrevented, true);
  await settleDial();
  assert.equal(view.$('.panel').dataset.dialIndex, '1');
  assert.deepEqual(visibleIds(view), ['root0', 'root1', 'root2', 'root3', 'root4', 'root5']);
});

test('one fast wheel burst advances only one child slot instead of racing through several', async () => {
  const view = mount(); enter(view, 'games');
  wheel(view, 53); wheel(view, 53); wheel(view, 53);
  await advanceTime(760);
  assert.equal(view.$('.panel').dataset.dialIndex, '1');
  assert.deepEqual(visibleIds(view), ['game1', 'game2', 'game3', 'game4', 'game5', 'game6']);
});

test('a wheel step keeps the original label set readable for the first 120 ms', async () => {
  const view = mount(); enter(view, 'games');
  wheel(view, 53);
  await advanceTime(120);
  assert.equal(view.$('.panel').dataset.dialIndex, '0');
  assert.equal(row(view, 'game0').disabled, false);
  await advanceTime(640);
  assert.equal(view.$('.panel').dataset.dialIndex, '1');
});

test('wheel animation keeps the same label nodes connected until the step settles', async () => {
  const view = mount(); enter(view, 'games');
  const game2 = row(view, 'game2'), game3 = row(view, 'game3');
  wheel(view, 53);
  await advanceTime(320);
  assert.equal(game2.isConnected, true);
  assert.equal(game3.isConnected, true);
  assert.equal(row(view, 'game2'), game2);
  assert.equal(row(view, 'game3'), game3);
});

test('a visible label keeps one physical dial slot while crossing the half-step boundary', async () => {
  const view = mount(); enter(view, 'games');
  const game2 = row(view, 'game2'), slot = game2.dataset.slot;
  wheel(view, 53);
  await advanceTime(300);
  assert.ok(Number(view.$('.panel').dataset.dialPosition) > 0.5);
  assert.equal(row(view, 'game2'), game2);
  assert.equal(game2.dataset.slot, slot);
});

test('settling into a detent keeps visible folder nodes instead of swapping the ring', async () => {
  const view = mount(); enter(view, 'games');
  const game2 = row(view, 'game2'), game3 = row(view, 'game3');
  wheel(view, 53);
  await settleDial();
  assert.equal(view.$('.panel').dataset.dialIndex, '1');
  assert.equal(game2.isConnected, true);
  assert.equal(game3.isConnected, true);
  assert.equal(row(view, 'game2'), game2);
  assert.equal(row(view, 'game3'), game3);
});

test('wheel over the fixed center does not rotate or swallow page scrolling', async () => {
  const view = mount();
  const event = wheel(view, 120, view.$('.center'));
  assert.equal(event.defaultPrevented, false);
  await advanceTime(100);
  assert.equal(view.$('.panel').dataset.dialIndex, '0');
  assert.deepEqual(visibleIds(view), ['games', 'root0', 'root1', 'root2', 'root3', 'root4']);
});

test('left-edge arc drag keeps the same logical next-folder direction', async () => {
  const view = mount({ origin: { x: 100, y: 300 } }), arc = view.$('.arc');
  arc.getBoundingClientRect = () => ({ left: 0, right: 224, top: 100, bottom: 548, width: 224, height: 448 });
  const point = degrees => {
    const radians = degrees * Math.PI / 180, r = 180;
    return { x: r * Math.cos(radians), y: 324 + r * Math.sin(radians) };
  };
  for (const [type, degrees] of [['pointerdown', 32], ['pointermove', -12], ['pointerup', -12]]) {
    const { x, y } = point(degrees), event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 9 }); arc.dispatchEvent(event);
  }
  await settleDial();
  assert.equal(view.$('.panel').dataset.dialIndex, '1');
  assert.deepEqual(visibleIds(view), ['root0', 'root1', 'root2', 'root3', 'root4', 'root5']);
});

test('Escape restores focus and a single-page child has no paging sector', () => {
  document.getElementById('opener').focus();
  const view = mount({ entries: entries.slice(0, 9) }); enter(view, 'games');
  assert.equal(view.$('.next'), null); assert.deepEqual(currentIds(view), ['game0', 'game1']);
  view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(view.host.isConnected, false); assert.equal(document.activeElement.id, 'opener');
});

test('clicking outside the curved edge dismisses the menu, including transparent panel corners', () => {
  const view = mount();
  view.$('.arc').getBoundingClientRect = () => ({ left: 700, right: 924, top: 100, bottom: 548, width: 224, height: 448 });
  const click = (x, y) => view.$('.panel').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  click(710, 324);
  assert.equal(view.host.isConnected, true);
  click(710, 110);
  assert.equal(view.host.isConnected, false);
  assert.equal(view.$('.close'), null);
});

test('hiding a parent removes its entire subtree including pinned shortcuts and restoration preserves positions', () => {
  const profile = { pinnedClassificationIds: ['game7'] };
  const arcLayout = LakomicsClassificationTree.reconcileArcLayout(entries, profile);
  const view = mount({ profile, arcLayout, hiddenClassificationIds: ['games'] });
  assert.equal(row(view, 'games'), null);
  assert.equal(row(view, 'game7'), null);
  assert.deepEqual(currentIds(view), ['root0', 'root1', 'root2', 'root3', 'root4', 'root5']);
  view.update({ hiddenClassificationIds: [] });
  assert.equal(row(view, 'game7').dataset.slot, '0');
  assert.equal(row(view, 'games').dataset.slot, '1');
});

function editor(options = {}) {
  const container = document.createElement('div'); document.body.append(container);
  const state = { classifications: { entries }, profile: {}, hiddenClassificationIds: [], ...options.state };
  state.arcLayout = LakomicsClassificationTree.reconcileArcLayout(entries, state.profile);
  const changes = [];
  const view = mount({ ...state, container,
    onReorder: async (parentId, ids) => {
      changes.push({ parentId, ids });
      state.profile = { ...state.profile, listOrder: { ...state.profile.listOrder, [parentId ?? '__root__']: ids } };
      state.arcLayout = LakomicsClassificationTree.reconcileArcLayout(entries, state.profile, state.arcLayout);
      return { ok: true, state };
    },
    onHide: async id => { state.hiddenClassificationIds.push(id); return { ok: true, state }; },
    ...options,
  });
  return { ...view, changes, state };
}

test('embedded editor selects branches first, opens explicitly, moves across pages, and never saves media', async () => {
  let saves = 0;
  const view = editor({ onSave: () => { saves++; } });
  assert.equal(view.$('.panel').getAttribute('aria-modal'), null);
  assert.equal(view.host.parentElement.tagName, 'DIV');
  row(view, 'games').click();
  assert.equal(view.$('.panel').dataset.depth, '0');
  view.$('.save-current').click();
  assert.equal(view.$('.panel').dataset.depth, '1');
  row(view, 'game4').click();
  assert.equal(view.$('.save-current').disabled, true);
  view.$('.move-after').click(); await tick();
  assert.equal(view.$('.panel').dataset.page, '2');
  assert.equal(row(view, 'game4').dataset.slot, '0');
  assert.equal(view.changes[0].ids[4], 'game5');
  view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  assert.equal(saves, 0);
  view.$('.back').click();
  assert.equal(view.$('.panel').dataset.depth, '0');
  assert.equal(row(view, 'games').getAttribute('aria-pressed'), 'true');
});

test('editor interleaves shortcuts and roots, hides folders, and leaves normal Tab navigation intact', async () => {
  const view = editor({ state: { profile: { pinnedClassificationIds: ['game7'] } } });
  row(view, 'game7').click(); view.$('.move-after').click(); await tick();
  assert.equal(row(view, 'games').dataset.slot, '0');
  assert.equal(row(view, 'game7').dataset.slot, '1');
  row(view, 'games').click(); view.$('.hide-folder').click(); await tick();
  assert.equal(row(view, 'games'), null); assert.equal(row(view, 'game7'), null);
  assert.equal(view.$('.hide-folder').disabled, true);
  const e = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  view.$('.panel').dispatchEvent(e); assert.equal(e.defaultPrevented, false);
  view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(view.host.isConnected, true);
});

test('failed editor changes retain order and selection and reject repeated changes while pending', async () => {
  let finish, calls = 0;
  const view = editor({ onReorder: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  row(view, 'root0').click(); view.$('.move-before').click(); view.$('.move-before').click();
  assert.equal(calls, 1); assert.equal(view.$('.hide-folder').disabled, true);
  finish({ ok: false }); await tick();
  assert.equal(row(view, 'root0').dataset.slot, '1');
  assert.equal(row(view, 'root0').getAttribute('aria-pressed'), 'true');
  assert.match(view.$('.notice').textContent, /변경하지 못했습니다/);
});


test('single tap selects any branch for saving and only a double tap enters its children', async () => {
  const saved = [], view = mount({ onSave: async id => { saved.push(id); return { ok: true }; } });
  tap(view, 'games');
  assert.equal(view.$('.panel').dataset.depth, '0');
  assert.equal(view.$('.destination').textContent, '게임');
  view.$('.save-current').click(); await tick();
  assert.deepEqual(saved, ['games']);
  const other = mount();
  tap(other, 'games'); tap(other, 'games');
  assert.equal(other.$('.panel').dataset.depth, '1');
  assert.equal(other.$('.destination').textContent, '게임');
});

test('slow repeated taps keep selecting and keyboard users open branches with ArrowRight', async () => {
  const view = mount(); tap(view, 'games');
  await advanceTime(370);
  tap(view, 'games');
  assert.equal(view.$('.panel').dataset.depth, '0');
  row(view, 'games').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(view.$('.panel').dataset.depth, '1');
});


test('pinned shortcuts disappear from the child dial and return to canonical order when unpinned', async () => {
  const profile = { pinnedClassificationIds: ['game1', 'game7'] };
  const arcLayout = LakomicsClassificationTree.reconcileArcLayout(entries, profile);
  const view = mount({ profile, arcLayout });
  assert.ok(row(view, 'game1')); assert.ok(row(view, 'game7'));
  enter(view, 'games');
  assert.deepEqual(currentIds(view), ['game0', 'game2', 'game3', 'game4', 'game5', 'game6']);
  wheel(view); await settleDial();
  assert.deepEqual(currentIds(view), ['game2', 'game3', 'game4', 'game5', 'game6', 'game8']);
  view.update({ profile: { pinnedClassificationIds: [] } });
  wheel(view, -120); await settleDial();
  assert.equal(row(view, 'game1').dataset.slot, '1');
  assert.equal(view.tree.path('game7')[0].id, 'games');
});

test('a parent with only pinned children remains saveable without offering an empty child screen', () => {
  const view = mount({ entries: entries.slice(0, 9), profile: { pinnedClassificationIds: ['game0', 'game1'] } });
  assert.equal(row(view, 'games').classList.contains('branch'), false);
  tap(view, 'games'); tap(view, 'games');
  assert.equal(view.$('.panel').dataset.depth, '0');
  assert.equal(view.$('.save-current').disabled, false);
});

test('settings preview uses the same shortcut deduplication and never enables temporary saving', () => {
  let calls = 0;
  const view = editor({ state: { profile: { pinnedClassificationIds: ['game1'] } }, onTemporary: () => { calls++; } });
  assert.equal(view.$('.temporary').disabled, true);
  view.$('.temporary').click(); assert.equal(calls, 0);
  row(view, 'games').click(); view.$('.save-current').click();
  assert.deepEqual(currentIds(view), ['game0', 'game2', 'game3', 'game4', 'game5']);
});

test('temporary download waits for the result, prevents duplicate clicks and allows retry on failure', async () => {
  let finish, calls = 0;
  const view = mount({ onTemporary: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  view.$('.back').click(); view.$('.back').click();
  assert.equal(calls, 1); assert.equal(view.host.isConnected, true); assert.equal(view.$('.back').disabled, true);
  finish(false); await tick(); assert.equal(view.host.isConnected, true); assert.equal(view.$('.back').disabled, false);
  view.$('.back').click(); finish(true); await tick(); assert.equal(view.host.isConnected, false);
});
