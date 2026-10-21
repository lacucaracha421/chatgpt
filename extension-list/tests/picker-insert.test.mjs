import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';
await import('../src/picker/model.js');
await import('../src/picker/insert.js');
const I = globalThis.LakomicsPickerInsert;

// A fake editor: the "page" decides when an Arca image appears.
function fakeEditor({ present = true } = {}) {
  const log = []; let resolveImage = null;
  const image = { id: 'img' };
  return {
    log, image,
    available: () => present,
    restore() { log.push('restore'); return true; },
    placeCaretAfter(node) { log.push('after:' + node.id); return true; },
    watchNewImage() {
      log.push('watch');
      let settle; const promise = new Promise(resolve => { settle = resolve; resolveImage = resolve; });
      return { promise, cancel() { log.push('cancel'); settle(null); } };
    },
    appear() { resolveImage(image); },
  };
}
const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
const fast = { ackMs: 25, totalMs: 120 };

test('a handled paste succeeds when an Arca image appears, then the caret moves after it', async () => {
  const editor = fakeEditor(), sent = [];
  const transport = { async dispatch(kind) { sent.push(kind); setTimeout(() => editor.appear(), 5); return { handled: true }; } };
  const result = await I.createInserter({ editor, getTransport: async () => transport, ...fast }).insertOne(file);
  assert.equal(result.ok, true); assert.deepEqual(sent, ['paste']);
  assert.deepEqual(editor.log, ['restore', 'watch', 'after:img', 'cancel']);
});

test('an ignored paste falls back to one drop, then succeeds', async () => {
  const editor = fakeEditor(), sent = [];
  const transport = { async dispatch(kind) { sent.push(kind); if (kind === 'drop') setTimeout(() => editor.appear(), 5); return { handled: kind === 'drop' }; } };
  const result = await I.createInserter({ editor, getTransport: async () => transport, ...fast }).insertOne(file);
  assert.equal(result.ok, true); assert.deepEqual(sent, ['paste', 'drop']);
  assert.equal(editor.log.filter(entry => entry === 'restore').length, 2, 'the caret is restored again before the drop');
});

test('an ignored paste and drop fail without a third try', async () => {
  const editor = fakeEditor(), sent = [];
  const transport = { async dispatch(kind) { sent.push(kind); return { handled: false }; } };
  const result = await I.createInserter({ editor, getTransport: async () => transport, ...fast }).insertOne(file);
  assert.deepEqual(result, { ok: false, reason: 'ignored' }); assert.deepEqual(sent, ['paste', 'drop']);
});

test('a paste marked handled that shows nothing falls back to a drop (the tablet editor), then times out', async () => {
  const editor = fakeEditor(), sent = [];
  const transport = { async dispatch(kind) { sent.push(kind); return { handled: true }; } };
  const started = Date.now();
  const result = await I.createInserter({ editor, getTransport: async () => transport, ackMs: 10, totalMs: 60 }).insertOne(file);
  assert.deepEqual(result, { ok: false, reason: 'editorTimeout' }); assert.deepEqual(sent, ['paste', 'drop']);
  assert.ok(Date.now() - started >= 55);
  assert.equal(globalThis.LakomicsPickerModel.jobReason(result.reason), '시간 초과');
});

test('an image that appears although the paste looked unhandled still counts', async () => {
  const editor = fakeEditor(), sent = [];
  const transport = { async dispatch(kind) { sent.push(kind); setTimeout(() => editor.appear(), 8); return { handled: false }; } };
  assert.equal((await I.createInserter({ editor, getTransport: async () => transport, ...fast }).insertOne(file)).ok, true);
  assert.deepEqual(sent, ['paste']);
});

test('a slow upload: an unflagged paste whose placeholder appears waits for the upload and never drops', async () => {
  const sent = []; let started, done;
  const image = { id: 'img' };
  const editor = {
    available: () => true, restore() { return true; }, placeCaretAfter() { return true; },
    watchNewImage() {
      const s = new Promise(r => { started = r; }), p = new Promise(r => { done = r; });
      return { promise: p, started: s, cancel() { started(null); done(null); } };
    },
  };
  const transport = { async dispatch(kind) {
    sent.push(kind);
    setTimeout(() => started({ id: 'placeholder' }), 5); // blob: placeholder right away
    setTimeout(() => done(image), 80);                    // upload finishes after the 25 ms ack window
    return { handled: false };
  } };
  const result = await I.createInserter({ editor, getTransport: async () => transport, ...fast }).insertOne(file);
  assert.equal(result.ok, true);
  assert.deepEqual(sent, ['paste'], 'no drop after the editor took the paste');
});

