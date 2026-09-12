import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('collection uses the arc menu and keeps the list editor out of content pages', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const scripts = manifest.content_scripts.flatMap(entry=>entry.js || []);
  const collectors = manifest.content_scripts.filter(entry => entry.js?.includes('src/content.js'));
  assert.equal(collectors.length, 2);
  for (const entry of collectors) {
    assert.ok(entry.js.indexOf('src/arc-collector.js') < entry.js.indexOf('src/content.js'));
    assert.ok(entry.js.includes('src/arc-collector.js'));
    assert.equal(entry.js.includes('src/list-collector.js'), false);
  }
  assert.equal(scripts.some(path=>/gesture|radial/i.test(path)), false);
  assert.equal(manifest.name, 'Lakomics Collector List');
});


test('permanent saves remain server-only while temporary PC saves allow downloads', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('downloads'));

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
