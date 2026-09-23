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
const currentIds = view => view.$$('.sector:not(:disabled):not([aria-hidden=true])[data-classification-id]').map(button => button.dataset.classificationId);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settleDial = () => advanceTime(760);
const visibleIds = view => view.$$('.sector:not(:disabled):not([aria-hidden=true])[data-classification-id]').map(button => button.dataset.classificationId);
function wheel(view, deltaY = 120, target = null) {
  const event = new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
  (target || view.$('.arc')).dispatchEvent(event);
  return event;
}
const tap = (view, id) => row(view, id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
const enter = (view, id) => { tap(view, id); tap(view, id); };
const key = (view, value, options = {}) => {
  const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  (options.target || view.$('.panel')).dispatchEvent(event); return event;
};
// Back history/breadcrumb tests now use the retained keyboard action: live mode
// no longer has a lower button. Editor tests still exercise that button.
const back = view => key(view, 'Backspace');
const temporary = view => key(view, 't');
function centerPointer(view, pointerType = 'touch') {
  const button = view.$('.save-current');
  return (type, dy = 0, dx = 0, target = button, id = 81) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100 + dx, clientY: 200 + dy, button: 0 });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType } });
    target.dispatchEvent(event); return event;
  };
}
function centerDrag(view, dy, dx = 0, pointerType = 'touch') {
  const pointer = centerPointer(view, pointerType);
  pointer('pointerdown'); pointer('pointermove', dy, dx); pointer('pointerup', dy, dx);
}
const centerWheel = (view, deltaY, options = {}) => {
  const event = new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...options });
  view.$('.save-current').dispatchEvent(event); return event;
};


test('rounded spaced sectors expose a rear surface for branches and icon-only central actions', () => {
  const view = mount();
  const branch = row(view, 'games'), leaf = row(view, 'root0');
  assert.match(branch.style.clipPath, /^path\("M .* Q /);
  assert.notEqual(branch.style.getPropertyValue('--sector-face'), branch.style.clipPath);
  assert.equal(leaf.style.getPropertyValue('--sector-face'), leaf.style.clipPath);
  assert.equal(view.$('.center').firstElementChild.className, 'save-current');
  assert.equal(view.$$('.center svg').length, 2);
  assert.equal(view.$('.center-preview').style.opacity, '0');
  assert.equal(view.$$('.center button').length, 1);
  assert.equal(view.$('.destination').hidden, true);
  assert.equal(view.$('.back'), null);
  assert.equal(view.$('.save-current').getAttribute('aria-label'), '저장');
  assert.equal(view.$('.save-current').getAttribute('aria-description'), '위로 끌어 뒤로, 아래로 끌어 임시저장');
  assert.equal(view.$('[title]'), null);
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
  back(view);
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
  for (const [type, degrees] of [['pointerdown', 32], ['pointermove', 20]]) {
    const { x, y } = point(degrees), event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 31 }); arc.dispatchEvent(event);
  }
  const opacity = Number(view.$('.dial-label[data-classification-id="game6"]').style.opacity);
  assert.ok(opacity > 0 && opacity < 1, `expected edge fade opacity, got ${opacity}`);
});

