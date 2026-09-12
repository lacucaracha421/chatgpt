import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

globalThis.__LAKOMICS_TEST__ = true;
const dom = new JSDOM('<!doctype html><body><div data-testid="tweetPhoto"><div id="wrap"><img id="img"></div></div></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
await import('../src/x-gallery.js');
const gallery = globalThis.LakomicsXGallery;

test('saved badge reuses an existing positioned media wrapper without mutating X layout', () => {
  const image = document.querySelector('#img');
  const wrap = document.querySelector('#wrap');
  const photo = document.querySelector('[data-testid="tweetPhoto"]');
  const host = gallery.stableTimelineBadgeHost(image, (node) => ({ position: node === wrap ? 'relative' : 'static' }));
  assert.equal(host, wrap);
  assert.equal(photo.getAttribute('style'), null);
  assert.equal(wrap.getAttribute('style'), null);
});

test('saved badge refuses to invent a positioning context', () => {
  const image = document.querySelector('#img');
  const host = gallery.stableTimelineBadgeHost(image, () => ({ position: 'static' }));
  assert.equal(host, null);
});