test('a refused upload (placeholder dropped) fails fast, removes leftovers and is retried once by the runner', async () => {
  let removed = 0, started, gone;
  const editor = {
    available: () => true, restore() { return true; }, placeCaretAfter() { return true; }, removePlaceholders() { removed++; return 1; },
    watchNewImage() {
      const s = new Promise(r => { started = r; }), g = new Promise(r => { gone = r; });
      return { promise: new Promise(() => {}), started: s, gone: g, cancel() { started(null); gone(false); } };
    },
  };
  const transport = { async dispatch() { setTimeout(() => started({ id: 'placeholder' }), 2); setTimeout(() => gone(true), 6); return { handled: true }; } };
  const inserter = I.createInserter({ editor, getTransport: async () => transport, ackMs: 25, totalMs: 5000 });
  const t0 = Date.now(); const result = await inserter.insertOne(file);
  assert.deepEqual(result, { ok: false, reason: 'uploadFailed' });
  assert.ok(Date.now() - t0 < 1000, 'does not wait for the full timeout'); assert.equal(removed, 1);
  let tries = 0, pauses = [];
  const runner = I.createJobRunner({ pause: async ms => { pauses.push(ms); }, inserter: { async insertOne() { tries++; return tries === 1 ? { ok: false, reason: 'uploadFailed' } : { ok: true }; } },
    fetchOriginal: async () => ({ ok: true, mime: 'image/png', bytes: new Uint8Array([1]) }) });
  const outcome = await runner.run(['x', 'y']);
  assert.equal(tries, 3); assert.deepEqual(outcome.map(o => o.ok), [true, true]); assert.deepEqual(pauses, [3000, 1200]);
});

test('a missing editor fails at once and sends nothing', async () => {
  const editor = fakeEditor({ present: false }); let touched = false;
  const result = await I.createInserter({ editor, getTransport: async () => { touched = true; return {}; }, ...fast }).insertOne(file);
  assert.deepEqual(result, { ok: false, reason: 'editor' }); assert.equal(touched, false);
});

test('the job runner goes one picture at a time, keeps going after a failure and reports each state', async () => {
  const events = [], order = [];
  const inserter = { async insertOne(f) { order.push(f.name); return f.name.includes('b') ? { ok: false, reason: 'editorTimeout' } : { ok: true }; } };
  const runner = I.createJobRunner({ pause: async () => {},
    inserter, onState: (id, state, reason) => events.push([id, state, reason]),
    fetchOriginal: async id => id === 'c' ? { ok: false, kind: 'missing' } : { ok: true, mime: 'image/png', bytes: new Uint8Array([1]) },
  });
  const outcome = await runner.run(['a', 'b', 'c', 'd']);
  assert.deepEqual(outcome.map(o => [o.id, o.ok]), [['a', true], ['b', false], ['c', false], ['d', true]]);
  assert.deepEqual(order, ['lakomics-a.png', 'lakomics-b.png', 'lakomics-d.png']);
  assert.deepEqual(events, [['a', 'up', ''], ['a', 'ok', ''], ['b', 'up', ''], ['b', 'bad', 'editorTimeout'], ['c', 'up', ''], ['c', 'bad', 'missing'], ['d', 'up', ''], ['d', 'ok', '']]);
});

test('the job runner stops queueing when asked and never fetches originals early', async () => {
  const fetched = []; let stop = false;
  const runner = I.createJobRunner({ pause: async () => {},
    shouldStop: () => stop,
    inserter: { async insertOne() { stop = true; return { ok: true }; } },
    fetchOriginal: async id => { fetched.push(id); return { ok: true, mime: 'image/gif', bytes: new Uint8Array([1]) }; },
  });
  const outcome = await runner.run(['a', 'b', 'c']);
  assert.deepEqual(fetched, ['a']); assert.equal(outcome.length, 1);
});

test('file names carry the asset id and a type extension; only Arca image hosts count', () => {
  assert.equal(I.fileName('abc', 'image/webp'), 'lakomics-abc.webp');
  assert.equal(I.fileName('abc', 'image/jpeg'), 'lakomics-abc.jpg');
  assert.equal(I.isArcaImage('https://ac.arca.live/content/x.png'), true);
  assert.equal(I.isArcaImage('//ac-o.namu.la/20261013/x.png', 'https://arca.live/'), true);
  assert.equal(I.isArcaImage('blob:https://arca.live/x'), false);
  assert.equal(I.isArcaImage('data:image/png;base64,AA=='), false);
  assert.equal(I.isArcaImage('https://evil.test/arca.live/x.png'), false);
  assert.equal(I.isArcaImage('https://notarca.live/x.png'), false);
});

