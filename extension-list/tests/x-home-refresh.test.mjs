import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const script = await readFile(new URL('../src/x-home-refresh.js', import.meta.url), 'utf8');
const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const windows = [];
afterEach(() => { for (const w of windows.splice(0)) w.close(); });

// X's left column: logo, nav and Post button in a top block, the round account avatar
// (account switcher) in its own bottom block outside the nav.
const NAV_ITEMS = '<a href="/home" data-testid="AppTabBar_Home_Link" role="link"><div><svg></svg><span>Home</span></div></a>'
  + '<a href="/explore" data-testid="AppTabBar_Explore_Link" role="link">Explore</a>'
  + '<a href="/me" data-testid="AppTabBar_Profile_Link" role="link">Profile</a>'
  + '<a href="/settings" data-testid="AppTabBar_More_Menu">More</a>';
const SWITCHER = '<div id="bottom"><div id="avatar-wrap"><div><button data-testid="SideNav_AccountSwitcher_Button">avatar</button></div></div></div>';
const header = (switcher = SWITCHER) => '<header role="banner"><div><div id="column"><div id="top"><h1>X</h1>'
  + `<nav role="navigation" aria-label="Primary">${NAV_ITEMS}</nav><a href="/compose/post" data-testid="SideNav_NewTweet_Button">Post</a></div>`
  + `${switcher}</div></div></header>`;
const NAV = header();
// X's home timeline tabs are also links to /home.
const TABS = '<div role="tablist"><a href="/home" role="tab" id="for-you" aria-selected="true">추천</a>'
  + '<a href="/home" role="tab" id="following" aria-selected="false">팔로잉</a></div>';

function page({ nav = NAV, timeline = '', path = '/home', tabs = TABS } = {}) {
  const dom = new JSDOM(`<body><div id="app">${nav}<main><div data-testid="primaryColumn">${tabs}${timeline}</div></main></div></body>`,
    { url: `https://x.com${path}`, runScripts: 'outside-only' });
  const w = dom.window; windows.push(w);
  w.__LAKOMICS_TEST__ = true;
  const scrolls = [];
  w.scrollTo = options => scrolls.push(typeof options === 'object' ? options.top : 0);
  w.requestAnimationFrame = callback => w.setTimeout(() => callback(Date.now()), 0);
  w.eval(script);
  const clicks = [];
  const track = selector => w.document.querySelector(selector)?.addEventListener('click', event => { event.preventDefault(); clicks.push(selector); });
  // Record every click that reaches X's page so no unexpected control is ever hit.
  w.document.addEventListener('click', event => { event.preventDefault(); const el = event.target.closest('[id], [data-testid]'); if (el?.id !== 'lakomics-x-new-posts-nav') all.push(el?.id || el?.dataset.testid); }, true);
  const all = [];
  return { w, api: w.LakomicsXHomeRefresh, scrolls, clicks, all, track, control: () => w.document.getElementById('lakomics-x-new-posts-nav') };
}

test('the control is inserted once directly above the account avatar and survives X re-rendering its column', async () => {
  const t = page();
  t.api.install(t.w.document, t.w);
  const control = t.control();
  assert.ok(control);
  assert.equal(control.tagName, 'BUTTON');
  assert.equal(control.type, 'button');
  assert.equal(control.parentElement.id, 'bottom');
  assert.equal(control.nextElementSibling.id, 'avatar-wrap');
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
  assert.equal(t.control().nextElementSibling.id, 'avatar-wrap');
});

test('without the account avatar the control falls back to the end of the nav, then moves above the avatar once it renders', async () => {
  const t = page({ nav: header('') });
  t.api.install(t.w.document, t.w);
  assert.equal(t.control().parentElement.tagName, 'NAV');
  assert.equal(t.control().nextElementSibling, null);
  t.w.document.getElementById('column').insertAdjacentHTML('beforeend', SWITCHER);
  await wait();
  assert.equal(t.w.document.querySelectorAll('#lakomics-x-new-posts-nav').length, 1);
  assert.equal(t.control().nextElementSibling.id, 'avatar-wrap');
});

test('missing navigation or Home link is tolerated: nothing is injected and only a scroll happens', async () => {
  const t = page({ nav: '' });
  assert.doesNotThrow(() => t.api.install(t.w.document, t.w));
  assert.equal(t.control(), null);
  // The timeline tabs are /home links too, but are never used in place of the Home link.
  assert.equal(t.api.refreshTimeline(t.w.document, t.w), 'scrolled');
  assert.deepEqual(t.scrolls, [0]);
  assert.deepEqual(t.all, []);

  const u = page({ nav: '<header role="banner"><nav role="navigation"><a href="/home" id="generic-home">Home</a></nav></header>' });
  u.api.install(u.w.document, u.w);
  assert.ok(u.control());
  u.control().click();
  assert.deepEqual(u.scrolls, [0]);
  assert.deepEqual(u.all, []);
  await wait(600);
  assert.deepEqual(u.all, []);
});

