import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const script = await readFile(new URL('../src/x-home-refresh.js', import.meta.url), 'utf8');
const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const windows = [];
afterEach(() => { for (const w of windows.splice(0)) w.close(); });

const NAV = '<header role="banner"><nav role="navigation" aria-label="Primary">'
  + '<a href="/home" data-testid="AppTabBar_Home_Link" role="link"><div><svg></svg><span>Home</span></div></a>'
  + '<a href="/explore" data-testid="AppTabBar_Explore_Link" role="link">Explore</a>'
  + '<a href="/me" data-testid="AppTabBar_Profile_Link" role="link">Profile</a></nav></header>';

function page({ nav = NAV, timeline = '', path = '/home' } = {}) {
  const dom = new JSDOM(`<body><div id="app">${nav}<main><div data-testid="primaryColumn">${timeline}</div></main></div></body>`,
    { url: `https://x.com${path}`, runScripts: 'outside-only' });
  const w = dom.window; windows.push(w);
  w.__LAKOMICS_TEST__ = true;
  const scrolls = [];
  w.scrollTo = options => scrolls.push(typeof options === 'object' ? options.top : 0);
  w.requestAnimationFrame = callback => w.setTimeout(() => callback(Date.now()), 0);
  w.eval(script);
  const clicks = [];
  const track = selector => w.document.querySelector(selector)?.addEventListener('click', event => { event.preventDefault(); clicks.push(selector); });
  return { w, api: w.LakomicsXHomeRefresh, scrolls, clicks, track, control: () => w.document.getElementById('lakomics-x-new-posts-nav') };
}

test('the control is inserted once after Home and survives X re-rendering its nav', async () => {
  const t = page();
  t.api.install(t.w.document, t.w);
  const control = t.control();
  assert.ok(control);
  assert.equal(control.tagName, 'BUTTON');
  assert.equal(control.type, 'button');
  assert.equal(control.previousElementSibling.dataset.testid, 'AppTabBar_Home_Link');
  assert.match(control.getAttribute('aria-label'), /새 게시물/);
  assert.equal(control.hasAttribute('title'), false);
  assert.equal(control.querySelector('svg').getAttribute('aria-hidden'), 'true');

  // Unrelated mutations and repeated ensure calls never duplicate it.
  t.w.document.body.append(t.w.document.createElement('div'));
  t.api.ensureControl(t.w.document, t.w);
  await wait();
  assert.equal(t.w.document.querySelectorAll('#lakomics-x-new-posts-nav').length, 1);
  assert.equal(t.w.document.querySelectorAll('#lakomics-x-new-posts-style').length, 1);

  // SPA navigation: X replaces the whole header; the control comes back once.
  t.w.document.querySelector('header').outerHTML = NAV;
  await wait();
  assert.equal(t.w.document.querySelectorAll('#lakomics-x-new-posts-nav').length, 1);
  assert.equal(t.control().previousElementSibling.dataset.testid, 'AppTabBar_Home_Link');
});

test('missing navigation or Home link is tolerated and injects nothing', async () => {
  const t = page({ nav: '' });
  assert.doesNotThrow(() => t.api.install(t.w.document, t.w));
  assert.equal(t.control(), null);
  assert.equal(t.api.refreshTimeline(t.w.document, t.w), 'shortcut');

  const u = page({ nav: '<header role="banner"><nav role="navigation"><a href="/explore">Explore</a></nav></header>' });
  assert.equal(u.api.ensureControl(u.w.document, u.w), null);
  assert.equal(u.control(), null);
  // The nav appears later (X renders lazily): the observer picks it up.
  u.api.install(u.w.document, u.w);
  u.w.document.querySelector('nav').insertAdjacentHTML('afterbegin', '<a href="/home" data-testid="AppTabBar_Home_Link">Home</a>');
  await wait();
  assert.ok(u.control());
});

test('clicking scrolls to the top and opens X\'s "Show N posts" row when present', async () => {
  const t = page({ timeline: '<div data-testid="cellInnerDiv"><div role="button" id="show">Show 35 posts</div></div>'
    + '<div data-testid="cellInnerDiv"><article>post</article></div>' });
  t.api.install(t.w.document, t.w);
  t.track('#show'); t.track('[data-testid="AppTabBar_Home_Link"]');
  t.control().click();
  assert.deepEqual(t.scrolls, [0]);
  assert.deepEqual(t.clicks, ['#show']);
});

test('the floating new-posts pill and Korean rows are recognised', () => {
  const t = page({ timeline: '<div role="button" id="pill"><div data-testid="pillLabel">posted</div></div>' });
  assert.equal(t.api.findNewPostsButton(t.w.document).id, 'pill');
  for (const text of ['Show 35 posts', 'Show 1 post', 'See 12 new posts', '게시물 35개 보기', '35개의 새 게시물 보기', '12件のポストを表示']) {
    assert.equal(t.api.isNewPostsText(text), true, text);
  }
  for (const text of ['Show more replies', 'Show this thread', '게시물', 'Show 35 posts from Alice']) {
    assert.equal(t.api.isNewPostsText(text), false, text);
  }
});

test('without a new-posts row the Home tab is re-selected, and a row that appears later is opened', async () => {
  const t = page({ timeline: '<div data-testid="cellInnerDiv"><article>post</article></div>' });
  t.api.install(t.w.document, t.w);
  t.track('[data-testid="AppTabBar_Home_Link"]');
  t.control().click();
  assert.deepEqual(t.scrolls, [0]);
  assert.deepEqual(t.clicks, ['[data-testid="AppTabBar_Home_Link"]']);
  // Double clicks inside the guard window do nothing more.
  t.control().click();
  assert.equal(t.clicks.length, 1);

  const column = t.w.document.querySelector('[data-testid="primaryColumn"]');
  column.insertAdjacentHTML('afterbegin', '<div data-testid="cellInnerDiv"><button id="late">게시물 3개 보기</button></div>');
  t.track('#late');
  const end = Date.now() + 3000;
  while (!t.clicks.includes('#late') && Date.now() < end) await wait(50);
  assert.deepEqual(t.clicks, ['[data-testid="AppTabBar_Home_Link"]', '#late']);
});

test('away from Home the control goes back through X\'s Home tab without scrolling or reloading', () => {
  const t = page({ path: '/someone/status/1' });
  t.api.install(t.w.document, t.w);
  t.track('[data-testid="AppTabBar_Home_Link"]');
  t.control().click();
  assert.deepEqual(t.clicks, ['[data-testid="AppTabBar_Home_Link"]']);
  assert.deepEqual(t.scrolls, []);
  assert.equal(t.w.location.pathname, '/someone/status/1');
});

test('the control is a keyboard-reachable native button', () => {
  const t = page();
  t.api.install(t.w.document, t.w);
  t.control().focus();
  assert.equal(t.w.document.activeElement, t.control());
});