function page(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'https://arca.live/b/channel/write', pretendToBeVisual: true });
  return { dom, w: dom.window, doc: dom.window.document };
}
const form = '<form id="article_write_form"><div class="write-body"><div class="fr-element fr-view" contenteditable="true"><p>앞</p><p id="tail">뒤</p></div></div></form>';

test('job adds one typing paragraph after the last successful image, also with partial failures', async () => {
  for (const failures of [[], ['b'], ['c'], ['a', 'b', 'c']]) {
    const { w, doc } = page(form);
    const adapter = I.createEditorAdapter({ doc, win: w }); let finished = 0;
    const inserter = {
      async insertOne(file) {
        if (failures.some(id => file.name.includes(`-${id}.`))) return { ok: false, reason: 'ignored' };
        const p = doc.createElement('p'), image = doc.createElement('img');
        image.src = `https://ac.arca.live/${file.name}`; p.append(image); adapter.find().insertBefore(p, doc.querySelector('#tail'));
        adapter.placeCaretAfter(image); return { ok: true, image };
      },
      finishJob(image) { finished++; adapter.finishJob(image); },
    };
    const runner = I.createJobRunner({ inserter, pause: async () => {}, fetchOriginal: async () => ({ ok: true, mime: 'image/png', bytes: new Uint8Array([1]) }) });
    await runner.run(['a', 'b', 'c']);
    const successes = 3 - failures.length;
    assert.equal(finished, successes ? 1 : 0);
    const empties = [...adapter.find().querySelectorAll('p')].filter(p => !p.textContent && !p.querySelector('img'));
    assert.equal(empties.length, successes ? 1 : 0);
    if (successes) {
      assert.equal(empties[0].previousElementSibling.querySelector('img'), [...adapter.find().querySelectorAll('img')].at(-1));
      assert.equal(w.getSelection().getRangeAt(0).startContainer, empties[0]);
      adapter.restore(); assert.equal(w.getSelection().getRangeAt(0).startContainer, empties[0], 'restore keeps the typing line');
    }
    w.close();
  }
});

test('finishJob reuses an existing empty paragraph or line and survives replaced image nodes', () => {
  for (const empty of ['<p><br></p>', '<div><br></div>', '<br>']) {
    const { w, doc } = page(form.replace('<p>앞</p>', `<p><img src="https://ac.arca.live/one.png"></p>${empty}`));
    const adapter = I.createEditorAdapter({ doc, win: w }), image = adapter.find().querySelector('img');
    adapter.placeCaretAfter(image);
    adapter.find().innerHTML = adapter.find().innerHTML;
    const before = adapter.find().innerHTML;
    assert.equal(adapter.finishJob(image), true);
    assert.equal(adapter.find().innerHTML, before);
    assert.equal(adapter.finishJob(image), true); assert.equal(adapter.find().innerHTML, before);
    w.close();
  }
});

test('typing line splits prose immediately after an image without losing the prose', () => {
  const { w, doc } = page(form.replace('<p>앞</p>', '<p><img src="https://ac.arca.live/one.png"><b>keep this</b></p>'));
  const adapter = I.createEditorAdapter({ doc, win: w }), image = adapter.find().querySelector('img');
  adapter.placeCaretAfter(image); assert.equal(adapter.finishJob(image), true);
  const line = image.closest('p').nextElementSibling;
  assert.equal(line.textContent, ''); assert.equal(line.nextElementSibling.querySelector('b').textContent, 'keep this');
  w.close();
});

test('the editor adapter sees a new Arca image appear, ignoring placeholders and old images', async () => {
  const { w, doc } = page(form.replace('<p>앞</p>', '<p><img id="old" src="https://ac.arca.live/old.png"></p>'));
  const adapter = I.createEditorAdapter({ doc, win: w });
  const watch = adapter.watchNewImage();
  const ed = adapter.find();
  const img = doc.createElement('img'); img.id = 'new'; img.src = 'blob:https://arca.live/placeholder'; ed.append(img);
  await new Promise(r => setTimeout(r, 5));
  let settled = false; watch.promise.then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 5)); assert.equal(settled, false, 'a blob placeholder is not success');
  img.src = 'https://ac.arca.live/content/new.png';
  const found = await watch.promise;
  assert.equal(found.id, 'new');
  watch.cancel(); w.close();
});