test('six visible runtime wedges are centered with half a hidden wedge at either semicircle edge', () => {
  const view = mount();
  const radius = parseFloat(view.$('.panel').style.getPropertyValue('--radius'));
  const first = row(view, 'games'), last = row(view, 'root4'), peek = row(view, 'root5');
  const top = button => parseFloat(button.querySelector('.sector-label').style.top);
  assert.ok(Math.abs(top(first) + top(last) - radius * 2) < .01);
  assert.ok(top(last) < radius * 1.74, 'sixth wedge is fully inside the arc');
  assert.ok(Math.abs(parseFloat(peek.querySelector('.sector-label').style.left) - radius) < .01,
    'next wedge is centered on the straight semicircle edge and clipped in half');
  assert.match(view.$('style').textContent, /:host\(:not\(\.editing\)\) \.arc\{overflow:hidden/);
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
  back(view);
  assert.equal(view.$('.panel').dataset.depth, '1');
  assert.equal(view.$('.panel').dataset.dialIndex, '2');
  assert.ok(row(view, 'game7'));
  back(view);
  assert.equal(view.$('.panel').dataset.depth, '0');
});

test('pinned nested folders return straight to the root page they came from', () => {
  const view = mount({ profile: { pinnedClassificationIds: ['game7'] } });
  enter(view, 'game7'); assert.match(view.$('.path').textContent, /게임 \/ 게임 7/);
  back(view); assert.equal(view.$('.panel').dataset.depth, '0');
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
  assert.equal(calls, 1); assert.equal(view.$('.save-current').getAttribute('aria-disabled'), 'true');
  view.host.shadowRoot.querySelector('.backdrop').click();
  assert.equal(view.host.isConnected, true);
  complete({ ok: false, message: 'offline' }); await tick();
  assert.equal(view.host.isConnected, true); assert.equal(view.$('.notice').textContent, 'offline');
  assert.equal(view.$('.panel').dataset.dialIndex, '1'); assert.equal(view.$('.destination').textContent, '게임');
  view.$('.save-current').click(); assert.equal(calls, 2);
  complete({ ok: true }); await tick(); assert.equal(view.host.isConnected, false);
});

test('opening finger lock blocks navigation, saving, temporary action and dismissal until release', () => {
  let calls = 0;
  const view = mount({ inputLocked: true, onTemporary: () => { calls++; } });
  enter(view, 'games'); temporary(view); view.host.shadowRoot.querySelector('.backdrop').click();
  assert.equal(view.$('.panel').dataset.depth, '0'); assert.equal(calls, 0); assert.equal(view.host.isConnected, true);
  view.unlockInput(); enter(view, 'games'); assert.equal(view.$('.panel').dataset.depth, '1');
});

// The old root-only lower button and 400 ms mode-switch guard are gone.
// Temporary must work immediately after Back and inside a folder.
test('temporary is available inside folders and immediately after Back without a guard', async () => {
  let calls = 0;
  const view = mount({ onTemporary: () => { calls++; return false; } });
  enter(view, 'games'); temporary(view); await tick();
  assert.equal(calls, 1); assert.equal(view.$('.panel').dataset.depth, '1');
  back(view); temporary(view); await tick();
  assert.equal(calls, 2); assert.equal(view.$('.panel').dataset.depth, '0');
  assert.equal(view.$('.back'), null); assert.equal(view.host.isConnected, true);
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
  assert.equal(view.$('.save-current').getAttribute('aria-disabled'), 'true');
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

test('a wheel step decelerates toward its chosen slot immediately and finishes in 220 ms', async () => {
  const view = mount(); enter(view, 'games');
  wheel(view, 53);
  await advanceTime(120);
  const position = Number(view.$('.panel').dataset.dialPosition);
  assert.ok(position > .5 && position < 1);
  assert.ok(view.$('.dial-label[data-classification-id="game0"]').isConnected);
  await advanceTime(120);
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

test('wheel over the fixed center is prevented without rotating the dial', async () => {
  const view = mount();
  const event = wheel(view, 120, view.$('.center'));
  // The center now consumes vertical wheel input even when Temporary is unavailable.
  assert.equal(event.defaultPrevented, true);
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
  tap(view, 'games');
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

test('temporary download waits for the result, prevents duplicate actions and allows retry on failure', async () => {
  let finish, calls = 0;
  const view = mount({ onTemporary: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  temporary(view); temporary(view);
  assert.equal(calls, 1); assert.equal(view.host.isConnected, true); assert.equal(view.$('.save-current').getAttribute('aria-disabled'), 'true');
  finish(false); await tick(); assert.equal(view.host.isConnected, true); assert.equal(view.$('.save-current').disabled, false);
  temporary(view); finish(true); await tick(); assert.equal(view.host.isConnected, false);
});

function assertMirroredPath(right, left, diameter) {
  const commands = value => [...value.matchAll(/([MLQA])\s+([\d.\s-]+)/g)].map(([, command, numbers]) => [command, numbers.trim().split(/\s+/).map(Number)]);
  const r = commands(right), l = commands(left);
  assert.equal(l.length, r.length);
  assert.ok(r.length > 5);
  for (let i = 0; i < r.length; i++) {
    const [command, values] = r[i], [other, mirrored] = l[i];
    assert.equal(other, command);
    assert.equal(mirrored.length, values.length);
    const start = command === 'A' ? 5 : 0;
    if (command === 'A') {
      assert.deepEqual(mirrored.slice(0, 4), values.slice(0, 4));
      assert.equal(mirrored[4], 1 - values[4], 'arc sweep reverses without a transform');
    }
    for (let j = start; j < values.length; j += 2) {
      assert.ok(Math.abs(values[j] + mirrored[j] - diameter) < .021, `${command} x coordinates mirror`);
      assert.equal(mirrored[j + 1], values[j + 1]);
    }
  }
}

test('left sectors, branch faces and labels use direct mirrored coordinates and opposite ring rotation', async () => {
  dom.window.matchMedia = () => ({ matches: true });
  const right = mount({ origin: { x: 900 } }), left = mount({ origin: { x: 10 } });
  const radius = parseFloat(right.$('.panel').style.getPropertyValue('--radius'));
  assert.equal(left.$('.panel').style.getPropertyValue('--dial-left'), `${-radius}px`);
  for (const r of right.$$('.sector')) {
    const l = left.$(`.sector[data-slot="${r.dataset.slot}"]`);
    assertMirroredPath(r.style.clipPath, l.style.clipPath, radius * 2);
    assertMirroredPath(r.style.getPropertyValue('--sector-face'), l.style.getPropertyValue('--sector-face'), radius * 2);
    const rl = r.querySelector('.sector-label'), ll = l.querySelector('.sector-label');
    assert.ok(Math.abs(parseFloat(rl.style.left) + parseFloat(ll.style.left) - radius * 2) < 1e-6);
    assert.equal(ll.style.top, rl.style.top);
  }
  function compareLabels() {
    for (const r of right.$$('.dial-label')) {
      const l = left.$(`.dial-label[data-dial-index="${r.dataset.dialIndex}"]`);
      if (Number(r.style.opacity) === 0) continue;
      assert.ok(Math.abs(parseFloat(r.style.left) + parseFloat(l.style.left) - radius) <= 1);
      assert.equal(l.style.top, r.style.top);
      assert.equal(l.style.opacity, r.style.opacity);
    }
  }
  compareLabels();
  // Keyboard steps exercise the same settled paint without timing differences.
  for (const view of [right, left]) {
    view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
  }
  await settleDial();
  assert.equal(left.$('.panel').dataset.dialIndex, right.$('.panel').dataset.dialIndex);
  assert.equal(parseFloat(left.$('.arc').style.getPropertyValue('--dial-angle')), -parseFloat(right.$('.arc').style.getPropertyValue('--dial-angle')));
  compareLabels();
});

test('left live styles and outgoing snapshots never mirror text or icons', () => {
  mockMotion();
  const view = mount({ origin: { x: 10 } });
  const glyphs = view.$$('.center path').map(path => path.getAttribute('d'));
  const right = mount();
  assert.deepEqual(glyphs, right.$$('.center path').map(path => path.getAttribute('d')));
  enter(view, 'games'); enter(right, 'games');
  assert.equal(view.$('.save-current path').getAttribute('d'), right.$('.save-current path').getAttribute('d'));
  const snapshot = view.$('.folder-exit-host').shadowRoot;
  for (const root of [view.host.shadowRoot, snapshot]) {
    for (const element of root.querySelectorAll('style,[style]')) {
      assert.doesNotMatch(element.tagName === 'STYLE' ? element.textContent : element.getAttribute('style'), /scale(?:X|Y)?\(\s*-1/);
    }
    assert.equal(root.querySelector('[title]'), null);
  }
  const rightLabel = right.$('.folder-exit-host').shadowRoot.querySelector('.dial-label');
  assert.equal(parseFloat(snapshot.querySelector('.dial-label').style.left) + parseFloat(rightLabel.style.left), parseFloat(view.$('.panel').style.getPropertyValue('--radius')));
});

test('left resting labels snap directly to device pixels at fractional device scales', () => {
  const previousDpr = dom.window.devicePixelRatio;
  try {
    for (const dpr of [1, 2.25]) {
      Object.defineProperty(dom.window, 'devicePixelRatio', { configurable: true, value: dpr });
      const view = mount({ origin: { x: 10 } });
      for (const label of view.$$('.dial-label')) {
        if (Number(label.style.opacity) === 0) continue;
        for (const coordinate of ['left', 'top']) {
          const value = parseFloat(label.style[coordinate]) * dpr;
          assert.ok(Math.abs(value - Math.round(value)) < 1e-6);
        }
      }
    }
  } finally { Object.defineProperty(dom.window, 'devicePixelRatio', { configurable: true, value: previousDpr }); }
});

const peekIds = view => ['before', 'after'].map(end => view.$(`.sector[data-peek="${end}"]`)?.dataset.classificationId ?? null);

test('peeks show the next hidden folders in order at start, middle and end on both sides without layout reads', async () => {
  for (const x of [10, 900]) {
    const view = mount({ origin: { x } });
    assert.deepEqual(peekIds(view), [null, 'root5']);
    assert.equal(view.$('.arc').getAttribute('aria-description'), '폴더 7개 · 휠이나 드래그로 더 보기');
    assert.equal(view.$('.overflow-cue'), null);
    assert.doesNotMatch(view.$('style').textContent, /overflow-cue/);
    view.$('.arc').getBoundingClientRect = () => { throw new Error('wheel paint must not measure layout'); };
    wheel(view); await settleDial();
    assert.deepEqual(peekIds(view), ['games', null]);
    wheel(view, -120); await settleDial();
    assert.deepEqual(peekIds(view), [null, 'root5']);
    delete view.$('.arc').getBoundingClientRect;
    enter(view, 'games');
    const incoming = row(view, 'game6'), label = view.$('.dial-label[data-classification-id="game6"]');
    assert.deepEqual(peekIds(view), [null, 'game6']);
    wheel(view); await settleDial();
    assert.deepEqual(peekIds(view), ['game0', 'game7']);
    assert.equal(row(view, 'game6'), incoming);
    assert.equal(incoming.getAttribute('aria-hidden'), null);
    assert.ok(visibleIds(view).includes('game6'));
    assert.equal(view.$('.dial-label[data-classification-id="game6"]'), label);
    for (let i = 0; i < 5; i++) { wheel(view); await settleDial(); }
    assert.deepEqual(peekIds(view), ['game5', null]);
    back(view);
    assert.deepEqual(peekIds(view), [null, 'root5']);
    view.update({ classifications: { entries: entries.filter(entry => entry.id !== 'root5') } });
    assert.deepEqual(peekIds(view), [null, null]);
    assert.equal(view.$('.arc').getAttribute('aria-description'), null);
  }
});

test('fitting lists and the editor have no peeks; reduced motion keeps peeks and jumps immediately', () => {
  for (const count of [0, 1, 2, 3, 4, 5, 6]) {
    const view = mount({ entries: entries.filter(entry => entry.parentId === null).slice(0, count) });
    assert.deepEqual(peekIds(view), [null, null]);
    assert.equal(view.$('.arc').getAttribute('aria-description'), null);
  }
  const preview = editor({ origin: { x: 10 } });
  assert.equal(preview.$('.panel').dataset.side, 'right');
  assert.equal(preview.$('.sector[data-peek]'), null);
  dom.window.matchMedia = () => ({ matches: true });
  for (const x of [10, 900]) {
    const view = mount({ origin: { x } }), incoming = row(view, 'root5');
    assert.deepEqual(peekIds(view), [null, 'root5']);
    incoming.click();
    assert.equal(view.$('.panel').dataset.dialPosition, '1.000');
    assert.equal(row(view, 'root5'), incoming);
    assert.deepEqual(peekIds(view), ['games', null]);
    assert.equal(frameQueue.size, 0);
  }
});

test('peek taps move exactly one wheel notch without selecting, and drags beginning on peeks rotate the dial', () => dialClock(advance => {
  for (const x of [10, 900]) {
    const view = mount({ origin: { x } }); enter(view, 'games'); row(view, 'game2').click();
    const pointer = dialPointer(view), incoming = row(view, 'game6');
    pointer('pointerdown', 0, incoming); pointer('pointerup', 0, incoming); incoming.click();
    assert.equal(dialPosition(view), 0);
    advance(112); assert.ok(dialPosition(view) > 0 && dialPosition(view) < 1);
    advance(108); assert.equal(dialPosition(view), 1);
    assert.equal(view.$('.destination').textContent, '게임 2');
    row(view, 'game0').click(); advance(220);
    assert.equal(dialPosition(view), 0);
    assert.equal(view.$('.destination').textContent, '게임 2');
    pointer('pointerdown', 0, incoming); advance(40); pointer('pointermove', .7, incoming);
    assert.ok(Math.abs(dialPosition(view) - .7) < .001);
    pointer('pointerup', .7, incoming); incoming.click(); advance(700);
    assert.equal(view.$('.destination').textContent, '게임 2');
    view.dispose();
  }
}));

test('peeks are aria-hidden and skipped by initial focus, Tab and arrow navigation', () => {
  dom.window.matchMedia = () => ({ matches: true });
  const view = mount(); enter(view, 'games');
  row(view, 'game0').focus(); wheel(view);
  assert.notEqual(view.host.shadowRoot.activeElement, row(view, 'game0'), 'a departing wedge releases focus before becoming aria-hidden');
  for (const peek of view.$$('.sector[data-peek]')) {
    assert.equal(peek.getAttribute('aria-hidden'), 'true');
    assert.equal(peek.tabIndex, -1);
    const down = new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    peek.dispatchEvent(down); assert.equal(down.defaultPrevented, true, 'pointer press cannot focus the peek');
    peek.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
  }
  const first = row(view, 'game1'); first.focus();
  for (const key of ['Tab', 'ArrowDown', 'ArrowUp']) for (let i = 0; i < 16; i++) {
    view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    assert.notEqual(view.host.shadowRoot.activeElement?.getAttribute('aria-hidden'), 'true');
  }
  view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
  assert.equal(view.host.shadowRoot.activeElement, row(view, 'game2'));
});

test('peek faces and labels brighten continuously through the half-slot boundary without replacing nodes', () => dialClock(advance => {
  const view = mount(); enter(view, 'games');
  const incoming = row(view, 'game6'), outgoing = row(view, 'game0');
  const label = view.$('.dial-label[data-classification-id="game6"]'), pointer = dialPointer(view);
  assert.equal(Number(incoming.style.opacity), .45);
  assert.ok(Math.abs(Number(label.style.opacity) - .35) < .01);
  pointer('pointerdown', 0);
  let lastFace = .45, lastLabel = Number(label.style.opacity), lastOutgoing = 1;
  for (const position of [.25, .49, .499, .501, .51, .75, 1]) {
    advance(16); pointer('pointermove', position);
    assert.equal(row(view, 'game6'), incoming);
    assert.equal(view.$('.dial-label[data-classification-id="game6"]'), label);
    const face = Number(incoming.style.opacity), text = Number(label.style.opacity), leaving = Number(outgoing.style.opacity);
    assert.ok(face >= lastFace && text >= lastLabel && leaving <= lastOutgoing);
    if (position === .501) {
      assert.ok(face - lastFace < .003);
      assert.ok(text - lastLabel < .003);
    }
    lastFace = face; lastLabel = text; lastOutgoing = leaving;
  }
  assert.equal(Number(incoming.style.opacity), 1);
  assert.equal(Number(outgoing.style.opacity), .45);
  assert.deepEqual(peekIds(view), ['game0', 'game7']);
}));

test('the exhausted end remains empty during rubber-band overscroll', () => dialClock(advance => {
  for (const x of [10, 900]) {
    const view = mount({ origin: { x } }), pointer = dialPointer(view);
    pointer('pointerdown', 0); advance(40); pointer('pointermove', -1);
    assert.ok(dialPosition(view) < 0);
    assert.deepEqual(peekIds(view), [null, 'root5']);
    assert.ok(view.$$('.sector').filter(button => Number(button.dataset.dialIndex) < 0).every(button => button.classList.contains('empty')));
    pointer('pointerup', -1); advance(352);
    wheel(view); advance(220);
    pointer('pointerdown', 0); advance(40); pointer('pointermove', 1);
    assert.ok(dialPosition(view) > 1);
    assert.deepEqual(peekIds(view), ['games', null]);
    assert.ok(view.$$('.sector').filter(button => Number(button.dataset.dialIndex) > 6).every(button => button.classList.contains('empty')));
    view.dispose();
  }
}));

test('peeks mirror directly on both edges at desktop and tablet radius caps', () => {
  const width = dom.window.innerWidth, height = dom.window.innerHeight;
  try {
    for (const tablet of [false, true]) {
      dom.window.innerWidth = tablet ? 800 : 1024; dom.window.innerHeight = tablet ? 1200 : 768;
      dom.window.matchMedia = query => ({ matches: query.includes('reduced-motion') || (tablet && query.includes('pointer: coarse')) });
      const right = mount({ origin: { x: 750 } }), left = mount({ origin: { x: 10 } });
      const radius = parseFloat(right.$('.panel').style.getPropertyValue('--radius'));
      assert.equal(radius, tablet ? 208 : 200);
      for (const view of [right, left]) { enter(view, 'games'); wheel(view); }
      for (const end of ['before', 'after']) {
        const r = right.$(`.sector[data-peek="${end}"]`), l = left.$(`.sector[data-peek="${end}"]`);
        assert.equal(l.dataset.classificationId, r.dataset.classificationId);
        assertMirroredPath(r.style.clipPath, l.style.clipPath, radius * 2);
        assertMirroredPath(r.style.getPropertyValue('--sector-face'), l.style.getPropertyValue('--sector-face'), radius * 2);
        assert.equal(r.style.opacity, l.style.opacity);
        const rl = right.$(`.dial-label[data-classification-id="${r.dataset.classificationId}"]`);
        const ll = left.$(`.dial-label[data-classification-id="${l.dataset.classificationId}"]`);
        assert.equal(rl.style.top, ll.style.top);
        assert.ok(Math.abs(parseFloat(rl.style.left) + parseFloat(ll.style.left) - radius) <= 1);
      }
    }
  } finally { dom.window.innerWidth = width; dom.window.innerHeight = height; }
});

test('destination caption retains the full selected path when its wedge leaves view and clears with selection', async () => {
  const view = mount();
  const caption = view.$('.destination-caption');
  assert.equal(caption.hidden, true);
  enter(view, 'games'); row(view, 'game0').click();
  assert.equal(caption.textContent, '게임 › 게임 0');
  assert.equal(caption.hidden, false);
  assert.equal(caption.getAttribute('aria-hidden'), 'true');
  wheel(view); await settleDial();
  assert.equal(row(view, 'game0').getAttribute('aria-hidden'), 'true');
  assert.equal(caption.textContent, '게임 › 게임 0');
  back(view); assert.equal(caption.textContent, '게임');
  view.update({ hiddenClassificationIds: ['games'] });
  assert.equal(caption.hidden, true); assert.equal(caption.textContent, '');
  const preview = editor(); row(preview, 'games').click();
  assert.equal(preview.$('.destination-caption').hidden, true);
  assert.equal(preview.$('.edit-selection').textContent, '게임');
});

test('caption anchors to either edge above the arc, falls below in short viewports, and remains an outside tap', () => {
  for (const x of [10, 900]) for (const top of [100, 14]) {
    const view = mount({ origin: { x } }), left = x === 10;
    const bounds = { left: left ? 0 : 824, right: left ? 200 : 1024, top, bottom: top + 400, width: 200, height: 400 };
    view.$('.arc').getBoundingClientRect = () => bounds;
    row(view, 'games').click();
    const caption = view.$('.destination-caption');
    assert.equal(caption.dataset.placement, top === 100 ? 'above' : 'below');
    if (top === 100) {
      assert.equal(caption.style[left ? 'left' : 'right'], '0px');
      assert.equal(caption.parentElement.className, 'backdrop');
    } else assert.equal(caption.parentElement.tagName, 'FOOTER');
    caption.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: left ? 50 : 974, clientY: top === 100 ? 80 : bounds.bottom + 20 }));
    assert.equal(view.host.isConnected, false);
  }
});


test('folder names have no underline and only keyboard modality highlights the focused wedge', () => {
  const view = mount({ origin: { x: 10 }, inputKind: 'touch' });
  const css = view.$('style').textContent;
  assert.doesNotMatch(css, /text-decoration:\s*underline|text-underline-offset/);
  assert.match(css, /\.panel\.keyboard-focus \.sector:focus:before\{background:#526985\}/);
  assert.match(css, /\.panel\.keyboard-focus \.sector\[aria-pressed=true\]:focus:before\{background:#195bbd\}/);
  assert.equal(view.host.shadowRoot.activeElement, row(view, 'games'));
  assert.equal(view.$('.panel').classList.contains('keyboard-focus'), false);
  view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(view.$('.panel').classList.contains('keyboard-focus'), true);
  assert.equal(view.host.shadowRoot.activeElement, row(view, 'root0'));
  row(view, 'games').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(view.$('.panel').classList.contains('keyboard-focus'), false);
  const keyboard = mount({ inputKind: 'keyboard' });
  assert.equal(keyboard.$('.panel').classList.contains('keyboard-focus'), true);
  assert.equal(keyboard.host.shadowRoot.activeElement, row(keyboard, 'games'));
});

const crumbs = view => [...view.$('.destination-caption').querySelectorAll('.breadcrumb:not(.leaving):not([hidden])')];

test('breadcrumb appends animate only the new bubble and sibling selection reuses its pill', () => {
  const animations = mockMotion(), view = mount();
  assert.equal(crumbs(view).length, 0); assert.equal(view.$('.destination-caption').hidden, true);
  tap(view, 'games');
  const ancestor = crumbs(view)[0], first = animations.filter(a => a.target === ancestor);
  assert.equal(first.length, 1); assert.equal(first[0].options.duration, 180);
  assert.equal(first[0].options.easing, 'cubic-bezier(.2,.8,.2,1)');
  assert.deepEqual(first[0].frames[0], { opacity: 0, transform: 'translateY(4px) scale(.92)' });
  first[0].finish(); tap(view, 'games');
  assert.equal(crumbs(view)[0], ancestor, 'entering a selected folder retains its bubble');
  const count = animations.length; row(view, 'game0').click();
  const selected = crumbs(view)[1], pill = selected.querySelector('.bubble-pill');
  assert.equal(animations.length - count, 1);
  assert.equal(animations.at(-1).target, selected);
  assert.equal(animations.filter(a => a.target === ancestor).length, 1);
  animations.at(-1).finish(); row(view, 'game1').click();
  assert.equal(crumbs(view)[0], ancestor); assert.equal(crumbs(view)[1], selected);
  assert.equal(selected.querySelector('.bubble-pill'), pill);
  assert.equal(selected.dataset.classificationId, 'game1');
  assert.ok(animations.slice(-3).every(a => a.options.duration === 140));
  animations.slice(-3).forEach(a => a.finish());
  assert.equal(pill.textContent, '게임 1');
});

test('Back fades removed bubbles then removes nodes, and repeated Back finishes an earlier fade', () => {
  const animations = mockMotion();
  const branchEntries = Array.from({ length: 5 }, (_, i) => ({ id: `depth${i}`, name: `Depth ${i}`, parentId: i ? `depth${i - 1}` : null }));
  const view = mount({ entries: branchEntries });
  enter(view, 'depth0'); enter(view, 'depth1'); enter(view, 'depth2'); row(view, 'depth3').click();
  const bubble = crumbs(view).at(-1);
  back(view);
  const fade = animations.findLast(a => a.target === bubble && a.options.duration === 120);
  assert.ok(fade); assert.equal(bubble.isConnected, true);
  assert.deepEqual(fade.frames.at(-1), { opacity: 0, transform: 'scale(.96)' });
  // The restored selection still includes depth2; another Back retires it.
  back(view);
  assert.equal(bubble.isConnected, false); assert.equal(fade.cancelled, true);
  const pending = animations.findLast(a => a.target.classList.contains('leaving') && !a.cancelled);
  assert.ok(pending); assert.equal(pending.target.isConnected, true);
  pending.finish(); assert.equal(pending.target.isConnected, false);
});

test('breadcrumbs follow visited pinned paths and retain an entered folder with no selection', () => {
  const view = mount({ profile: { pinnedClassificationIds: ['game7'] } });
  enter(view, 'game7');
  assert.deepEqual(crumbs(view).map(node => node.dataset.classificationId), ['game7']);
  row(view, 'child0').click();
  view.update({ classifications: { entries: entries.filter(entry => entry.id !== 'child0') } });
  assert.deepEqual(crumbs(view).map(node => node.dataset.classificationId), ['game7']);
  assert.equal(crumbs(view)[0].classList.contains('selected'), false);
  assert.equal(view.$('.save-current').getAttribute('aria-disabled'), 'true');
  back(view);
  assert.deepEqual(crumbs(view).map(node => node.dataset.classificationId), ['game7']);
  assert.equal(crumbs(editor()).length, 0);
});

test('deep overflowing breadcrumbs collapse earliest ancestors and keep the last two plus selection', () => {
  const original = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'offsetWidth');
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() {
    return this.classList.contains('breadcrumb') ? 116 : original.get.call(this);
  } });
  try {
    const branchEntries = Array.from({ length: 7 }, (_, i) => ({ id: `depth${i}`, name: `Long folder ${i}`, parentId: i ? `depth${i - 1}` : null }));
    const view = mount({ entries: branchEntries, origin: { x: 10 } });
    for (let i = 0; i < 5; i++) enter(view, `depth${i}`);
    row(view, 'depth5').click();
    assert.deepEqual(crumbs(view).map(node => node.dataset.classificationId || node.textContent), ['…', 'depth3', 'depth4', 'depth5']);
    assert.equal(view.$('.destination-caption').dataset.side, 'left');
    assert.ok(view.$('.destination-caption [data-classification-id="depth0"]').hidden);
    assert.equal(crumbs(view).at(-1).classList.contains('selected'), true);
  } finally { Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', original); }
});

test('reduced motion changes breadcrumbs instantly without any animation', () => {
  const animations = mockMotion(); dom.window.matchMedia = () => ({ matches: true });
  const view = mount(); enter(view, 'games'); row(view, 'game0').click(); row(view, 'game1').click();
  const selected = crumbs(view).at(-1); back(view);
  assert.equal(selected.isConnected, false); assert.equal(animations.length, 0);
  assert.deepEqual(crumbs(view).map(node => node.dataset.classificationId), ['games']);
});

// Exact event/frame times make the release projection independently predictable.
function dialClock(run) {
  const now = performance.now, timeout = globalThis.setTimeout, clear = globalThis.clearTimeout;
  let time = 0; const timers = new Map();
  Object.defineProperty(performance, 'now', { configurable: true, value: () => time });
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (![120, 200, 240, 300, 600].includes(delay)) return timeout(callback, delay, ...args);
    const id = {}; timers.set(id, { at: time + delay, callback }); return id;
  };
  globalThis.clearTimeout = id => { if (!timers.delete(id)) clear(id); };
  const advance = ms => {
    const end = time + ms;
    while (time < end) {
      time = Math.min(end, time + 4);
      for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.callback(); }
      const callbacks = [...frameQueue.values()]; frameQueue.clear();
      for (const callback of callbacks) callback(time);
    }
  };
  const restore = () => {
    Object.defineProperty(performance, 'now', { configurable: true, value: now });
    globalThis.setTimeout = timeout; globalThis.clearTimeout = clear;
  };
  try {
    const result = run(advance);
    if (result?.then) return result.finally(restore);
    restore(); return result;
  } catch (error) { restore(); throw error; }
}
function dialPointer(view) {
  const arc = view.$('.arc'), radius = parseFloat(view.$('.panel').style.getPropertyValue('--radius'));
  const left = view.$('.panel').dataset.side === 'left';
  arc.getBoundingClientRect = () => ({ left: left ? 0 : 800, right: left ? radius : 800 + radius, top: 0, height: radius * 2, width: radius });
  return (type, slots, target = arc) => {
    const angle = (40 - slots * 360 / 14) * Math.PI / 180;
    const clientX = left ? radius * .75 * Math.cos(angle) : 800 + radius - radius * .75 * Math.cos(angle);
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX, clientY: radius + radius * .75 * Math.sin(angle) });
    Object.defineProperty(event, 'pointerId', { value: 71 }); target.dispatchEvent(event);
  };
}
const dialPosition = view => Number(view.$('.panel').dataset.dialPosition);

test('drag tracks the finger angle 1:1 on both edges without frame smoothing', () => dialClock(advance => {
  for (const x of [10, 900]) {
    const view = mount({ origin: { x } }); enter(view, 'games'); const pointer = dialPointer(view);
    pointer('pointerdown', 0); advance(40); pointer('pointermove', .7);
    assert.ok(Math.abs(dialPosition(view) - .7) < .001);
    advance(40); pointer('pointermove', 1.4);
    assert.ok(Math.abs(dialPosition(view) - 1.4) < .001);
    pointer('pointerup', 1.4); view.dispose();
  }
}));

test('fling projects recent velocity to the predicted slot and never overshoots that target', () => dialClock(advance => {
  const view = mount(); enter(view, 'games'); const pointer = dialPointer(view);
  pointer('pointerdown', 0); advance(40); pointer('pointermove', .2); advance(40); pointer('pointermove', .4); pointer('pointerup', .4);
  const expected = Math.round(.4 + (.4 / 80) * .998 / (1 - .998));
  assert.equal(expected, 3);
  let previous = dialPosition(view);
  for (let i = 0; i < 175; i++) {
    advance(4); const current = dialPosition(view);
    assert.ok(current <= expected && current >= previous); previous = current;
  }
  assert.equal(dialPosition(view), expected); assert.equal(view.$('.arc').classList.contains('dial-moving'), false);
}));

test('slow release and a held finger settle to the nearest slot without stale momentum', () => dialClock(advance => {
  for (const held of [false, true]) {
    const view = mount(); enter(view, 'games'); const pointer = dialPointer(view);
    pointer('pointerdown', 0); advance(120); pointer('pointermove', .6);
    advance(80); pointer('pointermove', held ? .9 : .604);
    if (held) advance(64);
    pointer('pointerup', held ? .9 : .604); advance(280);
    assert.equal(dialPosition(view), 1); assert.equal(view.$('.arc').classList.contains('dial-moving'), false);
    view.dispose();
  }
}));

test('rubber-band overscroll is smaller than raw motion and returns to the end without crossing it', () => dialClock(advance => {
  const view = mount(); enter(view, 'games'); const pointer = dialPointer(view);
  pointer('pointerdown', 0); advance(40); pointer('pointermove', -1);
  const expected = -(1 - 1 / (1 * .55 / 1.5 + 1)) * 1.5;
  assert.ok(Math.abs(dialPosition(view) - expected) < .001);
  assert.ok(dialPosition(view) > -1 && dialPosition(view) < 0);
  pointer('pointerup', -1);
  for (let i = 0; i < 90; i++) { advance(4); assert.ok(dialPosition(view) <= 0 && dialPosition(view) >= expected - .001); }
  assert.equal(dialPosition(view), 0); assert.equal(view.$('.arc').classList.contains('dial-moving'), false);
}));

test('spaced wheel notches accumulate while animating and a notch or PageDown moves exactly one slot', () => dialClock(advance => {
  const view = mount(); enter(view, 'games');
  wheel(view); advance(112); wheel(view); advance(112); wheel(view); advance(220);
  assert.equal(dialPosition(view), 3);
  wheel(view, -120); advance(220); assert.equal(dialPosition(view), 2);
  view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
  advance(220); assert.equal(dialPosition(view), 3);
  view.$('.arc').dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 1, deltaMode: 1, bubbles: true }));
  advance(220); assert.equal(dialPosition(view), 4);
}));

test('continuous wheel follows pixels directly and settles after OS inertia stops without a second fling', () => dialClock(advance => {
  const view = mount(); enter(view, 'games');
  const pxPerSlot = parseFloat(view.$('.panel').style.getPropertyValue('--radius')) * .75 * (360 / 14) * Math.PI / 180;
  wheel(view, 20); assert.ok(Math.abs(dialPosition(view) - 20 / pxPerSlot) < .001);
  advance(20); wheel(view, 20); advance(20); wheel(view, 10);
  const before = dialPosition(view); advance(116); assert.equal(dialPosition(view), before);
  advance(284); assert.equal(dialPosition(view), 1);
}));


test('queued keyboard steps never put the target more than three slots ahead', () => dialClock(advance => {
  const view = mount(); enter(view, 'games');
  for (let i = 0; i < 12; i++) view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
  advance(220); assert.equal(dialPosition(view), 3);
}));

test('an upper-end overscroll returns to the last slot, and tapping still selects after a drag is suppressed', () => dialClock(advance => {
  const view = mount(), pointer = dialPointer(view), button = row(view, 'games');
  pointer('pointerdown', 0, button); advance(40); pointer('pointermove', 2); pointer('pointerup', 2);
  assert.ok(dialPosition(view) > 1 && dialPosition(view) < 2);
  button.click(); assert.equal(view.$('.save-current').getAttribute('aria-disabled'), 'true');
  advance(352); assert.equal(dialPosition(view), 1);
  const leaf = row(view, 'root0');
  pointer('pointerdown', 0, leaf); pointer('pointerup', 0, leaf); leaf.click();
  assert.equal(view.$('.destination').textContent, '최상위 0');
}));

test('changing to reduced motion finishes a pending breadcrumb text crossfade and removal', () => {
  const animations = mockMotion(); let changed;
  const preference = { matches: false, addEventListener(type, callback) { changed = callback; } };
  dom.window.matchMedia = query => query.includes('reduced-motion') ? preference : { matches: false };
  const view = mount(); enter(view, 'games'); row(view, 'game0').click(); row(view, 'game1').click();
  const pill = crumbs(view).at(-1).querySelector('.bubble-pill');
  assert.ok(pill.querySelector('.bubble-old'));
  preference.matches = true; changed();
  assert.equal(pill.querySelector('.bubble-old'), null); assert.equal(pill.textContent, '게임 1');
  const count = animations.length; back(view); assert.equal(animations.length, count);
  assert.deepEqual(crumbs(view).map(node => node.dataset.classificationId), ['games']);
});


test('root shortcut selection crossfades in place across different canonical parents', () => {
  const animations = mockMotion(), view = mount({ profile: { pinnedClassificationIds: ['game7'] } });
  row(view, 'game7').click(); const bubble = crumbs(view)[0]; animations.at(-1).finish();
  row(view, 'games').click();
  assert.equal(crumbs(view)[0], bubble); assert.equal(bubble.dataset.classificationId, 'games');
  assert.ok(animations.slice(-3).every(animation => animation.options.duration === 140));
});

test('center taps save the selection for touch, pen and mouse on either edge', async () => {
  for (const x of [10, 900]) for (const kind of ['touch', 'pen', 'mouse']) {
    const saved = [], view = mount({ origin: { x }, onSave: async id => { saved.push(id); return { ok: false }; } });
    row(view, 'root0').click();
    const pointer = centerPointer(view, kind);
    pointer('pointerdown'); pointer('pointermove', 5, 3); pointer('pointerup', 5, 3);
    view.$('.save-current').click(); await tick();
    assert.deepEqual(saved, ['root0']); view.dispose();
  }
});

test('center up drag restores one visited level, selection and dial position on either edge', () => dialClock(advance => {
  for (const x of [10, 900]) {
    const view = mount({ origin: { x } }); enter(view, 'games');
    wheel(view); advance(220); wheel(view); advance(220); enter(view, 'game7');
    centerDrag(view, -60); advance(120);
    assert.equal(view.$('.panel').dataset.depth, '1');
    assert.equal(dialPosition(view), 2);
    assert.equal(view.$('.destination').textContent, '게임 7');
    assert.equal(row(view, 'game7').getAttribute('aria-pressed'), 'true');
    view.dispose();
  }
}));

test('center down drag works inside folders and at root without a selected destination', () => dialClock(async advance => {
  for (const inside of [false, true]) for (const x of [10, 900]) {
    let calls = 0, saves = 0;
    const view = mount({ origin: { x }, onTemporary: () => { calls++; return false; }, onSave: () => saves++ });
    if (inside) enter(view, 'games');
    else {
      assert.equal(view.$('.save-current').disabled, false);
      assert.equal(view.$('.save-current').getAttribute('aria-disabled'), 'true');
      view.$('.save-current').click(); assert.equal(saves, 0);
    }
    centerDrag(view, 48); advance(120); await tick(); view.$('.save-current').click();
    assert.equal(calls, 1); assert.equal(saves, 0);
    assert.equal(view.$('.panel').dataset.depth, inside ? '1' : '0');
    assert.equal(view.host.isConnected, true); view.dispose();
  }
}));

test('center root up and unsupported down drags never show commit or save', () => {
  let saves = 0;
  const view = mount({ onSave: () => saves++ }), pointer = centerPointer(view);
  row(view, 'root0').click();
  for (const dy of [-100, 100]) {
    pointer('pointerdown'); pointer('pointermove', dy);
    assert.equal(view.$('.save-current').className, 'save-current');
    pointer('pointerup', dy); view.$('.save-current').click();
  }
  assert.equal(saves, 0); assert.equal(view.$('.panel').dataset.depth, '0');
});

test('below-threshold, horizontal, cancelled and returned drags never invoke any action or trailing Save', () => {
  let saves = 0, temps = 0;
  const view = mount({ onSave: () => saves++, onTemporary: () => temps++ }); enter(view, 'games');
  const pointer = centerPointer(view);
  for (const [dy, dx, end] of [[47, 0, 'pointerup'], [-47, 0, 'pointerup'], [20, 70, 'pointerup'], [70, 0, 'pointercancel']]) {
    pointer('pointerdown'); pointer('pointermove', dy, dx); pointer(end, dy, dx); view.$('.save-current').click();
  }
  pointer('pointerdown'); pointer('pointermove', 0, 20); pointer('pointermove', 100, 20); pointer('pointerup', 100, 20);
  view.$('.save-current').click(); // Horizontal axis stays cancelled even after vertical movement.
  pointer('pointerdown'); pointer('pointermove', 80); pointer('pointermove', 0); pointer('pointerup'); view.$('.save-current').click();
  assert.equal(saves, 0); assert.equal(temps, 0); assert.equal(view.$('.panel').dataset.depth, '1');
});

test('drag reveals the face and both icons proportionally on either edge, with no layout reads', () => {
  for (const x of [10, 900]) {
    const view = mount({ origin: { x }, onTemporary: () => false }); enter(view, 'games');
    const button = view.$('.save-current'), face = view.$('.center-face');
    const save = view.$('.save-current .action-icon'), preview = view.$('.center-preview'), pointer = centerPointer(view);
    for (const node of [button, face, save, preview]) node.getBoundingClientRect = () => { throw new Error('preview layout read'); };
    pointer('pointerdown'); pointer('pointermove', 24);
    assert.equal(face.style.clipPath, 'inset(50% 0 0 0)'); assert.equal(face.style.background, 'rgb(47, 125, 91)');
    assert.equal(save.style.transform, 'translateY(-12px)'); assert.equal(save.style.opacity, '0.5');
    assert.equal(preview.style.transform, 'translateY(12px)'); assert.equal(preview.style.opacity, '0.5');
    const download = preview.querySelector('path').getAttribute('d');
    pointer('pointermove', -24);
    assert.equal(face.style.clipPath, 'inset(0 0 50% 0)'); assert.equal(face.style.background, 'rgb(57, 73, 95)');
    assert.equal(save.style.transform, 'translateY(12px)'); assert.equal(preview.style.transform, 'translateY(-12px)');
    assert.notEqual(preview.querySelector('path').getAttribute('d'), download);
    pointer('pointermove', -48); assert.equal(button.classList.contains('commit-back'), true);
    pointer('pointermove', 48); assert.equal(button.classList.contains('commit-temporary'), true);
    assert.equal(face.style.clipPath, 'inset(0% 0 0 0)'); assert.equal(preview.style.transform, 'translateY(0px)');
    pointer('pointermove', 47); assert.equal(button.classList.contains('commit-temporary'), false);
    pointer('pointercancel', 47);
    assert.equal(face.style.clipPath, 'inset(100% 0 0 0)'); assert.equal(save.style.transform, 'translateY(0px)');
    assert.equal(save.style.opacity, '1'); assert.equal(preview.style.opacity, '0');
    view.dispose();
  }
});

test('center capture follows a drag outside the button and suppresses the subsequent save click', () => dialClock(advance => {
  let saves = 0; const view = mount({ onSave: () => saves++ }); enter(view, 'games');
  const button = view.$('.save-current'), pointer = centerPointer(view);
  const captures = [], releases = [];
  button.setPointerCapture = id => captures.push(id); button.releasePointerCapture = id => releases.push(id);
  pointer('pointerdown'); pointer('pointermove', -60, 0, view.$('.panel')); pointer('pointerup', -60, 0, view.$('.panel'));
  advance(120); assert.deepEqual(captures, [81]); assert.deepEqual(releases, [81]);
  assert.equal(view.$('.panel').dataset.depth, '0');
  button.click(); assert.equal(saves, 0);
}));

test('cancelled center drag returns in 150 ms; reduced motion removes movement and animation', () => dialClock(advance => {
  const animations = mockMotion(), view = mount({ onTemporary: () => false }), pointer = centerPointer(view);
  pointer('pointerdown'); pointer('pointermove', 30); pointer('pointercancel', 30);
  const animation = animations.findLast(a => a.target === view.$('.save-current .action-icon'));
  assert.equal(animation.options.duration, 150);
  assert.deepEqual(animation.frames, [{ transform: 'translateY(-15px)', opacity: '0.375' }, { transform: 'translateY(0px)', opacity: '1' }]);
  dom.window.matchMedia = () => ({ matches: true });
  let temps = 0; const reduced = mount({ onTemporary: () => { temps++; return false; } }), p = centerPointer(reduced), count = animations.length;
  p('pointerdown'); p('pointermove', 60);
  assert.equal(reduced.$('.save-current .action-icon').style.transform, 'translateY(0px)');
  p('pointerup', 60); advance(120); assert.equal(temps, 1); assert.equal(animations.length, count);
}));

test('opening lock, a mid-drag lock and busy Save block center actions and preview', async () => {
  let temps = 0, saves = 0, finish;
  const view = mount({ inputLocked: true, onTemporary: () => { temps++; return false; }, onSave: () => { saves++; return new Promise(resolve => { finish = resolve; }); } });
  centerDrag(view, 60); view.$('.save-current').click(); centerWheel(view, 120); temporary(view);
  assert.equal(temps, 0); assert.equal(view.$('.save-current').className, 'save-current');
  view.unlockInput(); enter(view, 'games');
  const pointer = centerPointer(view); pointer('pointerdown'); pointer('pointermove', -60); view.lockInput();
  pointer('pointerup', -60); view.unlockInput(); view.$('.save-current').click();
  assert.equal(saves, 0); assert.equal(view.$('.panel').dataset.depth, '1');
  view.$('.save-current').click(); assert.equal(saves, 1);
  centerDrag(view, -60); centerDrag(view, 60); centerWheel(view, -120); centerWheel(view, 120); temporary(view);
  assert.equal(temps, 0); assert.equal(view.$('.panel').dataset.depth, '1');
  finish({ ok: false }); await tick();
});

test('t and T trigger Temporary without modifiers, but input-like focus and unsupported menus do not', async () => {
  let calls = 0; const view = mount({ onTemporary: () => { calls++; return false; } });
  for (const value of ['t', 'T']) { assert.equal(key(view, value).defaultPrevented, true); await tick(); }
  assert.equal(calls, 2);
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) key(view, 't', { [modifier]: true });
  for (const tag of ['input', 'textarea', 'select', 'div']) {
    const input = document.createElement(tag);
    if (tag === 'div') { input.setAttribute('contenteditable', 'true'); input.tabIndex = 0; }
    view.$('.panel').append(input); input.focus();
    key(view, 't', { target: input }); input.remove();
  }
  assert.equal(calls, 2);
  const unsupported = mount(); assert.equal(temporary(unsupported).defaultPrevented, false);
});

test('leaf double-tap saves exactly its id once, while keyboard and single taps only select', async () => {
  const ids = [], view = mount({ onSave: async id => { ids.push(id); return { ok: false }; } });
  tap(view, 'root0'); assert.deepEqual(ids, []);
  tap(view, 'root0'); tap(view, 'root0'); await tick(); assert.deepEqual(ids, ['root0']);
  assert.equal(view.$('.destination').textContent, '최상위 0');
  row(view, 'root1').click(); row(view, 'root1').click(); // Keyboard-generated clicks have detail 0.
  assert.deepEqual(ids, ['root0']);
  key(view, 'Enter', { ctrlKey: true }); await tick(); assert.deepEqual(ids, ['root0', 'root1']);
});

test('leaf double-tap expires after 350 ms and branch double-tap enters without saving', () => dialClock(advance => {
  const ids = [], view = mount({ onSave: id => ids.push(id) });
  tap(view, 'root0'); advance(352); tap(view, 'root0'); assert.deepEqual(ids, []);
  enter(view, 'games'); assert.equal(view.$('.panel').dataset.depth, '1'); assert.deepEqual(ids, []);
}));

test('editor keeps Open and lower Back; center gestures, wheel, t and leaf double-taps never save', () => {
  let saves = 0, temps = 0; const view = editor({ onSave: () => saves++, onTemporary: () => temps++ });
  assert.equal(view.$$('.center button').length, 2);
  row(view, 'games').click(); view.$('.save-current').click(); assert.equal(view.$('.panel').dataset.depth, '1');
  centerDrag(view, -80); assert.equal(view.$('.panel').dataset.depth, '1');
  centerDrag(view, 80); assert.equal(centerWheel(view, 120).defaultPrevented, false); temporary(view);
  // Clear the simulated drag's trailing click before tapping a leaf.
  view.$('.save-current').click(); tap(view, 'game0'); tap(view, 'game0');
  assert.equal(saves, 0); assert.equal(temps, 0);
  assert.equal(view.$('.save-current').disabled, true);
  view.$('.back').click(); assert.equal(view.$('.panel').dataset.depth, '0');
});

test('center notches go Back one level, dedupe bursts, and allow spaced notches across two levels', () => dialClock(advance => {
  const view = mount({ profile: { pinnedClassificationIds: ['game7'] } });
  // Use a simple nested tree so both levels are fully visible.
  view.update({ classifications: { entries: [
    { id: 'a', name: 'A', parentId: null }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: 'b' },
  ] }, profile: {} });
  enter(view, 'a'); enter(view, 'b');
  assert.equal(centerWheel(view, -53).defaultPrevented, true);
  assert.equal(view.$('.panel').dataset.depth, '1');
  advance(40); centerWheel(view, -53); advance(40); centerWheel(view, -53);
  assert.equal(view.$('.panel').dataset.depth, '1');
  advance(32); centerWheel(view, -1, { deltaMode: 1 }); assert.equal(view.$('.panel').dataset.depth, '0');
  advance(112); centerWheel(view, -1, { deltaMode: 2 }); assert.equal(view.$('.panel').dataset.depth, '0');
  assert.equal(dialPosition(view), 0);
}));

