import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../../_tools/app/node_modules/jsdom/lib/api.js';

const plain = value => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------- worker side
const core = await Promise.all(['korean-rules', 'korean', 'terms', 'deadline', 'image'].map(name => readFile(new URL(`../src/translation/${name}.js`, import.meta.url), 'utf8')));
const service = await readFile(new URL('../src/translate-service.js', import.meta.url), 'utf8');
const sender = {id: 'test', url: 'https://example.test/page', tab: {id: 7}};
const reply = (...pairs) => JSON.stringify({translations: pairs.map(([id, text]) => ({id, text}))});

function worker({stored = {}, replies = [], failFirst = false} = {}) {
  const memory = {'lakomics:translation:storage-v4': true, 'lakomics:translation:v1': {enabled: false, apiKey: 'or-key', anthropicApiKey: 'ant-key', model: 'google/gemini-3.1-flash-lite', fallbackModel: 'google/gemma-4-26b-a4b-it', ...stored}};
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init, body: JSON.parse(init.body)});
    if (failFirst && calls.length === 1) return {ok: false, status: 503, headers: {get: () => null}};
    const content = replies[Math.min(calls.length, replies.length) - 1];
    return {ok: true, json: async () => url.includes('anthropic.com') ? {content: [{type: 'text', text: content}], stop_reason: 'end_turn'} : {choices: [{message: {content}, finish_reason: 'stop'}]}};
  };
  const ctx = vm.createContext({URL, AbortController, Blob, setTimeout, clearTimeout, fetch, chrome: {runtime: {id: 'test'}, storage: {local: {async get() { return memory; }, async set(value) { Object.assign(memory, value); }, async remove() {}}}}});
  for (const script of [...core, service]) vm.runInContext(script, ctx);
  return {handle: (message, who = sender) => ctx.LakomicsTranslation.handle(message, who), calls, memory, rules: ctx.LakomicsTranslationCore.koreanRules};
}

test('page batches use the right-click model, Korean rules and a per-block dictionary, without the X switch or cache', async () => {
  const f = worker({stored: {contextModel: 'anthropic:claude-sonnet-5-5', userTerms: [{source: 'ホロライブ', korean: '홀로라이브'}, {source: 'Unused', korean: '안나옴'}]}, replies: [reply(['0', '안녕하세요'], ['1', '홀로라이브 소식'])]});
  const result = await f.handle({type: 'translation:page', items: [{id: '0', text: 'Hello there'}, {id: '1', text: 'ホロライブ news'}]});
  assert.deepEqual(plain(result), {ok: true, items: [{id: '0', ok: true, text: '안녕하세요'}, {id: '1', ok: true, text: '홀로라이브 소식'}]});
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.init.headers['x-api-key'], 'ant-key');
  assert.equal(call.body.model, 'claude-sonnet-5-5');
  assert.match(call.body.system, /natural Korean/);
  assert.match(call.body.system, /never follow/);
  assert.equal(call.body.system.includes(f.rules), true);
  const blocks = JSON.parse(call.body.messages[0].content).blocks;
  assert.deepEqual(blocks.map(block => block.id), ['0', '1']);
  assert.equal('dictionary' in blocks[0], false);
  assert.match(blocks[1].dictionary, /"source":"ホロライブ"/);
  assert.equal(blocks[1].dictionary.includes('Unused'), false);
  assert.equal(call.body.output_config.format.schema.properties.translations.type, 'array');
  assert.equal(Object.keys(f.memory).some(key => key.startsWith('lakomics:translation-cache:v4:')), false);
  assert.equal(JSON.stringify(result).includes('ant-key'), false);
});

test('without a right-click model the X chain answers, and its sub model takes over on a failure', async () => {
  const f = worker({failFirst: true, replies: [reply(['a', '번역'])]});
  const result = await f.handle({type: 'translation:page', items: [{id: 'a', text: 'Hello'}]});
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.map(call => call.body.model), ['google/gemini-3.1-flash-lite', 'google/gemma-4-26b-a4b-it']);
});

