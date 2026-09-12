import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const html = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
const sources = await Promise.all(['classification-tree', 'api-client', 'profile-store', 'arc-collector'].map(name => readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8')));
const optionsSource = await readFile(new URL('../options/options.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('PC pasted link pairs through the existing API, then arc edits and local hiding persist when settings reopen', async () => {
  const memory = {}, requests = [];
  const classifications = { revision: 1, entries: [{ id: 'games', name: '게임', parentId: null }, { id: 'other', name: '기타', parentId: null }, { id: 'child', name: '하위', parentId: 'games' }] };
  let profile = { revision: 1, pinnedClassificationIds: [], listOrder: {}, preferences: {} };
  async function open() {
    const dom = new JSDOM(html, { url: 'https://extension.test/options.html', runScripts: 'outside-only' });
    const w = dom.window;
    w.fetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/v1/extension/pair')) return { ok: true, status: 200, json: async () => ({ clientToken: 'test-client-token-with-enough-length', serverOrigin: 'https://cloud.example.test', clientId: 'test', classifications, profile }) };
      if (init.method === 'PATCH') { const patch = JSON.parse(init.body); profile = { ...profile, revision: profile.revision + 1, listOrder: { ...profile.listOrder, ...patch.listOrderPatch } }; return { ok: true, status: 200, json: async () => profile }; }
      return { ok: true, status: 200, json: async () => ({ classifications, profile }) };
    };
    w.chrome = { storage: { local: {
      async get(keys) { return Object.fromEntries(keys.map(key => [key, memory[key]])); },
      async set(values) { Object.assign(memory, structuredClone(values)); },
      async remove(keys) { for (const key of keys) delete memory[key]; },
    } }, runtime: { async sendMessage(message) {
      const store = w.LakomicsProfileStore, api = w.LakomicsListApi;
      if (message.type === 'settings:get') return { paired: Boolean(await api.readConnection()), state: await store.readState() };
      if (message.type === 'pair') { const result = await api.pair(message.value); return result.ok ? { ...result, state: await store.seed(result.bootstrap) } : result; }
      if (message.type === 'profile:refresh') return store.refresh();
      if (message.type === 'profile:patch') return store.patchProfile(message.patch);
      if (message.type === 'arc:hidden') return store.setHidden(message.ids);
      throw new Error('Unexpected message type');
    } } };
    for (const source of sources) w.eval(source);
    w.eval(optionsSource); await tick();
    return { dom, w, doc: w.document, arc: () => w.document.querySelector('#order-editor').firstElementChild.shadowRoot };
  }
  const first = await open();
  assert.equal(first.doc.querySelector('#pair-form').hidden, false);
  assert.match(first.doc.querySelector('#pair-help').textContent, /PC 확장 연결/);
  const secret = 'A'.repeat(43);
  first.doc.querySelector('#pairing').value = `https://cloud.example.test/extension-pair#${secret}`;
  first.doc.querySelector('#pair-form').dispatchEvent(new first.w.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(first.doc.querySelector('#pair-form').hidden, true);
  assert.equal(first.doc.querySelector('#pairing').value, '');
  assert.equal(requests[0].url, 'https://cloud.example.test/v1/extension/pair');
  assert.equal(JSON.parse(requests[0].init.body).secret, secret);
  assert.equal(first.doc.querySelector('#order-editor').firstElementChild.id, 'lakomics-arc-collector');
  first.arc().querySelector('[data-classification-id="games"]').click();
  first.arc().querySelector('.move-after').click(); await tick();
  assert.equal(first.arc().querySelector('[data-classification-id="games"]').dataset.slot, '1');
  first.arc().querySelector('.hide-folder').click(); await tick();
  assert.equal(first.arc().querySelector('[data-classification-id="games"]'), null);
  assert.equal(first.doc.querySelector('#hidden-count').textContent, '1');
  const patchCount = requests.filter(request => request.init.method === 'PATCH').length;
  assert.equal(patchCount, 1);
  first.dom.window.close();
  const second = await open();
  assert.equal(second.arc().querySelector('[data-classification-id="games"]'), null);
  second.doc.querySelector('#hidden-folders button').click(); await tick();
  assert.equal(second.arc().querySelector('[data-classification-id="games"]').dataset.slot, '1');
  assert.equal(requests.filter(request => request.init.method === 'PATCH').length, patchCount);
  second.dom.window.close();
});
