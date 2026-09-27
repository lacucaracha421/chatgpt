import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const sources = Object.fromEntries(await Promise.all(['av-lookup', 'av-send', 'av-lookup-chip', 'background', 'api-client']
  .map(async name => [name, await readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8')])));
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function background({ paired = true, responses = [true] } = {}) {
  const requests = [], notifications = [], menus = [];
  let onClick, onMessage, onInstalled;
  const context = {
    URL, crypto: webcrypto, AbortController, setTimeout, clearTimeout,
    importScripts() {},
    LakomicsProfileStore: { refresh: async () => ({ ok: true }) },
    fetch: async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      const ok = responses.shift() ?? true;
      return { ok, status: ok ? 200 : 503, json: async () => ({ sequence: 1 }) };
    },
    chrome: {
      storage: { local: { get: async () => paired ? { 'lakomics:list:connection': {
        origin: 'https://paired.example.test', token: 'test-token-at-least-twenty-characters',
      } } : {} } },
      runtime: {
        onMessage: { addListener(fn) { onMessage = fn; } },
        onInstalled: { addListener(fn) { onInstalled = fn; } },
        onStartup: { addListener() {} },
      },
      contextMenus: {
        create(menu, callback) { menus.push(menu); callback?.(); },
        onClicked: { addListener(fn) { onClick = fn; } },
      },
      tabs: { sendMessage(id, message, options, callback) { notifications.push({ id, message, options }); callback(); } },
    },
  };
  for (const source of ['av-lookup', 'api-client', 'background']) vm.runInNewContext(sources[source], context);
  return { requests, notifications, menus, install: () => onInstalled(),
    click: (...args) => onClick(...args), dispatch: message => new Promise(resolve => onMessage(message, {}, resolve)) };
}

function page({ html = '<table><tr id="video_id"><td>ID:</td><td class="text">ssis001</td></tr></table>',
  url = 'https://www.javlibrary.com/ja/?v=work', sendMessage = async () => ({ ok: true }) } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const w = dom.window;
  w.__LAKOMICS_TEST__ = true;
  for (const name of ['av-lookup', 'av-send', 'av-lookup-chip']) w.eval(sources[name]);
  const timers = [];
  w.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
  w.clearTimeout = () => {};
  const controller = w.LakomicsAvSend.createController({ doc: w.document, win: w, sendMessage });
  return { w, doc: w.document, controller, timers, close() { controller.destroy(); w.close(); } };
}

test('JAVLibrary ID row gets one send button; fallback and redirected search work pages are supported', () => {
  for (const options of [{}, { html: '<table><tr><td>品番：</td><td> SSIS-001 </td></tr></table>' },
    { url: 'https://www.javlibrary.com/ja/vl_searchbyid.php?keyword=SSIS-001' }]) {
    const fixture = page(options);
    const button = fixture.controller.injectPageButton();
    assert.equal(button.textContent, '컬렉션에 보내기');
    assert.equal(button.dataset.state, 'idle');
    assert.equal(button.parentElement.tagName, 'TD');
    fixture.controller.injectPageButton();
    assert.equal(fixture.doc.querySelectorAll('#lakomics-av-send-page').length, 1);
    fixture.close();
  }
});

test('no send button without an ID code, on lists, or on other hosts', () => {
  for (const options of [
    { html: '<h1>SSIS-001 title</h1>' },
    { html: '<div id="video_id"><span class="text">unknown</span></div>' },
    { url: 'https://www.javlibrary.com/ja/vl_searchbyid.php?keyword=SSIS-001', html: '<a>SSIS-001</a>' },
    { url: 'https://www.javlibrary.com/ja/vl_update.php' },
    { url: 'https://javlibrary.com/ja/?v=work' },
    { url: 'https://elsewhere.test/?v=work' },
  ]) {
    const fixture = page(options);
    assert.equal(fixture.controller.injectPageButton(), null);
    fixture.close();
  }
});

test('page send uses paired API, exact contract body, normalized code and sending/sent states', async () => {
  const worker = background();
  let release;
  const fixture = page({ sendMessage: message => new Promise(resolve => { release = () => worker.dispatch(message).then(resolve); }) });
  const button = fixture.controller.injectPageButton();
  button.click();
  assert.equal(button.textContent, '보내는 중');
  assert.equal(button.disabled, true);
  await release(); await tick();
  assert.equal(button.textContent, '보냄');
  assert.equal(button.disabled, true);
  const request = worker.requests[0];
  assert.equal(request.url, 'https://paired.example.test/v1/av-lookups');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer test-token-at-least-twenty-characters');
  assert.deepEqual(Object.keys(request.body).sort(), ['productCode', 'requestId', 'sourceUrl']);
  assert.match(request.body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(request.body.productCode, 'SSIS-001');
  assert.equal(request.body.sourceUrl, fixture.w.location.href);
  assert.equal(fixture.doc.querySelector('[role="status"]').textContent, 'PC로 보냈어요 · SSIS-001');
  assert.equal(fixture.timers.at(-1).delay, 3000);
  fixture.timers.at(-1).fn();
  assert.equal(fixture.doc.querySelector('[role="status"]'), null);
  button.click();
  assert.equal(worker.requests.length, 1);
  fixture.close();
});

test('failed send retry reuses the complete body and requestId, even after toast dismissal', async () => {
  const worker = background({ responses: [false, false, true] });
  const fixture = page({ sendMessage: worker.dispatch });
  const button = fixture.controller.injectPageButton();
  button.click(); await tick();
  assert.equal(button.textContent, '컬렉션에 보내기');
  const toast = fixture.doc.querySelector('[role="status"]');
  assert.equal(toast.firstChild.textContent, '보내지 못했어요');
  assert.equal(toast.querySelector('button').textContent, '다시');
  toast.querySelector('button').click(); await tick();
  fixture.timers.at(-1).fn();
  button.click(); await tick();
  assert.equal(worker.requests.length, 3);
  assert.deepEqual(worker.requests.map(r => plain(r.body)), Array(3).fill(plain(worker.requests[0].body)));
  assert.equal(button.textContent, '보냄');
  fixture.close();
});

test('unpaired send shows pairing message without fetch; callback-only runtime handles worker errors', async () => {
  const worker = background({ paired: false });
  const fixture = page({ sendMessage: worker.dispatch });
  await fixture.controller.send('SSIS001');
  assert.equal(worker.requests.length, 0);
  assert.equal(fixture.doc.querySelector('[role="status"]').textContent, 'Lakomics와 먼저 연결해 주세요');
  fixture.close();

  const other = page();
  other.w.chrome = { runtime: { lastError: { message: 'closed' }, sendMessage(message, callback) { callback(); } } };
  const controller = other.w.LakomicsAvSend.createController({ doc: other.doc, win: other.w });
  await controller.send('SSIS001');
  assert.match(other.doc.querySelector('[role="status"]').textContent, /보내지 못했어요/);
  controller.destroy(); other.close();
});

test('selection chip contains lookup plus send and sends through the shared controller', async () => {
  const worker = background();
  const fixture = page({ html: '<p>Title SSIS001</p>', url: 'https://example.test/', sendMessage: worker.dispatch });
  const { w, doc, controller } = fixture;
  const chip = w.LakomicsAvLookupChip.createChipController({ doc, win: w, avSend: controller });
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector('p'));
  range.getClientRects = () => [{ left: 20, bottom: 30, width: 80 }];
  w.getSelection().addRange(range);
  chip.update();
  const actions = chip.chip.querySelectorAll('button');
  assert.deepEqual(Array.from(actions, b => b.textContent), ['AV 표지 찾기', '보내기']);
  assert.equal(chip.chip.hidden, false);
  actions[1].click(); await tick();
  assert.equal(worker.requests[0].body.productCode, 'SSIS-001');
  assert.equal(actions[1].textContent, '보냄');
  chip.destroy(); fixture.close();
});

test('context menu sends via paired API and its toast retries the original requestId', async () => {
  const worker = background({ responses: [false, true] });
  worker.install();
  const menu = worker.menus.find(m => m.id === 'lakomics-av-send');
  assert.equal(menu.title, 'AV 컬렉션에 보내기: “%s”');
  await worker.click({ menuItemId: menu.id, selectionText: 'Code ssis001', pageUrl: 'https://example.test/work', frameId: 3 }, { id: 8 });
  const notification = worker.notifications[0];
  assert.equal(notification.id, 8);
  assert.equal(notification.options.frameId, 0);
  assert.equal(notification.message.type, 'av-send-result');
  assert.equal(worker.requests[0].body.sourceUrl, 'https://example.test/work');
  const fixture = page({ sendMessage: worker.dispatch });
  fixture.controller.receive(notification.message.request, notification.message.result);
  fixture.doc.querySelector('[role="status"] button').click(); await tick();
  assert.deepEqual(plain(worker.requests[1].body), plain(worker.requests[0].body));
  assert.equal(fixture.doc.querySelector('[role="status"]').textContent, 'PC로 보냈어요 · SSIS-001');
  fixture.close();
});

test('manifest loads send controller before the chip in both content-script groups', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const groups = manifest.content_scripts.filter(group => group.js.includes('src/av-lookup-chip.js'));
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assert.ok(group.js.indexOf('src/av-send.js') > group.js.indexOf('src/av-lookup.js'));
    assert.ok(group.js.indexOf('src/av-send.js') < group.js.indexOf('src/av-lookup-chip.js'));
  }
});
