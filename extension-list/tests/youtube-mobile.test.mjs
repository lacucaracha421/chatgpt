import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const contentSource = await readFile(new URL('../src/youtube/content.js', import.meta.url), 'utf8');
const hookSource = await readFile(new URL('../src/youtube/page-hook.js', import.meta.url), 'utf8');
const serviceSource = await readFile(new URL('../src/youtube/service.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const MOBILE_URL = 'https://m.youtube.com/watch?v=video12';
const DESKTOP_URL = 'https://www.youtube.com/watch?v=video12';
const MOBILE_HTML = '<div id="movie_player"><video></video><player-top-controls><div class="player-controls-top">' +
  '<player-autonav-toggle><button class="ytwAutonavToggleButtonHost"></button></player-autonav-toggle>' +
  '<ytm-closed-captioning-button><button aria-label="CC"></button></ytm-closed-captioning-button>' +
  '<button class="icon-button player-settings-icon" aria-label="settings"></button>' +
  '</div></player-top-controls></div>';
const DESKTOP_HTML = '<div id="movie_player"><div class="ytp-right-controls"><button class="ytp-subtitles-button"></button>' +
  '<button class="ytp-settings-button"></button></div></div>';

async function mount(t, html, url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.console.info = () => {};
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.chrome = { storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true, cached: null }) } };
  w.eval(contentSource); await tick(); await tick();
  return w;
}
const frame = w => new Promise(resolve => w.requestAnimationFrame(() => resolve()));

test('manifest runs the YouTube hook and UI on both www and m.youtube.com', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const hook = manifest.content_scripts.find(item => item.js?.includes('src/youtube/page-hook.js'));
  const ui = manifest.content_scripts.find(item => item.js?.includes('src/youtube/content.js'));
  for (const script of [hook, ui]) assert.deepEqual(script.matches, ['https://www.youtube.com/*', 'https://m.youtube.com/*']);
  assert.ok(manifest.host_permissions.includes('https://*/*'));
});

test('page hook copies m.youtube.com timedtext responses and still refuses other hosts', async () => {
  const posts = [];
  const sandbox = { location: { href: MOBILE_URL, origin: 'https://m.youtube.com' },
    fetch: async () => ({ clone() { return { text: async () => '{"events":[]}' }; } }),
    postMessage: data => posts.push(data), addEventListener() {} };
  class XHR { open() {} }
  vm.runInNewContext(hookSource, { window: sandbox, URL, AbortController, setTimeout, clearTimeout, XMLHttpRequest: XHR });
  const mobile = 'https://m.youtube.com/api/timedtext?v=video12&lang=en&fmt=json3';
  await sandbox.fetch(mobile); await tick(); await tick();
  assert.deepEqual(posts.map(p => [p.type, p.url]), [['timedtext', mobile]]);
  await sandbox.fetch('https://evil.example/api/timedtext?v=video12'); await tick(); await tick();
  await sandbox.fetch('https://m.youtube.com/api/other'); await tick(); await tick();
  await sandbox.fetch('https://m.youtube.com.evil.example/api/timedtext'); await tick(); await tick();
  assert.equal(posts.length, 1);
});

test('worker accepts youtube messages from m.youtube.com but not from look-alike hosts', () => {
  const start = serviceSource.indexOf('function youtubeSender');
  const end = serviceSource.indexOf('function validProcess');
  assert.ok(start >= 0 && end > start, 'youtubeSender source found');
  const check = vm.runInNewContext('(' + serviceSource.slice(start, end).trim().replace(/^function youtubeSender/, 'function') + ')',
    { chrome: { runtime: { id: 'test' } }, URL, Number });
  const sender = url => ({ id: 'test', frameId: 0, tab: { id: 1 }, url });
  assert.equal(check(sender(MOBILE_URL)), true);
  assert.equal(check(sender(DESKTOP_URL)), true);
  assert.equal(check(sender('https://m.youtube.com.evil.example/watch?v=a')), false);
  assert.equal(check(sender('https://music.youtube.com/watch?v=a')), false);
});