test('on Home the only click is X\'s left-nav Home link, and a real "Show N posts" row is opened afterwards', async () => {
  const t = page({ timeline: '<div data-testid="cellInnerDiv"><div role="button" id="show">Show 35 posts</div></div>'
    + '<div data-testid="cellInnerDiv"><article>post</article></div>' });
  t.api.install(t.w.document, t.w);
  t.control().click();
  assert.deepEqual(t.scrolls, [0]);
  assert.deepEqual(t.all, ['AppTabBar_Home_Link']);
  const end = Date.now() + 3000;
  while (!t.all.includes('show') && Date.now() < end) await wait(50);
  assert.deepEqual(t.all, ['AppTabBar_Home_Link', 'show']);
});

test('the floating new-posts pill and Korean rows are recognised', () => {
  const t = page({ timeline: '<div role="button" id="pill"><div data-testid="pillLabel">posted</div></div>' });
  assert.equal(t.api.findNewPostsButton(t.w.document).id, 'pill');
  for (const text of ['Show 35 posts', 'Show 1 post', 'See 12 new posts', '게시물 35개 보기', '35개의 새 게시물 보기', '12件のポストを表示']) {
    assert.equal(t.api.isNewPostsText(text), true, text);
  }
  for (const text of ['Show more replies', 'Show this thread', '게시물', 'Show 35 posts from Alice', '팔로잉', '추천']) {
    assert.equal(t.api.isNewPostsText(text), false, text);
  }
  // A pill label or matching text inside the tab bar is never taken for the new-posts control.
  const u = page({ tabs: '<div role="tablist"><a role="tab" aria-selected="false" href="/home" id="following"><span data-testid="pillLabel">Show 3 posts</span></a></div>' });
  assert.equal(u.api.findNewPostsButton(u.w.document), null);
});

test('timeline tabs are never clicked, whichever tab is selected', async () => {
  for (const selected of ['for-you', 'following']) {
    const tabs = ['for-you', 'following'].map(id => `<a href="/home" role="tab" id="${id}" aria-selected="${id === selected}">${id}</a>`);
    const s = page({ tabs: `<div role="tablist">${tabs.join('')}</div>` });
    s.api.install(s.w.document, s.w);
    s.control().click();
    assert.deepEqual(s.all, ['AppTabBar_Home_Link']);
    assert.equal(s.w.document.querySelector('[aria-selected="true"]').id, selected);
  }

  const t = page({ timeline: '<div data-testid="cellInnerDiv"><article>post</article></div>' });
  t.api.install(t.w.document, t.w);
  t.control().click();
  // Double clicks inside the guard window do nothing more.
  t.control().click();
  assert.deepEqual(t.all, ['AppTabBar_Home_Link']);

  const column = t.w.document.querySelector('[data-testid="primaryColumn"]');
  column.insertAdjacentHTML('afterbegin', '<div data-testid="cellInnerDiv"><button id="late">게시물 3개 보기</button></div>');
  const end = Date.now() + 3000;
  while (!t.all.includes('late') && Date.now() < end) await wait(50);
  await wait(900);
  assert.deepEqual(t.all, ['AppTabBar_Home_Link', 'late']);
  assert.equal(t.all.some(id => id === 'for-you' || id === 'following'), false);
});

test('away from Home the control goes back through X\'s Home link without scrolling or reloading', () => {
  const t = page({ path: '/someone/status/1' });
  t.api.install(t.w.document, t.w);
  t.track('[data-testid="AppTabBar_Home_Link"]');
  t.control().click();
  assert.deepEqual(t.clicks, ['[data-testid="AppTabBar_Home_Link"]']);
  assert.deepEqual(t.all, ['AppTabBar_Home_Link']);
  assert.deepEqual(t.scrolls, []);
  assert.equal(t.w.location.pathname, '/someone/status/1');
});

