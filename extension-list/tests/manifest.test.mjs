import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('list build has no radial or gesture entrypoints', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const scripts = manifest.content_scripts.flatMap(entry=>entry.js || []);
  assert.equal(scripts.some(path=>/gesture|layout|radial/i.test(path)), false);
  assert.equal(manifest.name, 'Lakomics Collector List');
});


test('server-only saves use stable DOM-local saved badges', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal((manifest.permissions || []).some((value) => value.startsWith('downloads')), false);

  const saveSource = await readFile(new URL('../src/save-client.js', import.meta.url), 'utf8');
  assert.equal(saveSource.includes('chrome.downloads'), false);

  const gallerySource = await readFile(new URL('../src/x-gallery.js', import.meta.url), 'utf8');
  assert.match(gallerySource, /const timelineSavedBadges = new WeakMap\(\)/);
  assert.match(gallerySource, /host\.append\(badge\)/);
  assert.equal(gallerySource.includes('window.addEventListener("scroll", queueTimelineSavedBadgeLayout'), false);

  const css = await readFile(new URL('../src/content.css', import.meta.url), 'utf8');
  assert.match(css, /\.lakomics-x-saved-badge-portal\{[^}]*width:30px;[^}]*height:30px;[^}]*background:#607e67/);
});

test('status toast is top-safe and saved badges never force X positioning', async () => {
  const css = await readFile(new URL('../src/content.css', import.meta.url), 'utf8');
  assert.match(css, /\.lakomics-list-toast\{[^}]*top:calc\(env\(safe-area-inset-top,0px\) \+ 14px\)/);
  assert.equal(css.includes('.lakomics-x-saved-badge-host{position:relative'), false);

  const gallerySource = await readFile(new URL('../src/x-gallery.js', import.meta.url), 'utf8');
  assert.equal(gallerySource.includes('host.classList.add("lakomics-x-saved-badge-host")'), false);
  assert.equal(gallerySource.includes('style.position'), false);
});


test('Android collector never calls the restricted Vibration API', async () => {
  const contentSource = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');
  const listSource = await readFile(new URL('../src/list-collector.js', import.meta.url), 'utf8');
  assert.equal(contentSource.includes('navigator.vibrate'), false);
  assert.equal(listSource.includes('navigator.vibrate'), false);
});
