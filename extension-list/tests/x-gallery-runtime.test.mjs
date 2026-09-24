import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const sourceScript = await readFile(new URL('../src/x-source.js', import.meta.url), 'utf8');
const galleryScript = await readFile(new URL('../src/x-gallery.js', import.meta.url), 'utf8');
const SAVED = 'lakomicsXGallerySavedMediaV1', DISMISSED = 'lakomicsXGalleryDismissedMediaV1';
const AFFINITY = 'lakomicsXGalleryArtistAffinityV1', DISINTEREST = 'lakomicsXGalleryArtistDisinterestV2';
const DAY = 24 * 60 * 60 * 1000;
const media = id => `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`;
const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
// Poll instead of guessing a delay: the full suite runs many jsdom windows at once.
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for condition'); await wait(10); }
}
const windows = [];
afterEach(() => { for (const w of windows.splice(0)) w.close(); });

function helpers() {
  const dom = new JSDOM('<body></body>', { url: 'https://x.com/home', runScripts: 'outside-only' });
  windows.push(dom.window);
  dom.window.__LAKOMICS_TEST__ = true;
  dom.window.eval(sourceScript); dom.window.eval(galleryScript);
  return dom.window;
}

// One shared chrome.storage.local for every tab, with storage.onChanged fan-out.
function sharedStorage(initial = {}) {
  const memory = structuredClone(initial), listeners = [], queues = new Map();
  // Web Locks are shared by every tab of one origin; a per-name FIFO models that.
  const locks = { request(name, callback) { const previous = queues.get(name) ?? Promise.resolve(); const run = previous.then(() => callback()); queues.set(name, run.catch(() => {})); return run; } };
  // A closed test window must never be called back.
  const live = w => { try { return Boolean(w.document?.location); } catch { return false; } };
  const later = (w, fn) => setTimeout(() => { if (live(w)) fn(); }, 0);
  const notify = changes => setTimeout(() => { for (const [w, fn] of listeners) if (live(w)) fn(structuredClone(changes), 'local'); }, 0);
  return {
    memory, locks,
    storage(w) {
      return { local: {
        get(keys, callback) { const result = {}; for (const key of [].concat(keys)) if (key in memory) result[key] = structuredClone(memory[key]); later(w, () => callback(result)); },
        set(values, callback) { const changes = {}; for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: memory[key], newValue: structuredClone(value) }; memory[key] = structuredClone(value); } later(w, () => callback?.()); notify(changes); },
        remove(keys, callback) { for (const key of [].concat(keys)) delete memory[key]; later(w, () => callback?.()); },
      }, onChanged: { addListener(fn) { listeners.push([w, fn]); } } };
    },
  };
}

function article(id, { author = 'artist', photo = 1, likes = '1,234', image = `IMG${id}` } = {}) {
  return `<article data-testid="tweet"><a href="/${author}/status/${id}"><time datetime="2026-09-23T00:00:00Z"></time></a>`
    + `<div data-testid="tweetPhoto"><a href="/${author}/status/${id}/photo/${photo}"><img src="https://pbs.twimg.com/media/${image}?format=jpg&name=small"></a></div>`
    + `<button data-testid="like" aria-label="${likes} Likes"></button></article>`;
}