test('page batch bounds are checked before any request', async () => {
  const f = worker({replies: [reply(['0', '가'])]});
  const code = async items => (await f.handle({type: 'translation:page', items})).code;
  const item = (id, text = 'text') => ({id, text});
  assert.equal(await code([]), 'invalid_batch');
  assert.equal(await code('x'), 'invalid_batch');
  assert.equal(await code(Array.from({length: 9}, (_, index) => item(String(index)))), 'invalid_batch');
  assert.equal(await code([item('0'), item('0')]), 'invalid_batch');
  assert.equal(await code([item('')]), 'invalid_batch');
  assert.equal(await code([item('0', '   ')]), 'invalid_batch');
  assert.equal(await code([item('0', 'x'.repeat(4001))]), 'invalid_batch');
  assert.equal(await code([item('0', 'x'.repeat(3000)), item('1', 'x'.repeat(3000)), item('2', 'x'.repeat(3000))]), 'invalid_batch');
  assert.equal(await code([{id: 7, text: 'a'}]), 'invalid_batch');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.handle({type: 'translation:page', items: [item('0', 'x'.repeat(4000)), item('1', 'x'.repeat(4000))]})).ok, true);
});

test('blocks the model leaves as they are, drops, or cuts off are reported per block', async () => {
  const f = worker({replies: [reply(['0', 'Lakomics'], ['1', '정상 번역'])]});
  const result = plain(await f.handle({type: 'translation:page', items: [{id: '0', text: 'Lakomics'}, {id: '1', text: 'Hello'}, {id: '2', text: 'Missing'}]}));
  assert.deepEqual(result.items, [{id: '0', ok: true, text: null, untranslated: true}, {id: '1', ok: true, text: '정상 번역'}, {id: '2', ok: false, code: 'invalid_translation'}]);
  assert.equal((await worker({replies: ['not json']}).handle({type: 'translation:page', items: [{id: '0', text: 'a'}]})).code, 'invalid_translation');
});

test('leftover kana gets exactly one corrective request for that block; the cleaner answer wins', async () => {
  const f = worker({replies: [reply(['0', '안녕 こんにちは'], ['1', '그대로']), reply(['0', '안녕 세계']), reply(['0', 'never'])]});
  const result = plain(await f.handle({type: 'translation:page', items: [{id: '0', text: 'hello world'}, {id: '1', text: 'plain'}]}));
  assert.deepEqual(result.items.map(item => item.text), ['안녕 세계', '그대로']);
  assert.equal(f.calls.length, 2);
  const retry = JSON.parse(f.calls[1].body.messages[1].content).blocks;
  assert.deepEqual(retry.map(block => block.id), ['0']);
  assert.match(retry[0].note, /Korean Hangul only in prose/);
  assert.equal(f.calls[1].body.model, f.calls[0].body.model);
  const worse = worker({replies: [reply(['0', '안녕 字']), reply(['0', '안녕 字字字'])]});
  assert.equal(plain(await worse.handle({type: 'translation:page', items: [{id: '0', text: 'hi'}]})).items[0].text, '안녕 字');
  assert.equal(worse.calls.length, 2);
});

// ---------------------------------------------------------------- content side
const names = ['model', 'surfaces', 'image', 'page', 'actions', 'menu'];
const sources = await Promise.all(names.map(name => readFile(new URL(`../src/context-menu/${name}.js`, import.meta.url), 'utf8')));
const css = await readFile(new URL('../src/context-menu/menu.css', import.meta.url), 'utf8');

function clock(w) {
  let now = 0, next = 0; const timers = new Map();
  w.setTimeout = (fn, delay) => { const id = ++next; timers.set(id, {fn, at: now + delay}); return id; };
  w.clearTimeout = id => timers.delete(id); w.Date.now = () => now;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {async advance(ms) {
    const end = now + ms;
    for (;;) { await flush(); const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!entry) break; now = entry[1].at; timers.delete(entry[0]); entry[1].fn(); }
    now = end; await flush();
  }};
}
// Script-made events are never trusted; events fired inside the runner look like user input.
function trust(w) {
  const wrappers = new WeakMap(); let on = false;
  const add = w.EventTarget.prototype.addEventListener, remove = w.EventTarget.prototype.removeEventListener;
  const wrap = listener => {
    if (typeof listener !== 'function') return listener;
    if (!wrappers.has(listener)) wrappers.set(listener, function(event) { return listener.call(this, on ? new Proxy(event, {get: (target, key) => key === 'isTrusted' ? true : typeof target[key] === 'function' ? target[key].bind(target) : target[key]}) : event); });
    return wrappers.get(listener);
  };
  w.EventTarget.prototype.addEventListener = function(type, listener, options) { return add.call(this, type, wrap(listener), options); };
  w.EventTarget.prototype.removeEventListener = function(type, listener, options) { return remove.call(this, type, wrap(listener), options); };
  w.addEventListener = w.EventTarget.prototype.addEventListener; w.removeEventListener = w.EventTarget.prototype.removeEventListener;
  return fn => { on = true; try { return fn(); } finally { on = false; } };
}
const SENTENCE = 'We walked through the old town on a rainy Saturday morning and stopped at a small tea house near the river.';
const para = index => `Paragraph ${index}: ${SENTENCE}`;
const paragraphs = count => Array.from({length: count}, (_, index) => `<p>${para(index)}</p>`).join('');