test('mobile layout: the AI button mounts in the top-right icon row between CC and settings', async t => {
  const w = await mount(t, MOBILE_HTML, MOBILE_URL);
  const row = w.document.querySelector('.player-controls-top');
  const button = w.document.getElementById('lakomics-yt-button');
  assert.ok(button);
  assert.equal(button.parentNode, row);
  assert.equal(button.classList.contains('lakomics-yt-mobile'), true);
  assert.equal(button.classList.contains('ytp-button'), false);
  assert.equal(button.previousElementSibling.tagName.toLowerCase(), 'ytm-closed-captioning-button');
  assert.ok(button.nextElementSibling.classList.contains('player-settings-icon'));
  assert.equal(button.querySelector('.lakomics-yt-icon').textContent, 'AI');
  assert.equal(w.document.querySelectorAll('#lakomics-yt-button').length, 1);
});

test('mobile layout: taps on the AI button stay off the player, and the button re-mounts after the row is replaced', async t => {
  const w = await mount(t, MOBILE_HTML, MOBILE_URL);
  const player = w.document.getElementById('movie_player');
  const seen = [];
  for (const name of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click'])
    player.addEventListener(name, () => seen.push(name));
  const first = w.document.getElementById('lakomics-yt-button');
  for (const name of ['pointerdown', 'touchstart', 'touchend', 'pointerup', 'mousedown', 'mouseup'])
    first.dispatchEvent(new w.Event(name, { bubbles: true }));
  assert.deepEqual(seen, []);

  // YouTube re-renders the whole control row.
  const controls = w.document.querySelector('player-top-controls');
  controls.innerHTML = '<div class="player-controls-top"><ytm-closed-captioning-button><button aria-label="CC"></button></ytm-closed-captioning-button>' +
    '<button class="icon-button player-settings-icon"></button></div>';
  assert.equal(first.isConnected, false);
  await frame(w); await tick();
  const second = w.document.getElementById('lakomics-yt-button');
  assert.ok(second && second.isConnected);
  assert.notEqual(second, first);
  assert.equal(second.parentNode, controls.querySelector('.player-controls-top'));
  assert.equal(w.document.querySelectorAll('#lakomics-yt-button').length, 1);

  // Navigation to another video keeps exactly one button.
  w.document.dispatchEvent(new w.Event('yt-navigate-finish'));
  assert.equal(w.document.querySelectorAll('#lakomics-yt-button').length, 1);
});

test('mobile layout: a row without CC or settings buttons still gets the button', async t => {
  const w = await mount(t, '<div id="movie_player"><div class="player-controls-top"><player-autonav-toggle></player-autonav-toggle></div></div>', MOBILE_URL);
  const button = w.document.getElementById('lakomics-yt-button');
  assert.ok(button);
  assert.equal(button.parentNode.className, 'player-controls-top');
});

test('desktop layout is unchanged: the button sits before the settings button in .ytp-right-controls', async t => {
  const w = await mount(t, DESKTOP_HTML, DESKTOP_URL);
  const controls = w.document.querySelector('.ytp-right-controls');
  const button = w.document.getElementById('lakomics-yt-button');
  assert.ok(button);
  assert.equal(button.parentNode, controls);
  assert.equal(button.className, 'ytp-button');
  assert.ok(button.nextElementSibling.classList.contains('ytp-settings-button'));
  controls.removeChild(button);
  await frame(w); await tick();
  assert.equal(w.document.querySelectorAll('#lakomics-yt-button').length, 1);
});

test('stylesheet sizes the mobile button as a 48 px icon button and keeps hiding YouTube captions through the shared container', async () => {
  const css = await readFile(new URL('../src/youtube/content.css', import.meta.url), 'utf8');
  assert.match(css, /#lakomics-yt-button\.lakomics-yt-mobile\s*\{[^}]*width:\s*48px;[^}]*height:\s*48px/);
  assert.match(css, /#movie_player\.lakomics-yt-active \.ytp-caption-window-container/);
});