test('one and two down notches only preview; the third reveals, holds and commits once per gesture', () => dialClock(async advance => {
  const animations = mockMotion(); let calls = 0;
  const view = mount({ onTemporary: () => { calls++; return false; } }), face = view.$('.center-face');
  centerWheel(view, 53); assert.equal(calls, 0);
  assert.ok(Math.abs(parseFloat(face.style.clipPath.slice(6)) - 200 / 3) < 1e-9);
  assert.equal(view.$('.center-preview').style.transform, 'translateY(16px)');
  const step = animations.findLast(a => a.target === face);
  assert.equal(step.options.duration, 120); assert.equal(step.options.easing, 'ease-out');
  advance(40); centerWheel(view, 53); advance(40); centerWheel(view, 53);
  assert.equal(view.$('.center-preview').style.opacity, String(1 / 3));
  advance(32); centerWheel(view, 1, { deltaMode: 1 }); assert.equal(calls, 0);
  assert.equal(view.$('.center-preview').style.opacity, String(2 / 3));
  advance(112); centerWheel(view, 1, { deltaMode: 2 }); assert.equal(calls, 0);
  assert.equal(face.style.clipPath, 'inset(0% 0 0 0)');
  advance(120); assert.equal(calls, 0); // Finish the step before holding the full face.
  centerWheel(view, 53); temporary(view); view.$('.save-current').click();
  advance(116); assert.equal(calls, 0); advance(4); assert.equal(calls, 1);
  await Promise.resolve(); assert.equal(view.host.isConnected, true);
  assert.equal(face.style.clipPath, 'inset(100% 0 0 0)');
  centerWheel(view, 53); advance(296); centerWheel(view, 53); assert.equal(calls, 1);
  advance(300); centerWheel(view, 53); advance(112); centerWheel(view, 53); advance(112); centerWheel(view, 53);
  advance(240); await Promise.resolve(); assert.equal(calls, 2);
}));