test('the editor adapter restores the saved caret and puts it after an inserted image', () => {
  const { w, doc } = page(form);
  const adapter = I.createEditorAdapter({ doc, win: w });
  const first = doc.querySelector('.fr-element p'); first.firstChild; // "앞"
  const range = doc.createRange(); range.setStart(first.firstChild, 1); range.collapse(true);
  w.getSelection().removeAllRanges(); w.getSelection().addRange(range);
  assert.equal(adapter.remember(), true);
  w.getSelection().removeAllRanges();
  assert.equal(adapter.restore(), true);
  const now = w.getSelection().getRangeAt(0);
  assert.equal(now.startContainer, first.firstChild); assert.equal(now.startOffset, 1);
  const img = doc.createElement('img'); first.append(img);
  assert.equal(adapter.placeCaretAfter(img), true);
  const after = w.getSelection().getRangeAt(0);
  assert.equal(after.startContainer, first); assert.equal(after.startOffset, first.childNodes.length);
  w.close();
});

test('without a saved caret the end of the body is used; a missing editor is reported', () => {
  const { w, doc } = page(form);
  const adapter = I.createEditorAdapter({ doc, win: w });
  assert.equal(adapter.remember(), false);
  adapter.restore();
  const range = w.getSelection().getRangeAt(0);
  assert.equal(adapter.find().contains(range.startContainer), true);
  assert.equal(range.collapsed, true);
  const none = page('<p>no editor</p>');
  const empty = I.createEditorAdapter({ doc: none.doc, win: none.w });
  assert.equal(empty.available(), false); assert.equal(empty.watchNewImage(), null); assert.equal(empty.restore(), false);
  w.close(); none.w.close();
});

test('the direct transport builds a DataTransfer paste/drop and reports defaultPrevented', async () => {
  const { w, doc } = page(form);
  const items = [];
  w.DataTransfer = class { constructor() { this.items = { add: f => items.push(f) }; } };
  w.ClipboardEvent = class extends w.Event { constructor(type, init) { super(type, init); this.clipboardData = init.clipboardData; } };
  w.DragEvent = class extends w.Event { constructor(type, init) { super(type, init); this.dataTransfer = init.dataTransfer; } };
  const seen = [];
  doc.querySelector('.fr-element').addEventListener('paste', event => { seen.push(event.type); event.preventDefault(); });
  const transport = I.createDirectTransport({ doc, win: w });
  assert.deepEqual(await transport.dispatch('paste', file), { handled: true });
  doc.querySelector('.fr-element').addEventListener('drop', event => seen.push(event.type));
  assert.deepEqual(await transport.dispatch('drop', file), { handled: false });
  assert.deepEqual(seen, ['paste', 'drop']); assert.equal(items.length, 2);
  w.close();
});

test('the bridge transport talks to the page-world helper by window messages and times out quietly', async () => {
  const { w } = page(form);
  const posted = [];
  w.postMessage = (message, origin) => { posted.push([message, origin]); };
  const transport = I.createBridgeTransport({ win: w, timeoutMs: 40, pingMs: 20, newId: (() => { let n = 0; return () => 'id' + ++n; })() });
  assert.equal(await transport.ping(), false, 'no helper answers -> direct fallback is used');
  const reply = (id, fields) => w.dispatchEvent(Object.assign(new w.Event('message'), { source: w, origin: w.location.origin, data: { lakomicsPickerReply: 1, id, ...fields } }));
  const pending = transport.ping(); reply('id2', { ok: true });
  assert.equal(await pending, true);
  const dispatched = transport.dispatch('paste', file);
  assert.equal(posted.at(-1)[0].kind, 'paste'); assert.equal(posted.at(-1)[0].file, file); assert.equal(posted.at(-1)[1], 'https://arca.live');
  reply('id3', { ok: true, handled: true });
  assert.deepEqual(await dispatched, { handled: true, error: undefined });
  // foreign replies are ignored
  const spoof = transport.dispatch('drop', file);
  w.dispatchEvent(Object.assign(new w.Event('message'), { source: null, origin: 'https://evil.test', data: { lakomicsPickerReply: 1, id: 'id4', ok: true, handled: true } }));
  assert.deepEqual(await spoof, { handled: false, error: 'bridge' });
  assert.equal((await I.chooseTransport({ ping: async () => false }, { name: 'direct' })).name, 'direct');
  assert.equal((await I.chooseTransport({ ping: async () => true, name: 'bridge' }, { name: 'direct' })).name, 'bridge');
  w.close();
});