function tab(shared, { articles = [article('100')], messages = [], trigger = true } = {}) {
  const dom = new JSDOM(`<body><div data-testid="primaryColumn"><div role="tablist"><div role="tab" aria-selected="true">추천</div><div role="tab" aria-selected="false">팔로잉</div></div><div id="timeline">${articles.join('')}</div></div></body>`,
    { url: 'https://x.com/home', runScripts: 'outside-only' });
  const w = dom.window; windows.push(w);
  // jsdom's pretendToBeVisual frame timer outlives window.close(); window timers do not.
  w.requestAnimationFrame = callback => w.setTimeout(() => callback(Date.now()), 16);
  w.cancelAnimationFrame = id => w.clearTimeout(id);
  w.structuredClone = structuredClone;
  Object.defineProperty(w.navigator, 'locks', { configurable: true, value: shared.locks });
  const scrolls = [];
  w.scrollTo = options => scrolls.push(typeof options === 'object' ? options.top : arguments[1]);
  w.scrollBy = () => {};
  w.IntersectionObserver = class { constructor(callback) { this.callback = callback; } observe(target) { w.setTimeout(() => this.callback([{ target, isIntersecting: true, intersectionRatio: 1 }]), 0); } unobserve() {} };
  w.chrome = { runtime: { sendMessage(message, callback) { messages.push(message.type); w.setTimeout(() => callback({ ok: false }), 0); } }, storage: shared.storage(w) };
  // The gallery button ships disabled; these tests exercise it by opting back in.
  if (trigger) w.__LAKOMICS_X_GALLERY_TRIGGER__ = true;
  w.eval(sourceScript); w.eval(galleryScript);
  const root = w.document.getElementById('lakomics-x-recommendation-gallery');
  return { w, root, scrolls, messages, $: selector => root.querySelector(selector), $$: selector => [...root.querySelectorAll(selector)] };
}

test('photo ordinal comes from the photo link, not from loaded-image order', () => {
  const w = helpers();
  const box = w.document.createElement('div');
  box.innerHTML = article('200', { photo: 3 });
  const post = w.LakomicsXGallery.extractPost(box.firstChild, 1);
  assert.equal(post.images[0].index, 3);
});

test('compact metrics, harvest decisions, disinterest decay and migration', () => {
  const g = helpers().LakomicsXGallery;
  assert.equal(g.parseCompactMetric('1.2K'), 1200);
  assert.equal(g.parseCompactMetric('3,4만'), 34000);
  assert.equal(g.parseCompactMetric('1億'), 100000000);
  assert.equal(g.parseCompactMetric('12,345'), 12345);
  assert.equal(g.nextAutoHarvestState({ currentCount: 5, targetCount: 5, noProgressRounds: 0, elapsedMs: 0, stillForYou: true, moved: true }).done, true);
  assert.equal(g.nextAutoHarvestState({ currentCount: 1, targetCount: 5, noProgressRounds: 0, elapsedMs: 0, stillForYou: true, moved: true }).done, false);
  const now = 100 * DAY;
  assert.ok(Math.abs(g.decayedDisinterest([now - 30 * DAY], now) - .5) < 1e-9);
  assert.equal(g.getArtistDisinterestScore({ username: 'a' }, new Map([['a', .6]])), 1);
  assert.equal(g.getArtistDisinterestScore({ username: 'a' }, new Map([['a', .4]])), 0);
  assert.equal(JSON.stringify(g.migrateDisinterestCounts({ A: 2 }, now)), JSON.stringify({ a: [now, now] }));
});

test('the store looks items up by key and evicts only the oldest images it may drop', () => {
  const g = helpers().LakomicsXGallery;
  const evicted = [];
  const keepKey = '1:1:' + media('one');
  const store = g.createGalleryStore(change => { if (change.type === 'evict') evicted.push(...change.items.map(g.galleryItemKey)); },
    { maxImages: 2, keep: item => g.galleryItemKey(item) === keepKey });
  for (const [id, at] of [['1', 1], ['2', 2], ['3', 3]]) store.upsert({ tweetId: id, username: 'a', author: '@a', postUrl: 'x', collectedAt: at, likeCount: 0, images: [{ url: media(id === '1' ? 'one' : id), index: 1 }] });
  assert.equal(store.imageCount(), 2);
  assert.deepEqual(evicted, ['2:1:' + media('2')]);
  assert.equal(store.get(keepKey).tweetId, '1');
  assert.equal(store.get('2:1:' + media('2')), null);
});

test('the recommended-images button stays hidden while its flag is off', async () => {
  assert.equal(helpers().LakomicsXGallery.GALLERY_TRIGGER_ENABLED, false);
  const t = tab(sharedStorage(), { trigger: false });
  await until(() => t.$('.lakomics-x-gallery-summary').textContent === '이미지 1장 · 게시물 1개');
  assert.equal(t.$('.lakomics-x-gallery-trigger').hidden, true);
  t.w.history.pushState({}, '', '/elonmusk'); t.w.history.pushState({}, '', '/home');
  t.w.dispatchEvent(new t.w.PopStateEvent('popstate'));
  assert.equal(t.$('.lakomics-x-gallery-trigger').hidden, true);
});