test('600 ms idle drains notch progress in 150 ms and resets the count, including deduped input', () => dialClock(advance => {
  const animations = mockMotion(); let calls = 0;
  const view = mount({ onTemporary: () => { calls++; return false; } }), face = view.$('.center-face');
  centerWheel(view, 53); advance(112); centerWheel(view, 53); advance(40); centerWheel(view, 53);
  advance(596); assert.equal(view.$('.center-preview').style.opacity, String(2 / 3));
  advance(4); assert.equal(face.style.clipPath, 'inset(100% 0 0 0)');
  assert.equal(view.$('.center-preview').style.opacity, '0'); assert.equal(view.$('.save-current .action-icon').style.opacity, '1');
  const drain = animations.findLast(a => a.target === face);
  assert.equal(drain.options.duration, 150); assert.equal(drain.frames[1].clipPath, 'inset(100% 0 0 0)');
  centerWheel(view, 53); assert.equal(view.$('.center-preview').style.opacity, String(1 / 3));
  advance(112); centerWheel(view, 53); advance(240); assert.equal(calls, 0);
}));

test('up notch cancels down-progress without Back, while an up notch at zero goes Back immediately', () => dialClock(advance => {
  let calls = 0; const view = mount({ onTemporary: () => calls++ }); enter(view, 'games');
  centerWheel(view, 53); centerWheel(view, -53);
  assert.equal(view.$('.panel').dataset.depth, '1'); assert.equal(view.$('.center-preview').style.opacity, '0');
  advance(40); centerWheel(view, -53); assert.equal(view.$('.panel').dataset.depth, '1');
  advance(72); centerWheel(view, -53); assert.equal(view.$('.panel').dataset.depth, '0');
  assert.equal(calls, 0);
}));