function fixture(html, {send, observer = false} = {}) {
  const dom = new JSDOM(`<body>${html}</body>`, {url: 'https://example.test/post', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window; w.matchMedia = () => ({matches: false});
  const user = trust(w), roots = new Map(), attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function(options) { const root = attach.call(this, options); roots.set(this, root); return root; };
  w.HTMLElement.prototype.showPopover = function() {};
  const observers = [];
  if (observer) w.IntersectionObserver = class { constructor(callback, options) { this.callback = callback; this.options = options; this.observed = new Set(); observers.push(this); } observe(el) { this.observed.add(el); } unobserve(el) { this.observed.delete(el); } disconnect() { this.observed.clear(); this.disconnected = true; } };
  for (const source of sources) w.eval(source);
  const timer = clock(w), sent = [], waiting = [];
  const transport = message => { sent.push(message); if (send) return send(message); return new Promise(resolve => waiting.push({message, resolve})); };
  const surfaces = w.LakomicsContextSurfaces.createSurfaces({doc: w.document, win: w, css});
  const watchers = [];
  const watchSession = () => { const watcher = {callback: null, stopped: false, watch(callback) { this.callback = callback; }, stop() { this.stopped = true; }}; watchers.push(watcher); return watcher; };
  const actions = w.LakomicsContextActions.createActions({doc: w.document, win: w, surfaces, send: transport, alive: context => context.departed !== true, watchSession});
  const gesture = {isTrusted: true, type: 'click'}, origin = {x: 10, y: 10};
  const context = () => w.LakomicsContextModel.snapshot(w.document.body, w.document, w);
  const toggle = () => actions.activate('page.translate', context(), origin, gesture);
  const cardOf = element => { const host = element.nextElementSibling?.localName === 'lakomics-translation-block' ? element.nextElementSibling : element.querySelector(':scope > lakomics-translation-block'); return host ? {host, box: roots.get(host).querySelector('.trA')} : null; };
  const status = () => { const host = w.document.querySelector('lakomics-page-status'); return host ? {host, box: roots.get(host).querySelector('.toastA')} : null; };
  const answer = (index, items) => { const entry = waiting[index]; entry.resolve({ok: true, items}); };
  const translateAll = message => message.items.map(item => ({id: item.id, ok: true, text: '번역: ' + item.text.slice(0, 12)}));
  return {w, doc: w.document, user, timer, sent, waiting, actions, context, toggle, cardOf, status, answer, translateAll, watchers, observers, roots, model: w.LakomicsContextModel, page: w.LakomicsContextPage, close: () => w.close()};
}
const texts = found => plain(found.map(item => item.text));
const LONG = [SENTENCE, SENTENCE, SENTENCE].join(' ');

test('main content: the article is chosen and navigation, side notes, footer, code and Korean blocks are left out', () => {
  const f = fixture(`<header><h1>The Site</h1></header><nav><ul><li>Home page</li><li>About us</li></ul></nav>
    <main><article><h1>Brewing coffee slowly</h1><p>${LONG}</p><p>Second paragraph. ${LONG}</p><p>이미 한국어로 쓰여 있는 문장이라 번역하지 않아요.</p><pre>const code = true;</pre><p>Hi</p><p>2024</p><figure><figcaption>A caption about the cup</figcaption></figure></article>
    <aside class="related"><p>Related articles you may like to read next</p></aside></main><footer><p>Copyright 2026 Some Company</p></footer>`);
  const root = f.page.findRoot(f.doc, f.w);
  assert.equal(root.localName, 'article');
  const found = f.page.collectBlocks(root, f.w, f.doc);
  assert.deepEqual(texts(found), ['Brewing coffee slowly', LONG, 'Second paragraph. ' + LONG, 'Hi', 'A caption about the cup']);
  f.close();
});

test('main content: a plain blog without semantic tags is found by paragraph text; sidebars and comments are ignored', () => {
  const f = fixture(`<div id="wrap"><div class="sidebar"><p>Popular posts and other things you might want to read later today, maybe.</p></div>
    <div class="entry"><h2>Title of the post</h2><p>${LONG}</p><p>${LONG} Again.</p><p>${LONG} Once more.</p></div>
    <div class="comments"><p>${LONG}</p><p>${LONG}</p></div></div>`);
  const root = f.page.findRoot(f.doc, f.w);
  assert.equal(root.className, 'entry');
  assert.deepEqual(texts(f.page.collectBlocks(root, f.w, f.doc)), ['Title of the post', LONG, LONG + ' Again.', LONG + ' Once more.']);
  f.close();
});

test('main content: a page with nav and aside but no main tag uses the densest container; main and role=main win when present', () => {
  const f = fixture(`<div id="app"><nav><p>Menu entries and quick links for visitors of this website go here.</p></nav>
    <div class="content"><p>${LONG}</p><p>${LONG} More.</p></div><aside><p>${LONG}</p><p>${LONG}</p><p>${LONG}</p></aside></div>`);
  assert.equal(f.page.findRoot(f.doc, f.w).className, 'content');
  f.close();
  const g = fixture(`<div><article><p>${LONG}</p></article><article><p>${LONG} Second.</p></article></div><div role="main"><p>${LONG} Main text. ${LONG}</p></div>`);
  assert.equal(g.page.findRoot(g.doc, g.w).getAttribute('role'), 'main', 'several articles on a page fall back to main');
  g.close();
  const h = fixture(`<div><article id="a"><p>${LONG}</p></article><article id="b"><p>${LONG} Second.</p></article></div>`);
  assert.equal(h.page.findRoot(h.doc, h.w).localName, 'div', 'several articles share their ancestor');
  h.close();
});

test('blocks inside editable fields, code, forms, hidden or ad-like containers and Lakomics UI are never collected; table cells and list items are', () => {
  const f = fixture(`<article>
    <p>${LONG}</p>
    <p hidden>${LONG} hidden attribute</p><p style="display:none">${LONG} display none</p><div style="visibility:hidden"><p>${LONG} visibility hidden</p></div>
    <div class="ad-slot"><p>${LONG} buy this now</p></div><div id="share-bar"><p>${LONG} share this</p></div>
    <form><p>${LONG} inside a form</p></form><textarea>${LONG} field</textarea>
    <div contenteditable="true"><p>${LONG} editing here</p></div>
    <code>${LONG} inline code</code><p><code>x</code></p>
    <lakomics-menu><p>${LONG} our menu</p></lakomics-menu><div id="lakomics-arc-collector"><p>${LONG} collector</p></div>
    <table><tr><td>Cell number one text</td><td>한국어 셀</td></tr></table>
    <ul><li>List item with some words</li><li>Parent item<ul><li>Nested leaf item</li></ul></li></ul>
    </article>`);
  const found = f.page.collectBlocks(f.doc.querySelector('article'), f.w, f.doc);
  assert.deepEqual(texts(found), [LONG, 'Cell number one text', 'List item with some words', 'Nested leaf item']);
  assert.deepEqual(plain(found.map(item => item.inside)), [false, true, true, true], 'cells and list items hold their card inside');
  f.close();
});

test('Korean detection: mostly-Hangul blocks are skipped, mixed blocks with mostly foreign letters are kept', () => {
  const {translatable} = fixture('').page;
  assert.equal(translatable('이것은 한국어 문장입니다'), false);
  assert.equal(translatable('이것은 한국어 문장 ok'), false, 'mostly Hangul is skipped');
  assert.equal(translatable('한국 Korean sentence here'), true);
  assert.equal(translatable('Seoul 서울 is the capital of Korea'), true);
  assert.equal(translatable('これは日本語です'), true);
  assert.equal(translatable('1234 — 5678'), false);
  assert.equal(translatable('a'), false);
  assert.equal(translatable('x'.repeat(4001)), false);
});

test('translation starts with what is on screen, then below, then above', async () => {
  const f = fixture(`<article>${paragraphs(5)}</article>`);
  const rects = [[-900, -840], [100, 160], [3000, 3060], [300, 360], [1500, 1560]];
  f.doc.querySelectorAll('p').forEach((p, index) => { p.getBoundingClientRect = () => ({top: rects[index][0], bottom: rects[index][1], left: 0, right: 100, width: 100, height: 60}); });
  await f.toggle();
  assert.deepEqual(plain(f.sent.map(message => message.items.map(item => item.text))), [[para(1), para(3), para(2), para(4)], [para(0)]]);
  assert.equal(f.sent[0].type, 'translation:page');
  f.actions.destroy(); f.close();
});

test('batches stay small, run three at a time, and blocks that scroll into view jump the queue', async () => {
  const f = fixture(`<article>${paragraphs(20)}</article>`, {observer: true});
  await f.toggle();
  assert.equal(f.sent.length, 3, 'three requests in flight');
  assert.ok(f.sent.every(message => message.items.length <= 4));
  const [observer] = f.observers;
  assert.match(observer.options.rootMargin, /px/);
  assert.equal(observer.observed.size, 8, 'dispatched blocks are no longer observed');
  const target = f.doc.querySelectorAll('p')[19];
  observer.callback([{isIntersecting: true, target}, {isIntersecting: false, target: f.doc.querySelectorAll('p')[18]}]);
  assert.equal(f.sent.length, 3, 'no new request while all three slots are busy');
  f.answer(0, f.translateAll(f.sent[0]));
  await f.timer.advance(0);
  assert.equal(f.sent.length, 4);
  assert.deepEqual(plain(f.sent[3].items.map(item => item.text.slice(0, 13))), ['Paragraph 19:', 'Paragraph 12:', 'Paragraph 13:', 'Paragraph 14:']);
  f.actions.destroy();
  assert.equal(observer.disconnected, true);
  f.close();
});

test('each block shows its own state: pending only after 400 ms, then translation, no card when nothing to translate, failure with retry', async () => {
  const f = fixture(`<article>${paragraphs(3)}</article>`);
  const p = [...f.doc.querySelectorAll('p')];
  await f.toggle();
  await f.timer.advance(399);
  assert.equal(p.every(item => f.cardOf(item) === null), true, 'nothing appears before 400 ms');
  await f.timer.advance(1);
  assert.equal(p.every(item => f.cardOf(item).box.classList.contains('pending')), true);
  assert.equal(f.cardOf(p[0]).box.querySelector('.h span').textContent, '번역 중');
  f.answer(0, [{id: '0', ok: true, text: '첫 번째 번역'}, {id: '1', ok: true, text: null, untranslated: true}, {id: '2', ok: false, code: 'invalid_translation'}]);
  await f.timer.advance(599);
  assert.equal(f.cardOf(p[0]).box.classList.contains('pending'), true, 'a visible busy label lasts at least 600 ms');
  await f.timer.advance(1);
  const first = f.cardOf(p[0]).box;
  assert.equal(first.querySelector('[lang="ko"]').textContent, '첫 번째 번역');
  assert.equal(first.getAttribute('aria-label'), '한국어 번역');
  assert.equal(p[0].nextElementSibling.localName, 'lakomics-translation-block', 'right under the original');
  await f.timer.advance(400);
  assert.equal(f.cardOf(p[1]), null, 'a block that needs no translation loses its pending card');
  const failed = f.cardOf(p[2]).box;
  assert.equal(failed.classList.contains('fail'), true);
  assert.equal(failed.querySelector('.retry').textContent, '다시 시도');
  failed.querySelector('.retry').click();
  await f.timer.advance(0);
  assert.equal(f.sent.length, 1, 'an untrusted click does not retry');
  f.user(() => failed.querySelector('.retry').click());
  await f.timer.advance(0);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(plain(f.sent[1].items.map(item => item.text)), [para(2)], 'only that block is asked again');
  f.answer(1, [{id: '2', ok: true, text: '세 번째 번역'}]);
  await f.timer.advance(2000);
  assert.equal(f.cardOf(p[2]).box.querySelector('[lang="ko"]').textContent, '세 번째 번역');
  f.actions.destroy(); f.close();
});

test('a fast answer never shows a pending label', async () => {
  const f = fixture(`<article>${paragraphs(2)}</article>`, {send: async message => ({ok: true, items: message.items.map(item => ({id: item.id, ok: true, text: '번역'}))})});
  await f.toggle();
  await f.timer.advance(0);
  assert.equal([...f.doc.querySelectorAll('p')].every(p => f.cardOf(p).box.classList.contains('pending') === false && f.cardOf(p).box.querySelector('[lang="ko"]')), true);
  await f.timer.advance(1000);
  f.actions.destroy(); f.close();
});

test('table cells and list items get their card inside; the status shows progress after 400 ms and the toggle word', async () => {
  const f = fixture(`<article><p>${LONG}</p><table><tr><td>Cell number one text</td></tr></table><ul><li>List item with some words</li></ul></article>`);
  await f.toggle();
  assert.equal(f.status(), null);
  await f.timer.advance(399);
  assert.equal(f.status(), null);
  await f.timer.advance(1);
  assert.equal(f.status().box.querySelector('span').textContent, '페이지 번역 중…');
  assert.equal(f.status().box.querySelector('.pv').textContent, '0/3');
  assert.equal(f.status().box.classList.contains('pending'), true);
  assert.equal(f.status().box.querySelector('.act').textContent, '원문만 보기');
  f.answer(0, f.translateAll(f.sent[0]));
  await f.timer.advance(700);
  assert.equal(f.status().box.querySelector('span').textContent, '번역 완료');
  assert.equal(f.status().box.querySelector('.pv').textContent, '3/3');
  assert.equal(f.cardOf(f.doc.querySelector('td')).host.parentElement, f.doc.querySelector('td'));
  assert.equal(f.cardOf(f.doc.querySelector('li')).host.parentElement, f.doc.querySelector('li'));
  f.actions.destroy(); f.close();
});

test('hide and show translations without a new request, from the menu item or the status button', async () => {
  const f = fixture(`<article>${paragraphs(2)}</article>`, {send: async message => ({ok: true, items: message.items.map(item => ({id: item.id, ok: true, text: '번역'}))})});
  const label = () => plain(f.model.items(f.model.snapshot(f.doc.body, f.doc, f.w), {hasApiKey: true, pageState: f.actions.pageState(), href: f.w.location.href})).find(item => item.id === 'page.translate').label;
  assert.equal(f.actions.pageState(), 'off');
  assert.equal(label(), '페이지 본문 번역');
  await f.toggle(); await f.timer.advance(1000);
  assert.equal(f.actions.pageState(), 'on');
  assert.equal(label(), '번역 숨기기');
  const hosts = () => [...f.doc.querySelectorAll('lakomics-translation-block')];
  assert.equal(hosts().length, 2);
  assert.equal(hosts().every(host => host.style.display === 'block'), true);
  const requests = f.sent.length;
  await f.toggle();
  assert.equal(f.actions.pageState(), 'hidden');
  assert.equal(label(), '번역 보기');
  assert.equal(hosts().every(host => host.style.display === 'none'), true);
  assert.equal(f.status().box.querySelector('span').textContent, '원문 표시 중');
  assert.equal(f.status().box.querySelector('.act').textContent, '번역 보기');
  f.status().box.querySelector('.act').click();
  assert.equal(f.actions.pageState(), 'hidden', 'an untrusted click does nothing');
  f.user(() => f.status().box.querySelector('.act').click());
  assert.equal(f.actions.pageState(), 'on');
  assert.equal(hosts().every(host => host.style.display === 'block'), true);
  assert.equal(f.status().box.querySelector('.act').textContent, '원문만 보기');
  f.user(() => f.status().box.querySelector('.act').click());
  assert.equal(hosts().every(host => host.style.display === 'none'), true);
  await f.toggle();
  assert.equal(f.sent.length, requests, 'toggling never asks the model again');
  f.actions.destroy(); f.close();
});

test('a translation that arrives while the original is shown stays hidden until shown', async () => {
  const f = fixture(`<article>${paragraphs(1)}</article>`);
  await f.toggle();
  await f.toggle();
  f.answer(0, [{id: '0', ok: true, text: '늦은 번역'}]);
  await f.timer.advance(1000);
  const card = f.cardOf(f.doc.querySelector('p'));
  assert.equal(card.host.style.display, 'none');
  await f.toggle();
  assert.equal(card.host.style.display, 'block');
  f.actions.destroy(); f.close();
});

test('navigation stops the job: cards, status and queue go away and late answers are ignored', async () => {
  const f = fixture(`<article>${paragraphs(20)}</article>`);
  await f.toggle(); await f.timer.advance(500);
  assert.ok(f.status());
  const sent = f.sent.length;
  f.watchers.at(-1).callback();
  assert.equal(f.actions.pageState(), 'off');
  assert.equal(f.watchers.at(-1).stopped, true);
  f.answer(0, f.translateAll(f.sent[0]));
  await f.timer.advance(2000);
  assert.equal(f.sent.length, sent, 'nothing new is requested');
  assert.equal(f.doc.querySelector('lakomics-translation-block'), null);
  assert.equal(f.doc.querySelector('lakomics-page-status'), null);
  f.actions.destroy(); f.close();
  // A single-page-app route change without events is caught when an answer arrives.
  const g = fixture(`<article>${paragraphs(20)}</article>`);
  await g.toggle();
  g.w.history.pushState({}, '', '/other');
  g.answer(0, g.translateAll(g.sent[0]));
  await g.timer.advance(2000);
  assert.equal(g.actions.pageState(), 'off');
  assert.equal(g.sent.length, 3);
  assert.equal(g.doc.querySelector('lakomics-translation-block'), null);
  g.actions.destroy(); g.close();
});

test('a missing key stops the job with one clear message instead of failing every batch', async () => {
  const f = fixture(`<article>${paragraphs(20)}</article>`, {send: async () => ({ok: false, code: 'api_key_missing'})});
  await f.toggle(); await f.timer.advance(2000);
  assert.equal(f.sent.length, 3, 'only the requests already in flight were sent');
  assert.equal(f.status().box.querySelector('span').textContent, 'API 키가 필요해요');
  assert.equal(f.cardOf(f.doc.querySelector('p')).box.classList.contains('fail'), true);
  f.actions.destroy(); f.close();
});

test('a page without text says so; only a trusted activation starts; the menu item needs a key only to start', async () => {
  const f = fixture('<nav><p>menu words only here</p></nav><div></div>');
  await f.actions.activate('page.translate', f.context(), {x: 1, y: 1}, {isTrusted: false});
  assert.equal(f.sent.length, 0);
  assert.equal(f.doc.querySelector('lakomics-toast'), null);
  await f.toggle();
  assert.equal(f.roots.get(f.doc.querySelector('lakomics-toast')).querySelector('.toastA').textContent.includes('번역할 본문을 찾지 못했어요'), true);
  assert.equal(f.actions.pageState(), 'off');
  const item = availability => plain(f.model.items(f.model.snapshot(f.doc.body, f.doc, f.w), {href: f.w.location.href, ...availability})).find(entry => entry.id === 'page.translate');
  assert.equal(item({hasApiKey: true, hasContextApiKey: false}).setup, true);
  assert.equal(item({hasApiKey: false, hasContextApiKey: true}).setup, false);
  assert.equal(item({hasContextApiKey: false, pageState: 'on'}).setup, false, 'hiding needs no key');
  assert.equal(item({pageState: 'hidden'}).label, '번역 보기');
  f.actions.destroy(); f.close();
});

test('status close hides only the status; the status uses the toast look, top right', async () => {
  const f = fixture(`<article>${paragraphs(1)}</article>`, {send: async message => ({ok: true, items: message.items.map(item => ({id: item.id, ok: true, text: '번역'}))})});
  await f.toggle(); await f.timer.advance(1000);
  const host = f.status().host;
  assert.equal(host.getAttribute('popover'), 'manual');
  assert.ok(host.style.left);
  assert.equal(host.style.top, '16px');
  f.user(() => f.status().box.querySelector('[aria-label="닫기"]').click());
  await f.timer.advance(200);
  assert.equal(f.status(), null);
  assert.equal(f.actions.pageState(), 'on', 'translations stay');
  await f.toggle();
  assert.equal(f.actions.pageState(), 'hidden');
  assert.ok(f.status(), 'the menu item brings the status back');
  assert.match(css, /\.toastA\.status\{/);
  f.actions.destroy(); f.close();
});