test('gallery chrome is Korean, tooltip-free, hides its trigger while open and traps focus', async () => {
  const t = tab(sharedStorage());
  await until(() => t.$('.lakomics-x-gallery-summary').textContent === '이미지 1장 · 게시물 1개');
  t.$('.lakomics-x-gallery-trigger').click();
  await until(() => t.$$('.lakomics-x-gallery-card').length === 1);
  assert.equal(t.$('.lakomics-x-gallery-trigger').hidden, true);
  assert.equal(t.$$('[title]').length, 0);
  const close = t.$('.lakomics-x-gallery-close');
  const focusable = t.$$('.lakomics-x-gallery-overlay button, .lakomics-x-gallery-overlay select, .lakomics-x-gallery-overlay a[href]').filter(node => !node.closest('[hidden]'));
  focusable.at(-1).focus();
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(t.w.document.activeElement, focusable[0]);
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(t.w.document.activeElement, focusable.at(-1));
  close.click();
  assert.equal(t.$('.lakomics-x-gallery-trigger').hidden, false);
});

test('Escape closes only the innermost surface: an open save menu keeps the gallery open', async () => {
  const t = tab(sharedStorage());
  await wait();
  t.$('.lakomics-x-gallery-trigger').click();
  const menu = t.w.document.createElement('div'); menu.id = 'lakomics-arc-collector'; t.w.document.documentElement.append(menu);
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(t.$('.lakomics-x-gallery-overlay').hidden, false);
  menu.remove();
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(t.$('.lakomics-x-gallery-overlay').hidden, true);
});

test('cards show the recommendation score as text', async () => {
  const t = tab(sharedStorage(), { articles: [article('300', { likes: '31K' })] });
  await wait();
  t.$('.lakomics-x-gallery-trigger').click(); await wait();
  const badge = t.$('.lakomics-x-gallery-recommended-badge');
  assert.equal(badge.hidden, false); assert.equal(badge.textContent, '추천 4');
});

test('a timeline save raises artist affinity and cancels that artist\'s newest disinterest', async () => {
  const shared = sharedStorage({ [DISINTEREST]: { artist: [Date.now() - 1000, Date.now()] } });
  const t = tab(shared);
  await wait();
  t.w.LakomicsXGalleryRuntime.markSaved(media('IMG100'), { postId: '100', mediaIndex: 1, author: 'Artist' });
  await wait(80);
  assert.equal(shared.memory[AFFINITY].artist, 1);
  assert.equal(shared.memory[DISINTEREST].artist.length, 1);
  assert.ok(shared.memory[SAVED][media('IMG100')]);
});

test('two tabs never drop each other\'s saves or affinity', async () => {
  const shared = sharedStorage();
  const a = tab(shared), b = tab(shared);
  await wait();
  a.w.LakomicsXGalleryRuntime.markSaved(media('A'), { author: 'alpha' });
  b.w.LakomicsXGalleryRuntime.markSaved(media('B'), { author: 'beta' });
  await wait(120);
  assert.deepEqual(Object.keys(shared.memory[SAVED]).sort(), [media('A'), media('B')].sort());
  assert.deepEqual(shared.memory[AFFINITY], { alpha: 1, beta: 1 });
  // Tab A learned tab B's save through storage.onChanged: saving B again there is
  // not a first save, so affinity does not double count.
  a.w.LakomicsXGalleryRuntime.markSaved(media('B'), { author: 'beta' });
  await wait(80);
  assert.equal(shared.memory[AFFINITY].beta, 1);
});