test('busy Temporary extends wheel idle so inertia cannot retry as soon as its promise fails', () => dialClock(async advance => {
  let calls = 0, finish;
  const view = mount({ onTemporary: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const commit = () => { centerWheel(view, 120); advance(112); centerWheel(view, 120); advance(112); centerWheel(view, 120); advance(240); };
  commit(); assert.equal(calls, 1); advance(40); centerWheel(view, 120);
  finish(false); await Promise.resolve(); advance(100); centerWheel(view, 120);
  assert.equal(calls, 1); advance(300); commit(); assert.equal(calls, 2);
  finish(false); await Promise.resolve();
}));

test('trackpad Back keeps 48 px with reversal, progressive preview, hold and inertia suppression', () => dialClock(advance => {
  const view = mount({ entries: [
    { id: 'a', name: 'A', parentId: null }, { id: 'b', name: 'B', parentId: 'a' }, { id: 'c', name: 'C', parentId: 'b' },
  ] }); enter(view, 'a'); enter(view, 'b');
  const button = view.$('.save-current');
  centerWheel(view, -30); advance(16); centerWheel(view, 10);
  assert.equal(view.$('.save-current .action-icon').style.transform, 'translateY(10px)');
  centerWheel(view, -27); assert.equal(view.$('.panel').dataset.depth, '2');
  assert.equal(button.classList.contains('commit-back'), false);
  centerWheel(view, -1); assert.equal(view.$('.panel').dataset.depth, '2');
  assert.equal(button.classList.contains('commit-back'), true);
  advance(100); centerWheel(view, -30); advance(20); assert.equal(view.$('.panel').dataset.depth, '1');
  advance(176); centerWheel(view, -30); assert.equal(view.$('.panel').dataset.depth, '1');
  advance(200); centerWheel(view, -24); centerWheel(view, -24); advance(120);
  assert.equal(view.$('.panel').dataset.depth, '0');
}));

test('trackpad below threshold follows directly and drains after 600 ms idle', () => dialClock(advance => {
  const animations = mockMotion(); let calls = 0;
  const view = mount({ onTemporary: () => { calls++; return false; } }), face = view.$('.center-face');
  centerWheel(view, 30); advance(596); assert.equal(face.style.clipPath, 'inset(80% 0 0 0)');
  assert.equal(animations.some(a => a.target === face), false);
  advance(4); assert.equal(calls, 0); assert.equal(face.style.clipPath, 'inset(100% 0 0 0)');
  assert.equal(animations.findLast(a => a.target === face).options.duration, 150);
  centerWheel(view, 30); assert.equal(face.style.clipPath, 'inset(80% 0 0 0)');
}));

test('trackpad Temporary requires 150 px on either edge and reduced motion commits without sliding', () => dialClock(async advance => {
  for (const x of [10, 900]) for (const reduced of [false, true]) {
    dom.window.matchMedia = () => ({ matches: reduced });
    const animations = mockMotion(); let calls = 0, finish;
    const view = mount({ origin: { x }, onTemporary: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
    for (let i = 0; i < 4; i++) centerWheel(view, 30);
    centerWheel(view, 29); assert.equal(calls, 0); assert.equal(view.$('.save-current').classList.contains('commit-temporary'), false);
    centerWheel(view, 1); assert.equal(view.$('.save-current').classList.contains('commit-temporary'), true);
    advance(116); assert.equal(calls, 0); advance(4); assert.equal(calls, 1);
    if (reduced) {
      assert.equal(view.$('.save-current .action-icon').style.transform, 'translateY(0px)');
      assert.equal(view.$('.center-preview').style.transform, 'translateY(0px)'); assert.equal(animations.length, 0);
    }
    finish(false); await Promise.resolve(); advance(100); centerWheel(view, 30);
    assert.equal(calls, 1); view.dispose();
  }
}));

test('horizontal center wheel is not swallowed and ring wheel still rotates normally', () => dialClock(advance => {
  let calls = 0; const view = mount({ onTemporary: () => calls++ }); enter(view, 'games');
  assert.equal(centerWheel(view, 20, { deltaX: 60 }).defaultPrevented, false);
  assert.equal(centerWheel(view, 0, { deltaX: 60 }).defaultPrevented, false);
  assert.equal(calls, 0); assert.equal(dialPosition(view), 0);
  assert.equal(wheel(view).defaultPrevented, true); advance(220); assert.equal(dialPosition(view), 1);
}));

test('Temporary failures retain the menu and notice; successful feedback uses the single center icon', () => dialClock(async advance => {
  let closed;
  const animations = mockMotion(), view = mount({ onTemporary: async () => ({ ok: true, message: 'started' }), onClose: result => { closed = result; } });
  centerDrag(view, 48); advance(120); await tick();
  assert.deepEqual(closed, { ok: true, message: 'started' });
  assert.ok(animations.some(a => a.target === view.$('.center-preview') && a.options.duration === 100));
  const failed = mount({ onTemporary: async () => { throw new Error('offline'); } });
  temporary(failed); await tick();
  assert.equal(failed.host.isConnected, true); assert.equal(failed.$('.notice').textContent, '임시 저장을 열지 못했습니다.');
}));

test('lost center capture cancels and lets the next press work without an accidental save', async () => {
  const saved = [], view = mount({ onSave: async id => { saved.push(id); return { ok: false }; } });
  enter(view, 'games'); const pointer = centerPointer(view);
  pointer('pointerdown'); pointer('pointermove', -60); pointer('lostpointercapture', -60);
  view.$('.save-current').click();
  assert.equal(view.$('.panel').dataset.depth, '1'); assert.deepEqual(saved, []);
  assert.equal(view.$('.save-current').className, 'save-current');
  pointer('pointerdown'); pointer('pointerup'); view.$('.save-current').click(); await tick();
  assert.deepEqual(saved, ['games']);
});


test('a lock or disposal during the full-face hold cancels the reserved action', () => dialClock(advance => {
  for (const kind of ['drag', 'notch', 'trackpad']) for (const end of ['lock', 'dispose']) {
    let calls = 0; const view = mount({ onTemporary: () => { calls++; return false; } });
    if (kind === 'drag') centerDrag(view, 48);
    else if (kind === 'notch') { centerWheel(view, 53); advance(112); centerWheel(view, 53); advance(112); centerWheel(view, 53); }
    else for (let i = 0; i < 5; i++) centerWheel(view, 30);
    assert.equal(view.$('.center-preview').style.opacity, '1'); assert.equal(calls, 0);
    if (end === 'lock') { view.lockInput(); view.unlockInput(); } else view.dispose();
    advance(600); assert.equal(calls, 0); view.dispose();
  }
}));

test('unsupported Temporary wheel input does not create progress that swallows Back', () => dialClock(() => {
  for (const delta of [30, 53]) {
    const view = mount(); enter(view, 'games'); centerWheel(view, delta);
    assert.equal(view.$('.center-preview').style.opacity, '0');
    centerWheel(view, -53); assert.equal(view.$('.panel').dataset.depth, '0'); view.dispose();
  }
}));

test('a reported Temporary failure retains its message and drains the full face', () => dialClock(async advance => {
  const animations = mockMotion();
  const view = mount({ onTemporary: async () => ({ ok: false, message: 'download failed' }) });
  centerDrag(view, 48); advance(120); await Promise.resolve();
  assert.equal(view.host.isConnected, true); assert.equal(view.$('.notice').textContent, 'download failed');
  assert.equal(view.$('.center-face').style.clipPath, 'inset(100% 0 0 0)');
  assert.equal(animations.findLast(a => a.target === view.$('.center-face')).options.duration, 150);
}));

test('reduced-motion notches reveal each step instantly and commit after the full-face hold', () => dialClock(advance => {
  dom.window.matchMedia = () => ({ matches: true }); const animations = mockMotion(); let calls = 0;
  const view = mount({ onTemporary: () => { calls++; return false; } });
  centerWheel(view, 53); assert.equal(view.$('.center-preview').style.opacity, String(1 / 3));
  assert.equal(view.$('.center-preview').style.transform, 'translateY(0px)');
  advance(112); centerWheel(view, 53); advance(112); centerWheel(view, 53);
  advance(116); assert.equal(calls, 0); advance(4); assert.equal(calls, 1); assert.equal(animations.length, 0);
}));

test('scrolling the page well away from where the menu opened closes it; a small scroll does not', () => {
  let closes = 0;
  Object.defineProperty(dom.window, 'scrollY', { configurable: true, value: 0 });
  const view = mount({ onClose: () => closes++ });
  const scrollTo = y => { Object.defineProperty(dom.window, 'scrollY', { configurable: true, value: y }); dom.window.dispatchEvent(new dom.window.Event('scroll')); };
  scrollTo(100);
  assert.equal(closes, 0); assert.ok(view.host.isConnected);
  scrollTo(Math.max(120, dom.window.innerHeight * .25) + 1);
  assert.equal(closes, 1); assert.equal(view.host.isConnected, false);
  scrollTo(2000);
  assert.equal(closes, 1, 'a closed menu ignores later scrolls');
  Object.defineProperty(dom.window, 'scrollY', { configurable: true, value: 0 });
});

test('an outside tap still closes the menu after a dial gesture was cancelled without a click', () => {
  let closes = 0;
  const view = mount({ onClose: () => closes++ });
  const press = (type, target, x = 150, id = 91) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 200, button: 0 });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: 'touch' } });
    target.dispatchEvent(event);
  };
  // The browser takes the touch over (e.g. for scrolling): pointercancel, no click.
  press('pointerdown', view.$('.arc')); press('pointercancel', view.$('.arc'));
  assert.equal(closes, 0);
  const backdrop = view.$('.backdrop');
  press('pointerdown', backdrop, 5, 92);
  backdrop.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 200 }));
  assert.equal(closes, 1);
});
