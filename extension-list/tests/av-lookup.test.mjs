import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const lookupSource = await readFile(new URL('../src/av-lookup.js', import.meta.url), 'utf8');
const chipSource = await readFile(new URL('../src/av-lookup-chip.js', import.meta.url), 'utf8');
const backgroundSource = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function loadLookup() {
  const context = {};
  vm.runInNewContext(lookupSource, context);
  return context.LakomicsAvLookup;
}

test('AV selection normalization extracts and canonicalizes product codes', () => {
  const lookup = loadLookup();
  const cases = [
    [' SSIS-123 ', 'SSIS-123'],
    ['ssis123', 'SSIS-123'],
    ['SSIS 123', 'SSIS-123'],
    ['FC2PPV 1234567', 'FC2-PPV-1234567'],
    ['FC2-PPV-1234567', 'FC2-PPV-1234567'],
    ['300MIUM 12A', '300MIUM-12A'],
    ['Actress Name', 'Actress Name'],
    ['  Actress   Name  ', 'Actress Name'],
    ['', ''],
    ['x'.repeat(61), ''],
  ];
  for (const [input, expected] of cases) assert.equal(lookup.normalizeQuery(input), expected, input);
  assert.equal(lookup.productCodeFromText('title SSIS123 actress'), 'SSIS-123');
  assert.equal(lookup.normalizeQuery('title ' + 'x'.repeat(100) + ' FC2-PPV-1234567'), 'FC2-PPV-1234567');
  assert.equal(lookup.normalizeQuery('A123'), 'A123');
  assert.equal(lookup.productCodeFromText('A123'), '');
});

test('AV lookup URL building keeps the configured site order and encodes the query', () => {
  const lookup = loadLookup();
  assert.deepEqual(plain(lookup.buildLookupUrls('SSIS-123')), [
    'https://www.javlibrary.com/ja/vl_searchbyid.php?keyword=SSIS-123',
  ]);
  assert.deepEqual(plain(lookup.buildLookupUrls('Actress & Name')), [
    'https://www.javlibrary.com/ja/vl_searchbyid.php?keyword=Actress%20%26%20Name',
  ]);
});

function backgroundFixture() {
  let contextMenuClick;
  let installed;
  let messageListener;
  const createdMenu = [];
  const tabs = [];
  const lookup = loadLookup();
  const context = {
    Promise,
    URL,
    importScripts() {},
    LakomicsAvLookup: lookup,
    LakomicsProfileStore: { refresh: async () => ({ ok: true }) },
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { messageListener = listener; } },
        onInstalled: { addListener(listener) { installed = listener; } },
        onStartup: { addListener() {} },
      },
      contextMenus: {
        create(details) { createdMenu.push(details); },
        onClicked: { addListener(listener) { contextMenuClick = listener; } },
      },
      tabs: { create: async details => { tabs.push(details); return { id: tabs.length }; } },
    },
  };
  vm.runInNewContext(backgroundSource, context);
  return { context, createdMenu, tabs, get contextMenuClick() { return contextMenuClick; }, get installed() { return installed; }, dispatch(message, sender) {
    return new Promise(resolve => messageListener(message, sender, resolve));
  } };
}

