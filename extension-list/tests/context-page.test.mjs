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

test('page batches use the right-click model, Korean rules and a per-block dictionary, without the X switch', async () => {
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
  const again = plain(await f.handle({type: 'translation:page', items: [{id: 'x', text: 'Hello there'}, {id: 'y', text: 'ホロライブ news'}]}));
  assert.deepEqual(again.items.map(item => item.text), ['안녕하세요', '홀로라이브 소식'], 'the same text is answered from the shared cache');
  assert.equal(f.calls.length, 1, 'no second request');
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


test('marked blocks must come back with every marker once, in order; one corrective request, then invalid_markers and no caching', async () => {
  const source = '⟦1⟧Read the⟦/1⟧ ⟦2⟧full story⟦/2⟧ ⟦3⟧today⟦/3⟧';
  const good = '⟦1⟧오늘⟦/1⟧ ⟦2⟧전체 기사를⟦/2⟧ ⟦3⟧읽으세요⟦/3⟧';
  const ok = worker({replies: [reply(['a', good])]});
  assert.deepEqual(plain(await ok.handle({type: 'translation:page', items: [{id: 'a', text: source}]})).items, [{id: 'a', ok: true, text: good}]);
  assert.match(ok.calls[0].body.messages[0].content, /marker pair exactly once/, 'the prompt explains the markers');
  const bad = [
    '⟦1⟧오늘⟦/1⟧ ⟦3⟧읽으세요⟦/3⟧', '⟦1⟧오늘⟦/1⟧ ⟦3⟧기사⟦/3⟧ ⟦2⟧읽으세요⟦/2⟧', '⟦1⟧오늘⟦/1⟧ ⟦2⟧기사⟦/2⟧ ⟦3⟧읽으세요', '⟦1⟧오늘⟦/1⟧ ⟦2⟧⟦/2⟧ ⟦3⟧읽으세요⟦/3⟧', '오늘 기사 읽으세요', '⟦1⟧오늘⟦/1⟧ ⟦2⟧기사⟦/2⟧ ⟦3⟧읽으세요⟦/3⟧ 끝',
  ];
  for (const answer of bad) {
    const f = worker({replies: [reply(['a', answer]), reply(['a', good])]});
    const result = plain(await f.handle({type: 'translation:page', items: [{id: 'a', text: source}]}));
    assert.deepEqual(result.items, [{id: 'a', ok: true, text: good}], answer);
    assert.equal(f.calls.length, 2);
    assert.match(JSON.parse(f.calls[1].body.messages[1].content).blocks[0].note, /marker pair/);
  }
  const hopeless = worker({replies: [reply(['a', bad[0]]), reply(['a', bad[1]]), reply(['a', good])]});
  const failed = plain(await hopeless.handle({type: 'translation:page', items: [{id: 'a', text: source}]}));
  assert.deepEqual(failed.items, [{id: 'a', ok: false, code: 'invalid_markers'}]);
  assert.equal(hopeless.calls.length, 2, 'exactly one corrective request');
  assert.equal(plain(await hopeless.handle({type: 'translation:page', items: [{id: 'a', text: source}]})).items[0].text, good, 'a failure is never cached');
  assert.equal(hopeless.calls.length, 3);
});

test('a marked block that needs no translation is reported as such, and plain blocks without markers are unaffected', async () => {
  const f = worker({replies: [reply(['a', '⟦1⟧Lakomics⟦/1⟧ ⟦2⟧Beta⟦/2⟧'], ['b', '그냥 번역'])]});
  const result = plain(await f.handle({type: 'translation:page', items: [{id: 'a', text: '⟦1⟧Lakomics⟦/1⟧ ⟦2⟧Beta⟦/2⟧'}, {id: 'b', text: 'Plain text'}]}));
  assert.deepEqual(result.items, [{id: 'a', ok: true, text: null, untranslated: true}, {id: 'b', ok: true, text: '그냥 번역'}]);
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
  return {pending: () => timers.size, async advance(ms) {
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
// A stand-in translation: marked blocks keep their markers, every piece becomes "한:" + the piece.
const PAIR = /⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/g;
const ko = text => text.includes('⟦') ? text.replace(PAIR, (_, n, body) => `⟦${n}⟧한:${body}⟦/${n}⟧`) : '한:' + text;
const answerAll = message => ({ok: true, items: message.items.map(item => ({id: item.id, ok: true, text: ko(item.text)}))});
const sentTexts = f => f.sent.flatMap(message => message.items.map(item => item.text));

function fixture(html, {send = answerAll, below = false, candidate = null, reduced = false} = {}) {
  const dom = new JSDOM(`<body>${html}</body>`, {url: 'https://example.test/post', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window; w.matchMedia = query => ({matches: reduced && /reduce/.test(query)});
  const user = trust(w), roots = new Map(), attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function(options) { const root = attach.call(this, options); roots.set(this, root); return root; };
  w.HTMLElement.prototype.showPopover = function() {};
  const animations = [];
  w.HTMLElement.prototype.animate = function(keyframes, options) { animations.push({element: this, keyframes, options}); return {}; };
  for (const source of sources) w.eval(source);
  const timer = clock(w), sent = [], waiting = [];
  const transport = message => { sent.push(message); if (send) return send(message); return new Promise(resolve => waiting.push({message, resolve})); };
  const surfaces = w.LakomicsContextSurfaces.createSurfaces({doc: w.document, win: w, css});
  const watchers = [];
  const watchSession = () => { const watcher = {callback: null, stopped: false, watch(callback) { this.callback = callback; }, stop() { this.stopped = true; }}; watchers.push(watcher); return watcher; };
  const actions = w.LakomicsContextActions.createActions({doc: w.document, win: w, surfaces, send: transport, alive: context => context.departed !== true, watchSession, collector: {findCandidate: target => candidate ? candidate(target) : null}, settings: () => ({pageMode: below ? 'below' : 'replace'})});
  const gesture = {isTrusted: true, type: 'click'}, origin = {x: 10, y: 10};
  const context = () => w.LakomicsContextModel.snapshot(w.document.body, w.document, w);
  const toggle = () => actions.activate('page.translate', context(), origin, gesture);
  const cardOf = element => { const host = element.nextElementSibling?.localName === 'lakomics-translation-block' ? element.nextElementSibling : element.querySelector(':scope > lakomics-translation-block'); return host ? {host, box: roots.get(host).querySelector('.trA')} : null; };
  const status = () => { const host = w.document.querySelector('lakomics-page-status'); return host ? {host, box: roots.get(host).querySelector('.toastA')} : null; };
  const note = () => { const host = w.document.querySelector('lakomics-translation-note'); return host ? {host, box: roots.get(host).querySelector('.noteA')} : null; };
  const answer = (index, items) => { waiting[index].resolve({ok: true, items}); };
  const rect = (element, top, bottom) => { element.getBoundingClientRect = () => ({top, bottom, left: 0, right: 200, width: 200, height: bottom - top}); };
  const fire = (target, type, {x = 5, y = 5, pointerType = 'mouse'} = {}) => {
    const event = new w.MouseEvent(type, {bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y});
    Object.defineProperty(event, 'pointerType', {value: pointerType});
    target.dispatchEvent(event); return event;
  };
  return {w, doc: w.document, user, timer, sent, waiting, actions, context, toggle, cardOf, status, note, answer, rect, fire, animations, watchers, roots, model: w.LakomicsContextModel, page: w.LakomicsContextPage, close: () => { actions.destroy(); w.close(); }};
}
const settle = async (f, rounds = 150) => { for (let i = 0; i < rounds; i++) await f.timer.advance(0); await f.timer.advance(1000); };

test('text is swapped in place: links and inline formatting stay, one block is one sentence for the model', async () => {
  const f = fixture('<p id="p">Read the <a href="/story">full story</a> and <b>subscribe</b> today for more news about the town.</p>');
  const p = f.doc.getElementById('p'), link = p.querySelector('a'), bold = p.querySelector('b');
  await f.toggle(); await f.timer.advance(0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, 'translation:page');
  assert.deepEqual(sentTexts(f), ['⟦1⟧Read the⟦/1⟧ ⟦2⟧full story⟦/2⟧ ⟦3⟧and⟦/3⟧ ⟦4⟧subscribe⟦/4⟧ ⟦5⟧today for more news about the town.⟦/5⟧']);
  assert.equal(p.innerHTML, '한:Read the <a href="/story">한:full story</a> 한:and <b>한:subscribe</b> 한:today for more news about the town.');
  assert.equal(p.querySelector('a'), link, 'the same link element, not a copy');
  assert.equal(p.querySelector('b'), bold);
  assert.equal(link.getAttribute('href'), '/story');
  assert.equal(f.doc.querySelector('lakomics-translation-block'), null, 'no extra element is added to the page');
  f.close();
});

test('switching the page translation off restores the exact original at once; switching it on again asks nothing', async () => {
  const html = '<h1>Brewing <em>coffee</em> slowly</h1><p>One line<br>another line follows here with <a href="#x">a link</a>.</p><ul><li>First item</li><li>Second <b>item</b></li></ul>';
  const f = fixture(html);
  const before = f.doc.body.innerHTML;
  await f.toggle(); await f.timer.advance(1000);
  const translated = f.doc.body.innerHTML;
  assert.notEqual(translated, before);
  assert.equal(f.actions.pageState(), 'on');
  const requests = f.sent.length;
  await f.toggle();
  assert.equal(f.actions.pageState(), 'hidden');
  assert.equal(f.doc.body.innerHTML, before.replace(/^/, ''), 'every text node is back, byte for byte');
  await f.timer.advance(2000);
  assert.equal(f.doc.body.innerHTML, before, 'our own restore is not mistaken for a page change');
  assert.equal(f.sent.length, requests, 'hiding asks nothing');
  await f.toggle();
  assert.equal(f.doc.body.innerHTML, translated, 'the stored translation comes back without the model');
  await f.timer.advance(2000);
  assert.equal(f.sent.length, requests);
  f.close();
  assert.equal(f.actions.pageState(), 'off');
});

test('a break in the markers is repaired by asking for the block as one piece; the longest text node carries it and the rest are emptied', async () => {
  const fallbacks = [
    async message => message.items[0].text.includes('⟦') ? {ok: true, items: [{id: '0', ok: false, code: 'invalid_markers'}]} : {ok: true, items: [{id: '0', ok: true, text: '문장 전체 번역'}]},
    // The page also checks what it gets: a lost or reordered marker never reaches the DOM.
    async message => message.items[0].text.includes('⟦') ? {ok: true, items: [{id: '0', ok: true, text: '⟦1⟧하나⟦/1⟧ ⟦3⟧셋⟦/3⟧'}]} : {ok: true, items: [{id: '0', ok: true, text: '문장 전체 번역'}]},
    async message => message.items[0].text.includes('⟦') ? {ok: true, items: [{id: '0', ok: true, text: '⟦1⟧하나⟦/1⟧ ⟦2⟧둘⟦/2⟧ ⟦3⟧셋⟦/3⟧ 바깥'}]} : {ok: true, items: [{id: '0', ok: true, text: '문장 전체 번역'}]},
  ];
  for (const send of fallbacks) {
    const f = fixture('<p id="p">Open <a href="/a">the door</a> and walk straight into the big room.</p>', {send});
    const p = f.doc.getElementById('p'), before = p.innerHTML;
    await f.toggle(); await f.timer.advance(0);
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[0].items[0].text.includes('⟦'), true);
    assert.equal(f.sent[1].items[0].text, 'Open the door and walk straight into the big room.', 'second try: plain text, no markers');
    assert.equal(p.textContent.includes('⟦'), false);
    assert.equal(p.textContent, ' 문장 전체 번역', 'the longest node (the tail) holds the sentence');
    assert.equal(p.querySelector('a').textContent, '', 'the link element stays, emptied');
    await f.toggle();
    assert.equal(p.innerHTML, before);
    f.close();
  }
  // A single piece that fails twice is a failure, not a loop.
  const f = fixture('<p>Open <a href="/a">the door</a> and walk straight into the big room.</p>', {send: async () => ({ok: true, items: [{id: '0', ok: false, code: 'invalid_markers'}]})});
  await f.toggle(); await f.timer.advance(2000);
  assert.equal(f.sent.length, 2);
  assert.match(f.status().box.querySelector('.pv').textContent, /실패 1/);
  f.close();
});

test('the whole page is translated: navigation, menus, buttons, captions and comments included', async () => {
  const f = fixture(`<header><nav><a href="/">Home page</a><a href="/about">About us</a></nav></header>
    <main><article><h1>Brewing coffee slowly</h1><p>${SENTENCE}</p><figure><figcaption>A caption about the cup</figcaption></figure></article>
    <section class="comments"><h2>Comments</h2><div class="comment"><span class="user">alice</span><div class="body">Great article, thanks for sharing it.</div><button>Reply</button></div></section>
    <aside class="sidebar"><p>Related articles you may like</p></aside></main>
    <footer><p>Copyright 2026 Some Company</p></footer><div class="ad-banner sponsored"><p>Sponsored message for you</p></div>`);
  await f.toggle(); await f.timer.advance(1000);
  const wanted = ['Home page', 'About us', 'Brewing coffee slowly', SENTENCE, 'A caption about the cup', 'Comments', 'alice', 'Great article, thanks for sharing it.', 'Reply', 'Related articles you may like', 'Copyright 2026 Some Company', 'Sponsored message for you'];
  assert.deepEqual(sentTexts(f).sort(), wanted.sort());
  for (const element of f.doc.querySelectorAll('a, h1, p, figcaption, h2, span, .body, button')) assert.match(element.textContent, /^한:/, element.outerHTML);
  f.close();
});

test('code, fields, scripts, hidden text, Korean, opt-outs and our own interface are never touched', async () => {
  const html = `<p>Visible English words here</p><pre>const code = true;</pre><p>Use <code>inline code here</code> now please</p><kbd>Ctrl</kbd><samp>output sample</samp>
    <input value="field value" placeholder="placeholder text"><textarea>area text words</textarea><select><option>Option one</option></select><div contenteditable="true">editable text words</div><div contenteditable="false"><p>not editable words</p></div>
    <script>var x = "script text words";</script><style>.a{content:"style words"}</style><svg><text>svg text words</text></svg><math><mi>math words</mi></math><template><p>template words</p></template><noscript>noscript words</noscript>
    <p>이미 한국어로 쓰여 있는 문장입니다.</p><p>이것은 한국어 문장 ok</p><p translate="no">Do not translate this</p><p class="notranslate">Also not this one</p>
    <lakomics-menu>our menu words</lakomics-menu><div id="lakomics-arc-collector">collector words</div><div id="lakomics-yt-button">youtube button</div>
    <p hidden>hidden attribute words</p><div style="display:none">display none words</div><div style="visibility:hidden"><p>invisible words</p></div>
    <p>1234 — 5678</p><p>a</p><p>https://example.com/some/path</p><p>name@example.com</p>`;
  const f = fixture(html);
  await f.toggle(); await f.timer.advance(1000);
  assert.deepEqual(sentTexts(f).sort(), ['Visible English words here', '⟦1⟧Use⟦/1⟧ ⟦2⟧now please⟦/2⟧', 'not editable words'].sort());
  const untouched = f.doc.body.innerHTML;
  assert.equal(untouched.includes('한:Ctrl'), false);
  assert.equal(f.doc.querySelector('code').textContent, 'inline code here');
  assert.equal(f.doc.querySelector('input').value, 'field value');
  assert.equal(f.doc.querySelector('pre').textContent, 'const code = true;');
  assert.equal(f.doc.querySelector('p[translate="no"]').textContent, 'Do not translate this');
  assert.equal(f.doc.querySelector('lakomics-menu').textContent, 'our menu words');
  // Korean detection: mostly Hangul stays, Latin-heavy mixes are kept.
  const {translatable} = f.page;
  assert.equal(translatable('이것은 한국어 문장입니다'), false);
  assert.equal(translatable('이것은 한국어 문장 ok'), false);
  assert.equal(translatable('한국 Korean sentence here'), true);
  assert.equal(translatable('これは日本語です'), true);
  assert.equal(translatable('1234 — 5678'), false);
  assert.equal(translatable('a'), false);
  f.close();
});

test('comments and other content that arrive later are translated after a short wait; our own writes cause no new requests', async () => {
  const f = fixture('<main><p>The first paragraph is here to start.</p><section id="comments"></section></main>');
  await f.toggle(); await f.timer.advance(1000);
  assert.equal(f.sent.length, 1);
  const section = f.doc.getElementById('comments');
  section.insertAdjacentHTML('beforeend', '<div class="comment"><b>bob</b> <span>Late comment arrives later.</span></div>');
  await f.timer.advance(299);
  assert.equal(f.sent.length, 1, 'debounced: nothing yet');
  section.insertAdjacentHTML('beforeend', '<div class="comment"><span>Another comment right behind it.</span></div>');
  await f.timer.advance(1);
  assert.equal(f.sent.length, 2, 'both comments in one coalesced request; the second addition did not restart the clock');
  assert.deepEqual(plain(f.sent[1].items.map(item => item.text)), ['⟦1⟧bob⟦/1⟧ ⟦2⟧Late comment arrives later.⟦/2⟧', 'Another comment right behind it.']);
  await f.timer.advance(5000);
  assert.equal(f.sent.length, 2, 'writing the translations did not trigger more work');
  assert.equal(section.textContent, '한:bob 한:Late comment arrives later.한:Another comment right behind it.');
  // "Load more": a button that swaps its own text.
  section.firstElementChild.firstElementChild.firstChild.data = 'carol';
  await f.timer.advance(400);
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2].items[0].text, 'carol');
  f.close();
});

test('text the page rewrites again and again (tickers) stops being translated after a few tries', async () => {
  const f = fixture('<p>Clock: <span id="t">first tick</span> shown here</p>');
  await f.toggle(); await f.timer.advance(1000);
  const node = f.doc.getElementById('t').firstChild;
  let changes = 0;
  for (; changes < 8; changes++) { node.data = `tick number ${changes}`; await f.timer.advance(400); }
  assert.ok(f.sent.length <= 5, `bounded: ${f.sent.length}`);
  const before = f.sent.length;
  node.data = 'one more tick'; await f.timer.advance(400);
  assert.equal(f.sent.length, before);
  f.close();
});

test('what is in or near the viewport goes first; far-away content waits until the user scrolls', async () => {
  const f = fixture(`<main>${paragraphs(7)}</main>`);
  const p = [...f.doc.querySelectorAll('p')];
  [[-900, -840], [100, 160], [3000, 3060], [300, 360], [1500, 1560], [-100, -40], [5000, 5060]].forEach(([top, bottom], index) => f.rect(p[index], top, bottom));
  await f.toggle(); await f.timer.advance(0);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(sentTexts(f), [para(1), para(3), para(4), para(5)], 'on screen top to bottom, then below, then just above');
  assert.equal(p[0].textContent, para(0), 'far above: not translated up front');
  assert.equal(p[2].textContent, para(2), 'far below: not translated up front');
  // Scrolling brings the next one into reach; the job asks for it after the scroll settles.
  f.rect(p[2], 400, 460);
  f.doc.dispatchEvent(new f.w.Event('scroll'));
  await f.timer.advance(100);
  assert.equal(f.sent.length, 1);
  await f.timer.advance(30);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(plain(f.sent[1].items.map(item => item.text)), [para(2)]);
  assert.match(p[2].textContent, /^한:/);
  assert.equal(p[6].textContent, para(6));
  f.close();
});

test('requests stay small, run three at a time, and identical texts are asked once', async () => {
  const f = fixture(`<main>${paragraphs(30)}</main><ul>${'<li>Reply</li>'.repeat(5)}</ul>`, {send: null});
  await f.toggle(); await f.timer.advance(0);
  assert.equal(f.sent.length, 3, 'three requests in flight');
  assert.ok(f.sent.every(message => message.items.length <= 8));
  assert.equal(f.sent.flatMap(message => message.items).filter(item => item.text === 'Reply').length <= 1, true, 'five identical labels, one item');
  const total = sentTexts({sent: f.sent}).length;
  f.answer(0, f.sent[0].items.map(item => ({id: item.id, ok: true, text: ko(item.text)})));
  await f.timer.advance(0);
  assert.equal(f.sent.length, 4, 'the freed slot is used at once');
  assert.ok(sentTexts({sent: f.sent}).length > total);
  f.close();
});

test('the same text on the page is asked once per page visit, even after hiding and showing again', async () => {
  const f = fixture('<ul><li>Reply</li><li>Reply</li><li>Reply</li></ul><p>Reply</p>');
  await f.toggle(); await f.timer.advance(1000);
  assert.deepEqual(sentTexts(f), ['Reply']);
  assert.deepEqual([...f.doc.querySelectorAll('li, p')].map(node => node.textContent), ['한:Reply', '한:Reply', '한:Reply', '한:Reply']);
  f.doc.querySelector('ul').insertAdjacentHTML('beforeend', '<li>Reply</li>');
  await f.timer.advance(400);
  assert.deepEqual(sentTexts(f), ['Reply'], 'a repeat is answered from memory');
  assert.equal(f.doc.querySelector('ul').lastChild.textContent, '한:Reply');
  f.close();
});

test('original on demand: hovering a translated block for 400 ms shows a floating note; moving away or scrolling hides it', async () => {
  const f = fixture('<section><p id="p">Read the <a href="/story">full story</a> and subscribe today.</p><p id="q">Another paragraph far away from it.</p></section>');
  await f.toggle(); await f.timer.advance(1000);
  const p = f.doc.getElementById('p'), link = p.querySelector('a'), html = f.doc.body.innerHTML;
  f.fire(link, 'pointermove', {x: 40, y: 30});
  await f.timer.advance(399);
  assert.equal(f.note(), null, 'not before 400 ms');
  await f.timer.advance(1);
  assert.equal(f.note().box.querySelector('.nb').textContent, 'Read the full story and subscribe today.');
  assert.equal(f.note().box.querySelector('.nh').textContent, '원문');
  assert.equal(f.note().host.parentElement, f.doc.documentElement, 'outside the page layout');
  assert.match(f.note().host.style.cssText, /position:\s*fixed/);
  assert.equal(f.doc.body.innerHTML, html, 'the page itself did not change');
  f.fire(link, 'pointermove', {x: 45, y: 32});
  await f.timer.advance(100);
  assert.ok(f.note(), 'small moves inside the block keep it');
  f.fire(f.doc.getElementById('q'), 'pointermove', {x: 50, y: 200});
  await f.timer.advance(200);
  assert.equal(f.note(), null);
  f.fire(link, 'pointermove', {x: 40, y: 30}); await f.timer.advance(400);
  assert.ok(f.note());
  f.doc.dispatchEvent(new f.w.Event('scroll')); await f.timer.advance(200);
  assert.equal(f.note(), null, 'scrolling dismisses');
  f.fire(link, 'pointermove', {x: 40, y: 30}); await f.timer.advance(400);
  assert.ok(f.note());
  f.fire(f.doc.body, 'pointerdown'); await f.timer.advance(200);
  assert.equal(f.note(), null, 'a click elsewhere dismisses');
  // Nothing to show for text that was not translated, and nothing while the originals are shown.
  f.fire(f.doc.body, 'pointermove', {x: 1, y: 1}); await f.timer.advance(500);
  assert.equal(f.note(), null);
  await f.toggle();
  f.fire(link, 'pointermove', {x: 40, y: 30}); await f.timer.advance(500);
  assert.equal(f.note(), null);
  f.close();
});

test('original on demand by touch: a 450 ms press shows the note without the browser menu; pictures keep the collector long press', async () => {
  const f = fixture('<section><p id="p">Read the full story and subscribe today for more.</p><p id="i">A picture follows here <img id="img" src="x.png" alt=""> and more words.</p></section>', {candidate: target => target?.id === 'img' ? {element: target, type: 'image'} : null});
  await f.toggle(); await f.timer.advance(1000);
  const p = f.doc.getElementById('p');
  f.fire(p, 'pointerdown', {pointerType: 'touch', x: 60, y: 120});
  await f.timer.advance(449);
  assert.equal(f.note(), null);
  await f.timer.advance(1);
  assert.equal(f.note().box.querySelector('.nb').textContent, 'Read the full story and subscribe today for more.');
  assert.equal(f.note().host.dataset.touch, 'true');
  const menu = f.fire(p, 'contextmenu', {pointerType: 'touch'});
  assert.equal(menu.defaultPrevented, true, 'the browser menu that a long press would open is held back');
  f.fire(p, 'pointerup', {pointerType: 'touch'});
  assert.ok(f.note(), 'lifting the finger keeps the note');
  f.fire(f.doc.body, 'pointerdown', {pointerType: 'touch', x: 5, y: 5}); await f.timer.advance(200);
  assert.equal(f.note(), null, 'a tap elsewhere dismisses');
  await f.timer.advance(2000);
  // A lift or a drag before 450 ms is not a long press.
  f.fire(p, 'pointerdown', {pointerType: 'touch', x: 60, y: 120}); await f.timer.advance(300);
  f.fire(p, 'pointerup', {pointerType: 'touch'}); await f.timer.advance(500);
  assert.equal(f.note(), null);
  f.fire(p, 'pointerdown', {pointerType: 'touch', x: 60, y: 120}); await f.timer.advance(200);
  f.fire(p, 'pointermove', {pointerType: 'touch', x: 60, y: 160}); await f.timer.advance(500);
  assert.equal(f.note(), null);
  assert.equal(f.fire(p, 'contextmenu', {pointerType: 'touch'}).defaultPrevented, false);
  // The collector owns a press on a picture.
  f.fire(f.doc.getElementById('img'), 'pointerdown', {pointerType: 'touch', x: 60, y: 120}); await f.timer.advance(700);
  assert.equal(f.note(), null);
  f.close();
});

test('original-note touch holds leave links and existing selections to the custom menu, and Shift escapes', async () => {
  const f=fixture('<p id="p">Read the full story and subscribe today for more.</p><p><a href="https://example.test/link">Read all the linked stories today.</a></p>');
  await f.toggle();await f.timer.advance(1000);
  const p=f.doc.getElementById('p');
  f.fire(p,'pointerdown',{pointerType:'touch',x:60,y:120});await f.timer.advance(450);
  const escaped=new f.w.MouseEvent('contextmenu',{bubbles:true,cancelable:true,shiftKey:true});p.dispatchEvent(escaped);assert.equal(escaped.defaultPrevented,false);
  f.fire(p,'pointerup',{pointerType:'touch'});
  f.fire(f.doc.querySelector('a'),'pointerdown',{pointerType:'touch',x:60,y:120});await f.timer.advance(500);assert.equal(f.note(),null);
  f.fire(f.doc.querySelector('a'),'pointerup',{pointerType:'touch'});
  const range=f.doc.createRange();range.selectNodeContents(p);f.w.getSelection().addRange(range);
  const selected=f.w.getSelection().toString();
  f.fire(p,'pointerdown',{pointerType:'touch',x:60,y:120});await f.timer.advance(500);
  assert.equal(f.note(),null);assert.equal(f.w.getSelection().toString(),selected);f.close();
});
test('each block fades in once, briefly, and never with reduced motion or when the originals come back', async () => {
  const f = fixture('<p>First paragraph with some words.</p><p>Second paragraph with some words.</p>');
  await f.toggle(); await f.timer.advance(1000);
  assert.equal(f.animations.length, 2, 'one subtle fade per block');
  for (const {keyframes, options} of f.animations) {
    assert.ok(options.duration <= 120);
    assert.ok(keyframes[0].opacity < keyframes[1].opacity);
  }
  const count = f.animations.length;
  await f.toggle();
  assert.equal(f.animations.length, count, 'restoring the original is instant');
  f.close();
  const calm = fixture('<p>First paragraph with some words.</p>', {reduced: true});
  await calm.toggle(); await calm.timer.advance(1000);
  assert.equal(calm.animations.length, 0);
  assert.match(calm.doc.querySelector('p').textContent, /^한:/);
  calm.close();
});

test('the status appears after 400 ms or at the end, counts blocks, and offers to hide and show', async () => {
  const f = fixture(`<main>${paragraphs(2)}</main>`, {send: null});
  await f.toggle();
  assert.equal(f.status(), null);
  await f.timer.advance(399);
  assert.equal(f.status(), null);
  await f.timer.advance(1);
  assert.equal(f.status().box.querySelector('span').textContent, '페이지 번역 중…');
  assert.equal(f.status().box.classList.contains('pending'), true);
  assert.equal(f.status().box.querySelector('.act').textContent, '원문만 보기');
  f.answer(0, f.sent[0].items.map(item => ({id: item.id, ok: true, text: '번역'})));
  await f.timer.advance(700);
  assert.equal(f.status().box.querySelector('span').textContent, '번역 완료');
  assert.equal(f.status().box.querySelector('.pv').textContent, '2개');
  const label = () => plain(f.model.items(f.model.snapshot(f.doc.body, f.doc, f.w), {hasApiKey: true, pageState: f.actions.pageState(), href: f.w.location.href})).find(item => item.id === 'page.translate').label;
  assert.equal(label(), '번역 숨기기');
  f.status().box.querySelector('.act').click();
  assert.equal(f.actions.pageState(), 'on', 'an untrusted click does nothing');
  f.user(() => f.status().box.querySelector('.act').click());
  assert.equal(f.actions.pageState(), 'hidden');
  assert.equal(label(), '번역 보기');
  assert.equal(f.status().box.querySelector('span').textContent, '원문 표시 중');
  assert.equal(f.status().box.querySelector('.act').textContent, '번역 보기');
  f.user(() => f.status().box.querySelector('.act').click());
  assert.equal(f.actions.pageState(), 'on');
  const host = f.status().host;
  assert.equal(host.getAttribute('popover'), 'manual');
  assert.equal(host.style.top, '16px');
  f.user(() => f.status().box.querySelector('[aria-label="닫기"]').click());
  await f.timer.advance(200);
  assert.equal(f.status(), null);
  assert.equal(f.actions.pageState(), 'on', 'closing the status keeps the translation');
  await f.toggle();
  assert.equal(f.actions.pageState(), 'hidden');
  assert.ok(f.status(), 'the menu item brings the status back');
  assert.match(css, /\.toastA\.status\{/);
  f.close();
});

test('an answer that arrives while the original is shown waits until it is shown again', async () => {
  const f = fixture('<p>Only paragraph on this page.</p>', {send: null});
  await f.toggle();
  await f.toggle();
  f.answer(0, [{id: '0', ok: true, text: '늦은 번역'}]);
  await f.timer.advance(1000);
  assert.equal(f.doc.querySelector('p').textContent, 'Only paragraph on this page.');
  await f.toggle();
  assert.equal(f.doc.querySelector('p').textContent, '늦은 번역');
  f.close();
});

test('a missing key stops the job with one clear message; failed blocks stay as they were and can be retried', async () => {
  let key = false;
  const f = fixture(`<main>${paragraphs(30)}</main>`, {send: async message => key ? answerAll(message) : {ok: false, code: 'api_key_missing'}});
  await f.toggle(); await f.timer.advance(2000);
  assert.equal(f.sent.length, 3, 'only the requests already in flight were sent');
  assert.equal(f.status().box.querySelector('span').textContent, 'API 키가 필요해요');
  assert.equal(f.doc.querySelector('p').textContent, para(0));
  const retry = [...f.status().box.querySelectorAll('.act')].find(button => button.textContent === '다시 시도');
  assert.ok(retry);
  key = true;
  f.user(() => retry.click());
  await f.timer.advance(2000);
  assert.match(f.doc.querySelector('p').textContent, /^한:/);
  assert.equal(f.status().box.querySelector('span').textContent.startsWith('번역'), true);
  f.close();
});

test('a very long page stops at a soft limit and goes on when the user asks', async () => {
  const f = fixture(`<main>${paragraphs(830)}</main>`);
  await f.toggle(); await settle(f);
  const asked = sentTexts(f).length;
  assert.equal(asked, 800, 'the per-page budget');
  assert.equal(f.status().box.querySelector('span').textContent, '번역 한도에 도달했어요');
  const more = [...f.status().box.querySelectorAll('.act')].find(button => button.textContent === '계속 번역');
  f.user(() => more.click());
  await settle(f);
  assert.equal(sentTexts(f).length, 830);
  assert.equal(f.status().box.querySelector('span').textContent, '번역 완료');
  f.close();
});

test('leaving the page ends the job and restores the text; a route change inside the page keeps it going', async () => {
  const f = fixture('<main id="m"><p>The first paragraph on the first route.</p></main>', {send: null});
  const before = f.doc.body.innerHTML;
  await f.toggle(); await f.timer.advance(500);
  assert.ok(f.status());
  f.answer(0, [{id: '0', ok: true, text: '첫 번째'}]);
  await f.timer.advance(700);
  assert.equal(f.doc.querySelector('p').textContent, '첫 번째');
  const first = f.watchers.at(-1);
  // Single-page-app navigation: same document, new URL, new content.
  f.w.history.pushState({}, '', '/other');
  f.doc.getElementById('m').innerHTML = '<p>The second route has its own text.</p>';
  first.callback();
  assert.equal(f.actions.pageState(), 'on', 'still translating');
  assert.equal(first.stopped, true);
  assert.notEqual(f.watchers.at(-1), first, 'a new watcher follows the new route');
  await f.timer.advance(400);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].items[0].text, 'The second route has its own text.');
  // Leaving for good.
  f.doc.getElementById('m').innerHTML = '<p>The second route has its own text.</p>';
  f.answer(1, [{id: '0', ok: true, text: '두 번째'}]);
  await f.timer.advance(700);
  const sent = f.sent.length;
  f.watchers.at(-1).callback();
  assert.equal(f.actions.pageState(), 'off');
  assert.equal(f.watchers.at(-1).stopped, true);
  assert.equal(f.doc.querySelector('lakomics-page-status'), null);
  f.doc.getElementById('m').insertAdjacentHTML('beforeend', '<p>Added after the job ended.</p>');
  await f.timer.advance(2000);
  assert.equal(f.sent.length, sent, 'nothing new is requested');
  assert.equal(f.doc.querySelector('p:last-child').textContent, 'Added after the job ended.');
  void before; f.close();
});

test('a page without text says so; only a trusted activation starts; the menu item needs a key only to start', async () => {
  const f = fixture('<div></div><code>only code here</code><p>1234</p>');
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
  f.close();
});

test('content in open shadow roots is translated too', async () => {
  const f = fixture('<div id="host"></div>');
  const root = f.doc.getElementById('host').attachShadow({mode: 'open'});
  root.innerHTML = '<p>Shadow paragraph with words.</p>';
  await f.toggle(); await f.timer.advance(1000);
  assert.equal(root.querySelector('p').textContent, '한:Shadow paragraph with words.');
  const added = f.doc.createElement('p'); added.textContent = 'Added later inside the shadow.'; root.append(added);
  await f.timer.advance(400);
  assert.equal(root.lastElementChild.textContent, '한:Added later inside the shadow.');
  f.close();
});

test('"원문 아래에 보기": the old mode shows each translation under its block, on body text only, with hide, show and retry', async () => {
  const f = fixture(`<nav><p>menu words only here</p></nav><article><p>${SENTENCE}</p><table><tr><td>Cell number one text</td></tr></table><ul><li>List item with some words</li></ul><button>Press the button</button><p>이미 한국어로 쓰여 있는 문장입니다.</p></article>`, {below: true, send: null});
  const text = f.doc.body.textContent, p = f.doc.querySelector('article p');
  await f.toggle();
  await f.timer.advance(399);
  assert.equal(f.cardOf(p), null, 'nothing appears before 400 ms');
  await f.timer.advance(1);
  assert.equal(f.cardOf(p).box.classList.contains('pending'), true);
  assert.deepEqual(plain(f.sent[0].items.map(item => item.text)), [SENTENCE, 'Cell number one text', 'List item with some words']);
  f.answer(0, [{id: '0', ok: true, text: '첫 번째 번역'}, {id: '1', ok: true, text: null, untranslated: true}, {id: '2', ok: false, code: 'invalid_translation'}]);
  await f.timer.advance(600);
  assert.equal(f.cardOf(p).box.querySelector('[lang="ko"]').textContent, '첫 번째 번역');
  await f.timer.advance(400);
  assert.equal(p.nextElementSibling.localName, 'lakomics-translation-block', 'right under the original');
  assert.equal(f.cardOf(f.doc.querySelector('td')), null, 'a block that needs no translation loses its pending card');
  assert.equal(f.cardOf(f.doc.querySelector('td')), null);
  const failed = f.cardOf(f.doc.querySelector('li')).box;
  assert.equal(failed.classList.contains('fail'), true);
  f.user(() => failed.querySelector('.retry').click());
  await f.timer.advance(0);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(plain(f.sent[1].items.map(item => item.text)), ['List item with some words']);
  f.answer(1, [{id: '0', ok: true, text: '목록 번역'}]);
  await f.timer.advance(1000);
  assert.equal(f.cardOf(f.doc.querySelector('li')).host.parentElement, f.doc.querySelector('li'), 'list items hold their card inside');
  assert.equal(f.doc.body.textContent.replace(/\s+/g, ' ').includes('menu words only here'), true);
  assert.equal(f.cardOf(f.doc.querySelector('nav p')), null, 'navigation and buttons get no card');
  assert.notEqual(f.doc.querySelector('button').nextElementSibling?.localName, 'lakomics-translation-block');
  // Hide and show.
  const hosts = () => [...f.doc.querySelectorAll('lakomics-translation-block')];
  assert.equal(hosts().every(host => host.style.display === 'block'), true);
  await f.toggle();
  assert.equal(f.actions.pageState(), 'hidden');
  assert.equal(hosts().every(host => host.style.display === 'none'), true);
  await f.toggle();
  assert.equal(hosts().every(host => host.style.display === 'block'), true);
  // Comments that arrive later get a card too, and the original text is never rewritten.
  f.doc.querySelector('article').insertAdjacentHTML('beforeend', '<p>A late paragraph shows up here.</p>');
  await f.timer.advance(400);
  assert.equal(f.sent.length, 3);
  assert.equal(f.doc.body.textContent.replace(/\s+/g, ' ').includes('A late paragraph shows up here.'), true);
  void text; f.actions.destroy(); await f.timer.advance(300);
  assert.equal(f.doc.querySelector('lakomics-translation-block'), null, 'stopping removes every card');
  f.close();
});

test('the page translation mode is a setting: replace by default, "below" selects the old cards', () => {
  const {settings, ownSelector} = fixture('').model;
  assert.equal(settings(undefined).pageMode, 'replace');
  assert.equal(settings({pageMode: 'below'}).pageMode, 'below');
  assert.equal(settings({pageMode: 'anything else'}).pageMode, 'replace');
  assert.match(ownSelector, /lakomics-translation-note/);
  assert.match(css, /\.noteA\{/);
});

test('the page names its run once for the usage list, and the status shows what the run cost', async () => {
  const f = fixture(`<main>${paragraphs(2)}</main>`, {send: message => ({...answerAll(message), usage: {input: 1500, output: 250, costUsd: 0.0042, unknown: 0, requests: 1}})});
  f.w.document.title = 'Coffee news';
  await f.toggle(); await settle(f);
  assert.equal(f.sent[0].job.label, 'example.test · Coffee news');
  assert.match(f.sent[0].job.id, /^page:[\w-]+$/);
  assert.match(f.status().box.querySelector('.pv').textContent, /^2개 · 약 \$0\.0042$/);
  f.close();
  const unpriced = fixture('<p>Only paragraph on this page.</p>', {send: message => ({...answerAll(message), usage: {input: 1500, output: 300, costUsd: 0, unknown: 1, requests: 1}})});
  await unpriced.toggle(); await settle(unpriced);
  assert.match(unpriced.status().box.querySelector('.pv').textContent, /^1개 · 토큰 1\.8k$/, 'without a cost the tokens are shown');
  unpriced.close();
});