test('hiding a card can be undone, restoring the card and removing the disinterest event', async () => {
  const shared = sharedStorage();
  const t = tab(shared);
  await wait();
  t.$('.lakomics-x-gallery-trigger').click(); await wait();
  t.$('.lakomics-x-gallery-no-interest').click();
  await wait(80);
  assert.equal(t.$$('.lakomics-x-gallery-card').length, 0);
  assert.equal(t.$('.lakomics-x-gallery-toast').hidden, false);
  assert.ok(shared.memory[DISMISSED][media('IMG100')]);
  assert.equal(shared.memory[DISINTEREST].artist.length, 1);
  t.$('.lakomics-x-gallery-undo').click();
  await wait(80);
  assert.equal(t.$$('.lakomics-x-gallery-card').length, 1);
  assert.equal(shared.memory[DISMISSED][media('IMG100')], undefined);
  assert.equal(shared.memory[DISINTEREST].artist, undefined);
  assert.equal(t.$('.lakomics-x-gallery-toast').hidden, true);
});

test('학습 초기화 needs a second press and then clears affinity, disinterest and hidden images', async () => {
  const shared = sharedStorage({ [AFFINITY]: { artist: 3 }, [DISINTEREST]: { other: [Date.now()] }, [DISMISSED]: { [media('X')]: Date.now() } });
  const t = tab(shared);
  await wait();
  t.$('.lakomics-x-gallery-trigger').click();
  const reset = t.$('.lakomics-x-gallery-reset');
  reset.click(); await wait();
  assert.equal(reset.textContent, '한 번 더 누르면 초기화');
  assert.equal(shared.memory[AFFINITY].artist, 3);
  reset.click(); await wait(80);
  assert.deepEqual([shared.memory[AFFINITY], shared.memory[DISINTEREST], shared.memory[DISMISSED]], [{}, {}, {}]);
  assert.equal(reset.textContent, '학습 초기화');
});

test('a disinterest V1 count migrates to dated V2 events and the V1 key is removed', async () => {
  const shared = sharedStorage({ lakomicsXGalleryArtistDisinterestV1: { artist: 2 } });
  tab(shared);
  await wait(80);
  assert.equal(shared.memory[DISINTEREST].artist.length, 2);
  assert.equal('lakomicsXGalleryArtistDisinterestV1' in shared.memory, false);
});

test('a harvest stopped by leaving the timeline never scrolls the new page; a same-timeline stop returns', async () => {
  const t = tab(sharedStorage());
  await wait();
  t.$('.lakomics-x-gallery-trigger').click();
  t.$('.lakomics-x-gallery-auto').click();
  t.w.history.pushState({}, '', '/artist/status/100');
  t.w.dispatchEvent(new t.w.PopStateEvent('popstate'));
  await wait(200);
  assert.deepEqual(t.scrolls, []);
  t.w.history.pushState({}, '', '/home');
  t.w.dispatchEvent(new t.w.PopStateEvent('popstate'));
  t.$('.lakomics-x-gallery-trigger').click();
  t.$('.lakomics-x-gallery-auto').click();
  t.$('.lakomics-x-gallery-auto').click();
  await wait(200);
  assert.deepEqual(t.scrolls, [0]);
});

test('new images appear in the open gallery while auto-harvest runs', async () => {
  const t = tab(sharedStorage());
  await wait();
  t.$('.lakomics-x-gallery-trigger').click();
  t.$('.lakomics-x-gallery-auto').click();
  t.w.document.getElementById('timeline').insertAdjacentHTML('beforeend', article('101', { image: 'NEW' }));
  await wait(120);
  assert.ok(t.$('.lakomics-x-gallery-auto').classList.contains('is-running'));
  assert.equal(t.$$('.lakomics-x-gallery-card').length, 2);
  t.$('.lakomics-x-gallery-auto').click();
});

test('returning to the window refreshes the saved index at most once a minute', async () => {
  const messages = [];
  const t = tab(sharedStorage(), { messages });
  await wait();
  const initial = messages.filter(type => type === 'saved-index:get').length;
  t.w.dispatchEvent(new t.w.Event('focus'));
  await wait();
  assert.equal(messages.filter(type => type === 'saved-index:get').length, initial);
  const realNow = t.w.Date.now;
  t.w.Date.now = () => realNow() + 61_000;
  t.w.dispatchEvent(new t.w.Event('focus'));
  await wait();
  assert.equal(messages.filter(type => type === 'saved-index:get').length, initial + 1);
});