test('context menu is created on install and opens lookup tabs in order beside the source tab', async () => {
  const fixture = backgroundFixture();
  await fixture.installed();
  assert.deepEqual(plain(fixture.createdMenu), [{ id: 'lakomics-av-lookup', title: 'AV 표지 찾기: “%s”', contexts: ['selection'] },
    { id: 'lakomics-av-send', title: 'AV 컬렉션에 보내기: “%s”', contexts: ['selection'], documentUrlPatterns: ['https://*/*'] }]);

  const result = await fixture.contextMenuClick(
    { menuItemId: 'lakomics-av-lookup', selectionText: 'ssis123' },
    { id: 17, index: 4 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(plain(fixture.tabs), [
    { url: 'https://www.javlibrary.com/ja/vl_searchbyid.php?keyword=SSIS-123', active: false, index: 5, openerTabId: 17 },
  ]);
});

test('touch message uses the same background tab opener path and rejects empty selections', async () => {
  const fixture = backgroundFixture();
  const result = await fixture.dispatch({ type: 'av-lookup', selectionText: 'FC2 PPV 1234567' }, { tab: { id: 9, index: 2 } });
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.tabs.map(tab => tab.index), [3]);
  const invalid = await fixture.dispatch({ type: 'av-lookup', selectionText: 'x'.repeat(61) }, { tab: { id: 9, index: 2 } });
  assert.deepEqual(plain(invalid), { ok: false, code: 'invalid_query' });
});

function selectionFixture(html = '<p id="text">SSIS-123</p>') {
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only' });
  const w = dom.window;
  w.__LAKOMICS_TEST__ = true;
  w.eval(lookupSource);
  w.eval(chipSource);
  const messages = [];
  const controller = w.LakomicsAvLookupChip.createChipController({
    doc: w.document,
    win: w,
    lookup: w.LakomicsAvLookup,
    sendMessage: message => messages.push(message),
  });
  function select(node, start = 0, end = node.textContent.length) {
    const range = w.document.createRange();
    range.setStart(node.firstChild, start);
    range.setEnd(node.firstChild, end);
    range.getBoundingClientRect = () => ({ left: 80, top: 40, right: 150, bottom: 60, width: 70, height: 20 });
    range.getClientRects = () => [range.getBoundingClientRect()];
    const selection = w.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    w.document.dispatchEvent(new w.Event('selectionchange'));
  }
  return { w, controller, messages, select, close: () => { controller.destroy(); w.close(); } };
}

test('touch chip appears only for product-code selections and opens the stored selection', () => {
  const fixture = selectionFixture();
  const chip = fixture.controller.chip;
  fixture.select(fixture.w.document.querySelector('#text'));
  assert.equal(chip.hidden, false);
  chip.querySelector("button").click();
  assert.deepEqual(plain(fixture.messages), [{ type: 'av-lookup', selectionText: 'SSIS-123' }]);

  fixture.select(fixture.w.document.querySelector('#text'));
  assert.equal(chip.hidden, false);
  const node = fixture.w.document.querySelector('#text');
  node.textContent = 'ordinary title';
  fixture.select(node);
  assert.equal(chip.hidden, true);
  fixture.close();
});

test('touch chip stays hidden for input, textarea, and contenteditable selections', () => {
  const fixture = selectionFixture('<input id="input" value="SSIS-123"><textarea id="textarea">SSIS-123</textarea><div id="editable" contenteditable="true">SSIS-123</div><p id="text">SSIS-123</p>');
  const { w, controller } = fixture;
  const input = w.document.querySelector('#input');
  input.focus(); controller.update(); assert.equal(controller.chip.hidden, true);
  const textarea = w.document.querySelector('#textarea');
  textarea.focus(); controller.update(); assert.equal(controller.chip.hidden, true);
  w.document.activeElement?.blur();
  fixture.select(w.document.querySelector('#editable'));
  assert.equal(controller.chip.hidden, true);
  fixture.close();
});

test('chip hides on scroll, Escape, and a changed selection', () => {
  const fixture = selectionFixture();
  fixture.select(fixture.w.document.querySelector('#text'));
  assert.equal(fixture.controller.chip.hidden, false);
  fixture.w.document.dispatchEvent(new fixture.w.Event('scroll'));
  assert.equal(fixture.controller.chip.hidden, true);
  fixture.w.document.dispatchEvent(new fixture.w.KeyboardEvent('keydown', { key: 'Escape' }));
  fixture.select(fixture.w.document.querySelector('#text'));
  assert.equal(fixture.controller.chip.hidden, false);
  fixture.w.document.querySelector('#text').textContent = 'title only';
  fixture.select(fixture.w.document.querySelector('#text'));
  assert.equal(fixture.controller.chip.hidden, true);
  fixture.close();
});

test('manifest grants context menus, carries version 3.0.0.48, and excludes the pairing page from the chip', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '3.0.0.48');
  assert.equal(manifest.version_name, '3.0.0-alpha.48');
  assert.ok(manifest.permissions.includes('contextMenus'));
  const general = manifest.content_scripts.find(entry => entry.matches?.includes('https://*/*'));
  assert.ok(general.js.includes('src/av-lookup.js'));
  assert.ok(general.js.includes('src/av-lookup-chip.js'));
  assert.deepEqual(general.exclude_matches.filter(value => /extension-pair/.test(value)), ['https://*/extension-pair*']);
  const pairing = manifest.content_scripts.find(entry => entry.js?.includes('src/pairing-bridge.js'));
  assert.equal(pairing.js.includes('src/av-lookup-chip.js'), false);
});
