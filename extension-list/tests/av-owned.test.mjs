import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const sources = Object.fromEntries(await Promise.all(['av-lookup', 'av-send', 'av-owned', 'background']
  .map(async name => [name, await readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8')])));
const plain = value => JSON.parse(JSON.stringify(value));

function page(html, { url = 'https://www.avdbs.com/menu/dvd_ranking.php?tab=month', sendMessage } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const w = dom.window, messages = [];
  w.__LAKOMICS_TEST__ = true;
  for (const name of ['av-lookup', 'av-send', 'av-owned']) w.eval(sources[name]);
  const request = async message => {
    messages.push(plain(message));
    return sendMessage ? sendMessage(message) : { ok: true, owned: message.codes.filter(code => code === 'MIDA-703') };
  };
  const avSend = w.LakomicsAvSend.createController({ doc: w.document, win: w, sendMessage: request });
  const controller = w.LakomicsAvOwned.createController({ doc: w.document, win: w, avSend, sendMessage: request });
  return { w, doc: w.document, messages, controller, avSend,
    close() { controller.destroy(); avSend.destroy(); w.close(); } };
}

test('list and detail text get one inline badge per owned occurrence, preserving links and other text', async () => {
  const fixture = page(`<a href="?dvd=1">Title mida703 / DLDSS-467, MIDA-703 end</a>
    <script>MIDA-703</script><style>/* MIDA-703 */</style><textarea>MIDA-703</textarea>
    <input value="MIDA-703"><div contenteditable="true">MIDA-703</div>`);
  try {
    await fixture.controller.scan();
    const link = fixture.doc.querySelector('a');
    assert.equal(link.querySelectorAll('span').length, 2);
    assert.equal(link.textContent, 'Title mida703보유 / DLDSS-467, MIDA-703보유 end');
    assert.equal(link.getAttribute('href'), '?dvd=1');
    assert.equal(fixture.doc.querySelectorAll('span').length, 2);
    await fixture.controller.scan();
    assert.equal(fixture.messages.length, 1);
    assert.equal(link.querySelectorAll('span').length, 2);
    assert.deepEqual(fixture.messages[0].codes, ['MIDA-703', 'DLDSS-467']);
    link.firstChild.data = 'DLDSS-467';
    await fixture.controller.scan();
    assert.equal(link.querySelectorAll('span').length, 1);
  } finally { fixture.close(); }
});

test('batches at 200 and remembers positive and negative answers for appended lists', async () => {
  const fixture = page(Array.from({ length: 405 }, (_, i) => `<a>MIDA-${i + 100}</a>`).join(''));
  try {
    await fixture.controller.scan();
    assert.deepEqual(fixture.messages.map(message => message.codes.length), [200, 200, 5]);
    fixture.doc.body.insertAdjacentHTML('beforeend', '<p>MIDA-703 DLDSS-467 MIDA-100</p>');
    await fixture.controller.scan();
    assert.deepEqual(fixture.messages.at(-1).codes, ['MIDA-703', 'DLDSS-467']);
    fixture.doc.body.insertAdjacentHTML('beforeend', '<p>MIDA-703 DLDSS-467</p>');
    await fixture.controller.scan();
    assert.equal(fixture.messages.length, 4);
    assert.equal(fixture.doc.querySelector('p:last-child span').textContent, '보유');
  } finally { fixture.close(); }
});

test('observer picks up dynamically loaded codes without querying old codes or looping on its badges', async () => {
  const fixture = page('<p>MIDA-703</p>');
  try {
    await fixture.controller.start();
    fixture.doc.body.insertAdjacentHTML('beforeend', '<a>DLDSS-467</a><a>MIDA-703</a>');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(fixture.messages.length, 2);
    assert.deepEqual(fixture.messages[1].codes, ['DLDSS-467']);
    assert.equal(fixture.doc.querySelectorAll('span').length, 2);
  } finally { fixture.close(); }
});

test('owned JAVLibrary detail button becomes non-sending on both protocols', async () => {
  for (const protocol of ['http:', 'https:']) {
    const fixture = page('<table><tr id="video_id"><td class="text">MIDA-703</td></tr></table>',
      { url: `${protocol}//www.javlibrary.com/ja/?v=work` });
    try {
      await fixture.controller.scan();
      const button = fixture.doc.querySelector('button');
      assert.equal(button.textContent, '보유');
      assert.equal(button.disabled, true);
      button.click();
      await fixture.avSend.send('MIDA-703');
      assert.equal(fixture.messages.length, 1);
    } finally { fixture.close(); }
  }
});

test('later rows and text edits do not walk old rows or skipped branches', async t => {
  const fixture = page('<main>' + '<p>Old row MIDA-703</p>'.repeat(100)
    + '</main><div id="ticker"><div><span>DLDSS-467</span></div></div><section id="rows"></section>');
  const { w, doc } = fixture;
  const walks = [], parsed = [];
  const createWalker = doc.createTreeWalker.bind(doc);
  doc.createTreeWalker = (root, ...args) => { walks.push(root); return createWalker(root, ...args); };
  const parse = w.LakomicsAvLookup.productCodesInText;
  w.LakomicsAvLookup.productCodesInText = text => { parsed.push(text); return parse(text); };
  try {
    await fixture.controller.start();
    const initialWalks = walks.filter(root => root === doc.body).length;
    assert.equal(initialWalks, 1, 'the first scan walks the body once, including its reply');
    assert.ok(!parsed.includes('DLDSS-467'), 'text inside a nested skipped branch is never parsed');
    walks.length = 0; parsed.length = 0;
    doc.getElementById('rows').innerHTML = '<a>MIDA-703 DLDSS-467</a>';
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(doc.querySelector('#rows a span')?.dataset.code, 'MIDA-703');
    assert.deepEqual(fixture.messages.at(-1).codes, ['DLDSS-467']);
    assert.ok(!parsed.some(text => text.includes('Old row')), 'unchanged rows are not parsed again');
    assert.equal(walks.filter(root => root === doc.body).length, 0);
    const link = doc.querySelector('#rows a');
    link.firstChild.data = 'DLDSS-467';
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(link.querySelector('span'), null, 'editing a code removes its stale badge');
    doc.getElementById('ticker').insertAdjacentHTML('beforeend', '<div>MIDA-999</div>');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(!fixture.messages.some(message => message.codes.includes('MIDA-999')));
    t.diagnostic(`body walks: initial ${initialWalks}; subsequent row/edit/ticker changes ${walks.filter(root => root === doc.body).length}`);
  } finally { fixture.close(); }
});

test('rows added while ownership is pending and split text across reply batches keep every badge', async () => {
  let resolveFirst;
  const fixture = page('<p>' + Array.from({ length: 201 }, (_, i) => `MIDA-${i + 100}`).join(' ') + '</p>', {
    sendMessage: message => message.codes.includes('MIDA-100')
      ? new Promise(resolve => { resolveFirst = resolve; })
      : { ok: true, owned: message.codes },
  });
  try {
    const started = fixture.controller.start();
    fixture.doc.body.insertAdjacentHTML('beforeend', '<a>MIDA-100</a>');
    await new Promise(resolve => setTimeout(resolve, 400));
    resolveFirst({ ok: true, owned: ['MIDA-100'] });
    await started;
    assert.equal(fixture.doc.querySelector('a span')?.dataset.code, 'MIDA-100');
    assert.deepEqual([...fixture.doc.querySelectorAll('p span')].map(node => node.dataset.code), ['MIDA-100', 'MIDA-300']);
    fixture.doc.querySelector('p').firstChild.remove();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual([...fixture.doc.querySelectorAll('p span')].map(node => node.dataset.code), ['MIDA-300']);
  } finally { fixture.close(); }
});

test('unowned HTTP detail can still send with an API-compatible optional source URL', async () => {
  const fixture = page('<table><tr id="video_id"><td class="text">DLDSS-467</td></tr></table>',
    { url: 'http://www.javlibrary.com/ja/?v=work' });
  try {
    await fixture.controller.scan();
    assert.equal(fixture.doc.querySelector('button').disabled, false);
    await fixture.avSend.send('DLDSS-467');
    assert.equal(fixture.messages.at(-1).type, 'av-send');
    assert.equal(fixture.messages.at(-1).request.sourceUrl, null);
  } finally { fixture.close(); }
});

test('detail page button updates do not keep scheduling ownership scans', async () => {
  const fixture = page('<table><tr id="video_id"><td class="text">MIDA-703</td></tr></table>',
    { url: 'https://www.javlibrary.com/ja/?v=work' });
  let updates = 0;
  const setOwned = fixture.avSend.setOwned;
  fixture.avSend.setOwned = codes => { updates++; setOwned(codes); };
  try {
    await fixture.controller.start();
    const settled = updates;
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(updates, settled, 'own button text changes must not cause recurring scans');
    assert.equal(fixture.doc.querySelector('button').disabled, true);
  } finally { fixture.close(); }
});

test('unpaired or failed ownership checks stay silent and do not mark codes', async () => {
  for (const sendMessage of [async () => ({ ok: false, code: 'unpaired' }), async () => { throw Error('offline'); }]) {
    const fixture = page('<p>MIDA-703</p>', { sendMessage });
    try {
      await fixture.controller.scan();
      await fixture.controller.scan();
      assert.equal(fixture.doc.querySelector('p').textContent, 'MIDA-703');
      assert.equal(fixture.doc.querySelector('[role="status"]'), null);
      assert.equal(fixture.messages.length, 1);
    } finally { fixture.close(); }
  }
});

function background() {
  let listener, now = 0, identity = 'first', paired = true, fail = false;
  const requests = [];
  const context = {
    URL, importScripts() {}, Date: { now: () => now },
    LakomicsListApi: {
      readConnection: async () => paired ? { identity } : null,
      connectionIdentity: connection => connection?.identity,
      request: async (path, options) => {
        requests.push({ path, ...plain(options) });
        return fail ? { ok: false } : { ok: true, data: { owned: ['MIDA-703'] } };
      },
    },
    chrome: {
      runtime: { onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} } },
      contextMenus: { onClicked: { addListener() {} } },
    },
  };
  vm.runInNewContext(sources['av-lookup'], context);
  vm.runInNewContext(sources.background, context);
  return { requests, dispatch: codes => new Promise(resolve => listener({ type: 'av-owned', codes }, {}, resolve)),
    expire() { now += 300001; }, reconnect() { identity = 'second'; },
    unpair() { paired = false; }, fail() { fail = true; } };
}

test('background caches positive and negative answers for five minutes and scopes them to the connection', async () => {
  const worker = background();
  assert.deepEqual(plain(await worker.dispatch(['mida703', 'DLDSS-467'])), { ok: true, owned: ['MIDA-703'] });
  await worker.dispatch(['MIDA-703', 'DLDSS-467']);
  assert.equal(worker.requests.length, 1);
  assert.equal(worker.requests[0].path, '/v1/av-owned');
  assert.deepEqual(worker.requests[0].body, { codes: ['MIDA-703', 'DLDSS-467'] });
  worker.expire();
  await worker.dispatch(['MIDA-703']);
  assert.equal(worker.requests.length, 2);
  worker.reconnect();
  await worker.dispatch(['MIDA-703']);
  assert.equal(worker.requests.length, 3);
  worker.unpair();
  assert.equal((await worker.dispatch(['MIDA-703'])).ok, false);
});

test('background does not cache failed checks', async () => {
  const worker = background();
  worker.fail();
  assert.equal((await worker.dispatch(['MIDA-703'])).ok, false);
  await worker.dispatch(['MIDA-703']);
  assert.equal(worker.requests.length, 2);
});