test('the icon is shifted to the avatar centre from measured layout, re-measured on resize without stacking', async () => {
  const t = page({ nav: header('<div id="bottom"><div id="avatar-wrap"><button data-testid="SideNav_AccountSwitcher_Button"><div data-testid="UserAvatar-Container-me"><img></div><span>Me</span></button></div></div>') });
  const rect = (left, width) => ({ left, width, right: left + width, top: 0, bottom: width, height: width, x: left, y: 0 });
  let avatarLeft = 16; // full-width column: 40px avatar at x=16, centre 36
  t.w.document.querySelector('[data-testid="UserAvatar-Container-me"]').getBoundingClientRect = () => rect(avatarLeft, 40);
  // The icon's natural position is x=12 (centre 25.125); the applied shift moves it.
  t.w.HTMLElement.prototype.getBoundingClientRect = function () { return rect(0, 0); };
  t.w.SVGElement.prototype.getBoundingClientRect = function () {
    const shift = Number.parseFloat(this.closest('#lakomics-x-new-posts-nav')?.style.getPropertyValue('--lakomics-x-new-posts-shift')) || 0;
    return rect(12 + shift, 26.25);
  };
  t.api.install(t.w.document, t.w);
  const shift = () => t.control().style.getPropertyValue('--lakomics-x-new-posts-shift');
  assert.equal(shift(), '11px');
  // Measuring again with the shift applied changes nothing.
  assert.equal(t.api.alignControl(t.w.document, t.w), 11);
  // Icon-only column after a resize: avatar centred at x=33.
  avatarLeft = 13;
  t.w.dispatchEvent(new t.w.Event('resize'));
  await wait();
  assert.equal(shift(), '8px');
  // An avatar that is not laid out (hidden) keeps the last good shift.
  avatarLeft = 0; t.w.document.querySelector('[data-testid="UserAvatar-Container-me"]').getBoundingClientRect = () => rect(0, 0);
  assert.equal(t.api.alignControl(t.w.document, t.w), 8);
});

test('icon-only column: the button centres itself, the nudge settles near zero, and wide/compact switches re-measure via ResizeObserver', async () => {
  const t = page({ nav: header('<div id="bottom"><div id="avatar-wrap"><button data-testid="SideNav_AccountSwitcher_Button"><div data-testid="UserAvatar-Container-me"><img></div><span>Me</span></button></div></div>') });
  const observers = [];
  t.w.ResizeObserver = class { constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); } observe(node) { this.targets.add(node); } unobserve(node) { this.targets.delete(node); } disconnect() { this.targets.clear(); } };
  const rect = (left, width) => ({ left, width, right: left + width, top: 0, bottom: width, height: width, x: left, y: 0 });
  // Wide: avatar centre 36, icon naturally at x=12. Compact (88px column): X centres the
  // 40px avatar (centre 44) and the button's own centring puts the icon centre at 44 too.
  let compact = false;
  t.w.document.querySelector('[data-testid="UserAvatar-Container-me"]').getBoundingClientRect = () => compact ? rect(24, 40) : rect(16, 40);
  t.w.HTMLElement.prototype.getBoundingClientRect = function () { return rect(0, 0); };
  t.w.SVGElement.prototype.getBoundingClientRect = function () {
    const shift = Number.parseFloat(this.closest('#lakomics-x-new-posts-nav')?.style.getPropertyValue('--lakomics-x-new-posts-shift')) || 0;
    return rect((compact ? 30.875 : 12) + shift, 26.25);
  };
  t.api.install(t.w.document, t.w);
  const shift = () => t.control().style.getPropertyValue('--lakomics-x-new-posts-shift') || '0px';
  const ro = observers[0];
  assert.ok(ro.targets.has(t.control()));
  assert.ok(ro.targets.has(t.w.document.querySelector('[data-testid="UserAvatar-Container-me"]')));
  assert.ok(ro.targets.has(t.w.document.getElementById('avatar-wrap')));
  assert.equal(shift(), '11px');

  // The CSS centres the button in the icon-only column (same breakpoint as the label).
  const css = t.w.document.getElementById('lakomics-x-new-posts-style').textContent;
  assert.match(css, /@media \(max-width: 1264px\) \{ #lakomics-x-new-posts-nav \{ justify-content: center; \}/);

  // X collapses the column; only the ResizeObserver reports it (no resize event).
  compact = true;
  ro.callback([]);
  await wait();
  assert.equal(shift(), '0px');
  compact = false;
  ro.callback([]);
  await wait();
  assert.equal(shift(), '11px');

  // X swaps the avatar node on re-render: the observer follows the new node.
  t.w.document.getElementById('avatar-wrap').outerHTML = '<div id="avatar-wrap"><button data-testid="SideNav_AccountSwitcher_Button"><div data-testid="UserAvatar-Container-me"><img></div></button></div>';
  await wait();
  const fresh = t.w.document.querySelector('[data-testid="UserAvatar-Container-me"]');
  assert.ok(ro.targets.has(fresh));
  assert.equal(t.w.document.querySelectorAll('#lakomics-x-new-posts-nav').length, 1);
});

test('without an avatar no alignment shift is applied', () => {
  const t = page({ nav: header('') });
  t.api.install(t.w.document, t.w);
  assert.equal(t.control().style.getPropertyValue('--lakomics-x-new-posts-shift'), '');
});

test('the control is a keyboard-reachable native button', () => {
  const t = page();
  t.api.install(t.w.document, t.w);
  t.control().focus();
  assert.equal(t.w.document.activeElement, t.control());
});
