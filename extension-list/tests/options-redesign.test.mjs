import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';
const html = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../options/options.css', import.meta.url), 'utf8');
const source = await readFile(new URL('../options/options.js', import.meta.url), 'utf8');
const classification = await readFile(new URL('../src/classification-tree.js', import.meta.url), 'utf8');
const terms = await readFile(new URL('../src/translation/terms.js', import.meta.url), 'utf8');
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function clock(w) {
  let now = 0, next = 0; const timers = new Map();
  w.Date.now = () => now;
  w.setTimeout = (fn, delay = 0) => { const id = ++next; timers.set(id, {at:now+delay, fn}); return id; };
  w.clearTimeout = id => timers.delete(id);
  return async ms => {
    const end = now + ms; await drain();
    while (true) {
      const due = [...timers].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await drain();
    }
    now = end; await drain();
  };
}
const models = [{id:'google/flash',label:'Flash'}, {id:'anthropic:sonnet',label:'Sonnet'}];
async function fixture(t, options = {}) {
  const dom = new JSDOM(html, {url:'https://extension.test/options/options.html'+(options.hash || ''), runScripts:'outside-only'});
  const w = dom.window; t.after(() => w.close()); const advance = clock(w), messages = [], writes = [], tabs = [], scrolls = [], observers = [];
  w.matchMedia = () => ({matches:Boolean(options.reduce)});
  w.Element.prototype.scrollIntoView = function(value) { scrolls.push({id:this.id, ...value}); };
  w.IntersectionObserver = class { constructor(fn, opts) { observers.push({fn, opts, nodes:[]}); } observe(node) { observers.at(-1).nodes.push(node); } };
  let trans = {ok:true, enabled:true, model:models[0].id, fallbackModel:'', contextModel:'', imageModel:models[1].id,
    models, imageModels:models, userTerms:[], hasOpenRouterKey:true, hasAnthropicKey:false, ...options.translation};
  let yt = {enabled:true, model:'claude-haiku-5-5', translate:true, register:'auto', speakers:false, glossarySonnet:false, fontScale:1, position:'default', showOriginal:false, rolling:true};
  let onChanged; const memory = {'lakomics:context-menu:v1':{enabled:true,excludedHosts:[]}}, calls = [];
  w.chrome = {storage:{onChanged:{addListener(fn) { onChanged = fn; }}, local:{
    async get() { return structuredClone(memory); }, async set(value) { writes.push(structuredClone(value)); Object.assign(memory, structuredClone(value)); },
  }}, tabs:{async create(value) { tabs.push(value); if (options.downloadFailure) throw Error('not supported'); }}, runtime:{getManifest:() => ({version:'3.5.3'}), async sendMessage(message) {
    messages.push(structuredClone(message));
    if (options.send) { const custom = await options.send(message); if (custom !== undefined) return custom; }
    if (message.type === 'settings:get') return {paired:Boolean(options.paired),state:null};
    if (message.type === 'profile:refresh') return {ok:false};
    if (message.type === 'translation:settings') return structuredClone(trans);
    if (message.type === 'translation:update') {
      calls.push(message); const {type,apiKey,anthropicApiKey,clearApiKey,clearAnthropicApiKey,...rest} = message;
      trans = {...trans,...rest};
      if (apiKey?.trim()) trans.hasOpenRouterKey = true;
      if (anthropicApiKey?.trim()) trans.hasAnthropicKey = true;
      if (clearApiKey) trans.hasOpenRouterKey = false;
      if (clearAnthropicApiKey) trans.hasAnthropicKey = false;
      return structuredClone(trans);
    }
    if (message.type === 'youtube:settings') return {ok:true,settings:structuredClone(yt)};
    if (message.type === 'youtube:update') { yt = {...yt,...message.patch}; return {ok:true,settings:structuredClone(yt)}; }
    return {ok:true};
  }}};
  w.eval(classification);
  w.LakomicsArcCollector = {mount({container}) { container.replaceChildren(w.document.createElement('div')); return {update() {},close() {}}; }};
  w.eval(terms); w.eval(source); await drain();
  const $ = id => w.document.getElementById(id);
  const fire = (id, type, props = {}) => $(id).dispatchEvent(new w.Event(type, {bubbles:true,cancelable:true,...props}));
  const input = (id, value) => { $(id).value = value; fire(id,'input'); };
  const change = async (id, value) => { if (typeof value === 'boolean') $(id).checked = value; else $(id).value = value; fire(id,'change'); await drain(); };
  return {w,$,advance,messages,writes,tabs,scrolls,observers,calls,memory,fire,input,change,
    external:async (changes) => { onChanged(changes,'local'); await drain(); },
    trans:change => { trans = {...trans,...change}; }, yt:change => { yt = {...yt,...change}; }};
}

test('seven section landmarks keep every mapped id, labels, status slots, fonts and responsive foundations', async t => {
  const f = await fixture(t); const sections = [...f.w.document.querySelectorAll('main > .sec')];
  assert.deepEqual(sections.map(s => s.querySelector('h2').textContent), ['연결','수집','번역 공통','X 번역','YouTube 자막','우클릭 메뉴','저장공간']);
  const ids = 'state-label state-dot pair-section pair-status pair-help pair-form pairing origin refresh disconnect order-section sync-status order-editor hidden-count hidden-empty hidden-folders pin-section pins pin-candidate pin-add preference-section auto-like temporary-section context-menu-section context-menu-status context-menu-enabled context-menu-model context-menu-image-model context-menu-form context-menu-excluded context-menu-help translation-section translation-status translation-model translation-fallback translation-enabled translation-key-form translation-key translation-anthropic-key-form translation-anthropic-key translation-clear youtube-section youtube-status youtube-enabled youtube-model youtube-translate youtube-register youtube-speakers youtube-glossarySonnet youtube-fontScale youtube-position youtube-showOriginal youtube-rolling youtube-clear youtube-clear-server translation-dictionary-section translation-dictionary-form translation-dictionary translation-dictionary-status'.split(' ');
  for (const id of ids) assert.ok(f.$(id), id);
  assert.equal(new Set([...f.w.document.querySelectorAll('[id]')].map(n=>n.id)).size, f.w.document.querySelectorAll('[id]').length);
  for (const s of sections) { assert.equal(s.querySelectorAll('.sec-head output').length,1); assert.equal(s.getAttribute('aria-labelledby'),s.querySelector('h2').id); }
  for (const id of ['translation-model','translation-fallback','translation-enabled']) assert.equal(f.$(id).closest('.sec').id,'x-section');
  for (const id of ['translation-clear','youtube-clear','youtube-clear-server']) assert.equal(f.$(id).closest('.sec').id,'storage-section');
  assert.equal(f.$('sync-status').closest('.sec').id,'collect-section');
  assert.equal(f.$('translation-dictionary-section').closest('.sec').id,'translation-section');
  for (const input of f.w.document.querySelectorAll('input[type=checkbox]')) assert.equal(input.getAttribute('role'),'switch');
  for (const control of f.w.document.querySelectorAll('input,select,textarea')) assert.ok(f.w.document.querySelector(`label[for="${control.id}"]`) || control.hasAttribute('aria-label'), control.id);
  assert.equal(f.$('context-menu-form').querySelector('button'), null); assert.equal(f.$('translation-dictionary-form').querySelector('button'), null);
  assert.match(css, /@font-face[^}]*Pretendard Variable[^}]*PretendardVariable\.woff2[^}]*font-display: swap/s);
  assert.doesNotMatch(css, /SUIT|Barlow|border-left/); assert.match(css, /@media \(min-width:760px\)/);
  assert.match(css, /prefers-color-scheme: dark/); assert.match(css, /pointer:coarse/); assert.match(css,/forced-colors:active/);
  assert.equal(f.$('version').textContent,'3.5.3'); assert.equal(f.$('collect-locked').hidden,false); assert.equal(f.$('youtube-clear-server-row').hidden,true);
});

test('textareas debounce for 800ms, preserve focused text, normalize only on blur and flush on pagehide', async t => {
  const f = await fixture(t); f.$('context-menu-excluded').focus();
  f.input('context-menu-excluded',' Example.COM\nexample.com'); await f.advance(799); assert.equal(f.writes.length,0);
  f.input('context-menu-excluded',' Example.COM\nexample.com\nsub.test'); await f.advance(799); assert.equal(f.writes.length,0);
  await f.advance(1); assert.equal(f.writes.length,1); assert.equal(f.$('context-menu-excluded').value,' Example.COM\nexample.com\nsub.test');
  f.$('context-menu-excluded').blur(); await drain(); assert.equal(f.$('context-menu-excluded').value,'example.com\nsub.test'); assert.equal(f.writes.length,1);
  f.$('translation-dictionary').focus(); f.input('translation-dictionary',' Apple -> 사과 '); await f.advance(800);
  assert.equal(f.calls.at(-1).userTerms[0].source,'Apple'); assert.equal(f.$('translation-dictionary').value,' Apple -> 사과 ');
  f.$('translation-dictionary').blur(); await drain(); assert.equal(f.$('translation-dictionary').value,'Apple = 사과');
  f.input('translation-dictionary','Pear = 배'); f.w.dispatchEvent(new f.w.Event('pagehide')); await drain();
  assert.equal(f.calls.at(-1).userTerms[0].source,'Pear'); await f.advance(800); assert.equal(f.calls.length,2);
});

test('invalid hosts never save, retain line numbers including blanks; dictionary keeps unreadable lines and saves only parsed terms', async t => {
  const f = await fixture(t); f.$('context-menu-excluded').focus(); f.input('context-menu-excluded','ok.test\n\nhttps://bad.test/path');
  await f.advance(800); assert.equal(f.writes.length,0); assert.equal(f.$('context-menu-error').textContent,'');
  f.$('context-menu-excluded').blur(); await drain(); assert.match(f.$('context-menu-error').textContent,/3번째 줄/);
  assert.equal(f.$('context-menu-excluded').getAttribute('aria-invalid'),'true'); assert.equal(f.writes.length,0);
  await f.change('context-menu-enabled',false); assert.deepEqual(f.memory['lakomics:context-menu:v1'].excludedHosts,[]);
  f.$('translation-dictionary').focus(); f.input('translation-dictionary','Apple = 사과\nunreadable'); await f.advance(800);
  assert.equal(f.calls.at(-1).userTerms.length,1); f.$('translation-dictionary').blur(); await drain();
  assert.match(f.$('translation-dictionary-error').textContent,/1줄을 읽지 못/); assert.equal(f.$('translation-dictionary').value,'Apple = 사과\nunreadable');
});

test('visibility hidden and Ctrl+Enter flush without needing a save button', async t => {
  const f = await fixture(t); f.input('context-menu-excluded','hidden.test');
  Object.defineProperty(f.w.document,'visibilityState',{configurable:true,value:'hidden'});
  f.w.document.dispatchEvent(new f.w.Event('visibilitychange')); await drain(); assert.equal(f.writes.length,1);
  f.input('translation-dictionary','Cat = 고양이'); f.$('translation-dictionary').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
  await drain(); assert.equal(f.calls.at(-1).userTerms[0].korean,'고양이');
});

test('save status delays busy 400ms, holds it 600ms, fades success after 2 seconds and failures remain retryable', async t => {
  let resolve, slow = true, fail = false;
  const f = await fixture(t,{send:message => {
    if (message.type !== 'translation:update') return;
    if (slow) return new Promise(r => { resolve = r; });
    if (fail) return {ok:false};
  }});
  await f.change('translation-enabled',false); assert.equal(f.$('x-status').textContent,'');
  await f.advance(399); assert.equal(f.$('x-status').textContent,''); await f.advance(1); assert.equal(f.$('x-status').textContent,'저장 중');
  resolve({ok:true,enabled:false,models,model:models[0].id}); await drain(); await f.advance(599); assert.equal(f.$('x-status').textContent,'저장 중');
  await f.advance(1); assert.match(f.$('x-status').textContent,/저장됨/); await f.advance(1999); assert.equal(f.$('x-status').classList.contains('fade'),false);
  await f.advance(1); assert.equal(f.$('x-status').classList.contains('fade'),true);
  slow = false; fail = true; await f.change('translation-enabled',true); assert.match(f.$('x-status').textContent,/다시 시도/);
  await f.advance(5000); assert.equal(f.$('x-status').classList.contains('fade'),false);
  fail = false; f.$('x-status').querySelector('button').click(); await drain(); assert.match(f.$('x-status').textContent,/저장됨/);
  assert.equal(f.messages.filter(m=>m.type==='translation:update').length,3);
});

test('all destructive actions require confirmation, focus cancel, Esc/outside/idle collapse and failures keep a retry', async t => {
  let fail = false; const f = await fixture(t,{paired:true,send:m => m.type==='translation:clear' && fail ? {ok:false} : undefined});
  const trigger = f.$('translation-clear'), panel = f.$('confirm-translation-clear'); trigger.click();
  assert.equal(f.messages.some(m=>m.type==='translation:clear'),false); assert.equal(f.w.document.activeElement.textContent,'취소');
  assert.equal(trigger.getAttribute('aria-expanded'),'true'); f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(panel.classList.contains('open'),false); assert.equal(f.w.document.activeElement,trigger);
  trigger.click(); f.w.document.body.dispatchEvent(new f.w.Event('pointerdown',{bubbles:true})); assert.equal(panel.classList.contains('open'),false);
  trigger.click(); await f.advance(9999); assert.equal(panel.classList.contains('open'),true); await f.advance(1); assert.equal(panel.classList.contains('open'),false);
  trigger.click(); f.$('youtube-clear').click(); assert.equal(panel.classList.contains('open'),false);
  f.$('confirm-youtube-clear').querySelector('[data-cancel]').click();
  fail = true; trigger.click(); panel.querySelector('[data-commit]').click(); await drain(); assert.equal(panel.classList.contains('open'),true);
  assert.match(panel.querySelector('.confirm-error').textContent,/실패/); assert.equal(panel.querySelector('[data-commit]').textContent,'다시 시도');
  fail = false; panel.querySelector('[data-commit]').click(); await drain(); assert.equal(panel.classList.contains('open'),false);
  for (const [id,type] of [['youtube-clear','youtube:clearCache'],['youtube-clear-server','youtube:clearServerCache'],['disconnect','disconnect']]) {
    const before = f.messages.filter(m=>m.type===type).length; f.$(id).click(); assert.equal(f.messages.filter(m=>m.type===type).length,before);
    f.$('confirm-'+id).querySelector('[data-commit]').click(); await drain(); assert.equal(f.messages.filter(m=>m.type===type).length,before+1);
  }
});

test('empty key saves do nothing; explicit save and confirmed key clear update provider indicators without returning keys', async t => {
  const f = await fixture(t); f.fire('translation-key-form','submit'); await drain(); assert.equal(f.calls.length,0);
  f.input('translation-anthropic-key','new-secret'); f.fire('translation-anthropic-key-form','submit'); await drain();
  assert.equal(f.$('translation-anthropic-key').value,''); assert.equal(f.$('translation-anthropic-key-save').disabled,true);
  assert.match(f.$('translation-anthropic-key-state').textContent,/저장됨/); assert.equal(f.$('nav-key-needed').hidden,true);
  f.$('translation-anthropic-key-clear').click(); assert.equal(f.calls.length,1);
  f.$('confirm-translation-anthropic-key-clear').querySelector('[data-commit]').click(); await drain();
  assert.equal(f.calls.at(-1).anthropicApiKey,''); assert.equal(f.calls.at(-1).clearAnthropicApiKey,true);
  assert.match(f.$('translation-anthropic-key-state').textContent,/없음/); assert.equal(f.$('translation-anthropic-key-clear').hidden,true); assert.equal(f.$('nav-key-needed').hidden,false);
});

test('provider groups and links follow model choices in both directions, including inherited context model and enabled features', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.$('translation-model').querySelectorAll('optgroup')].map(n=>n.label),['OpenRouter','Anthropic']);
  assert.match(f.$('translation-model').options[1].textContent,/키 필요/); assert.match(f.$('translation-anthropic-key-uses').textContent,/필요:.*이미지 글자 번역.*YouTube/);
  assert.equal(f.$('context-menu-model').options[0].textContent,'X 번역과 같게 (Flash)');
  f.$('context-menu-image-model-key-meta').querySelector('button').click(); assert.equal(f.w.document.activeElement.id,'translation-anthropic-key');
  await f.change('translation-model',models[1].id); assert.match(f.$('translation-enabled-key-meta').textContent,/API 키 필요/);
  assert.match(f.$('context-menu-model-key-meta').textContent,/API 키 필요/); assert.match(f.$('translation-anthropic-key-uses').textContent,/X 번역/);
  await f.change('translation-enabled',false); await f.change('youtube-enabled',false); await f.change('context-menu-enabled',false);
  assert.equal(f.$('nav-key-needed').hidden,true);
});

test('jump list scrolls/focuses without hash writes, deep link focuses missing key then removes its hash, scroll spy observes all sections', async t => {
  const f = await fixture(t,{hash:'#translation-section',reduce:true}); assert.equal(f.w.location.hash,''); assert.equal(f.w.document.activeElement.id,'translation-anthropic-key');
  const link = f.w.document.querySelector('a[href="#youtube-section"]'); link.click();
  assert.equal(f.w.location.hash,''); assert.equal(f.w.document.activeElement.id,'youtube-section-heading'); assert.equal(f.scrolls.at(-1).behavior,'auto');
  assert.equal(link.getAttribute('aria-current'),'location'); assert.equal(f.observers[0].nodes.length,7); assert.equal(f.observers[0].opts.rootMargin,'-16px 0px -70% 0px');
});

test('download settings uses Chrome tab API and quietly hides unsupported action; preview reflects all display settings', async t => {
  const f = await fixture(t); f.$('download-settings').click(); await drain(); assert.equal(f.tabs[0].url,'chrome://settings/downloads');
  await f.change('youtube-fontScale','1.3'); await f.change('youtube-position','raised'); await f.change('youtube-showOriginal',true);
  assert.equal(f.$('youtube-preview').style.getPropertyValue('--fs'),'1.3'); assert.equal(f.$('youtube-preview').classList.contains('raised'),true);
  assert.equal(f.$('youtube-preview').querySelector('small').hidden,false);
  assert.equal(f.$('youtube-rolling').checked,true); assert.equal(f.$('youtube-preview').querySelector('em').hidden,false);
  await f.change('youtube-rolling',false); assert.equal(f.$('youtube-preview').querySelector('em').hidden,true); assert.deepEqual(f.messages.filter(m => m.type === 'youtube:update').at(-1).patch,{rolling:false});
  const g = await fixture(t,{downloadFailure:true}); g.$('download-settings').click(); await drain(); assert.equal(g.$('download-settings').hidden,true);
});

test('external storage changes refresh settings without overwriting a focused or dirty textarea', async t => {
  const f = await fixture(t); f.$('translation-dictionary').focus(); f.input('translation-dictionary','unsaved text');
  f.trans({enabled:false,userTerms:[{source:'external',korean:'외부'}]}); await f.external({'lakomics:translation:v1':{newValue:{apiKey:'never render'}}});
  assert.equal(f.$('translation-enabled').checked,false); assert.equal(f.$('translation-dictionary').value,'unsaved text'); assert.equal(f.w.document.body.textContent.includes('never render'),false);
  f.memory['lakomics:context-menu:v1']={enabled:false,excludedHosts:['external.test']}; await f.external({'lakomics:context-menu:v1':{newValue:f.memory['lakomics:context-menu:v1']}});
  assert.equal(f.$('context-menu-enabled').checked,false); assert.equal(f.$('context-menu-excluded').value,'external.test');
  f.yt({position:'raised',fontScale:1.15,showOriginal:true}); await f.external({'lakomics:youtube:settings:position':{newValue:'raised'}});
  assert.equal(f.$('youtube-preview').classList.contains('raised'),true); assert.equal(f.$('youtube-preview').style.getPropertyValue('--fs'),'1.15');
});

test('help is click-only, closes outside or on Escape with focus return', async t => {
  const f = await fixture(t), button = f.w.document.querySelector('[data-help="help-context-menu-model"]'), panel = f.$('help-context-menu-model');
  button.dispatchEvent(new f.w.Event('mouseover')); assert.equal(panel.hidden,true); button.click(); assert.equal(panel.hidden,false); assert.equal(button.getAttribute('aria-expanded'),'true');
  f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape'})); assert.equal(panel.hidden,true); assert.equal(f.w.document.activeElement,button);
  button.click(); f.w.document.body.dispatchEvent(new f.w.Event('pointerdown',{bubbles:true})); assert.equal(panel.hidden,true);
});


test('rapid changes keep the newest switch and preview values while older saves finish, and a visible busy label never blinks', async t => {
  const pending = [];
  const f = await fixture(t,{send:m => {
    if (m.type === 'translation:update' || m.type === 'youtube:update') return new Promise(resolve => pending.push({m,resolve}));
  }});
  await f.change('translation-enabled',false); await f.advance(400);
  assert.equal(f.$('x-status').textContent,'저장 중');
  await f.change('translation-enabled',true); assert.equal(f.$('x-status').textContent,'저장 중');
  pending[0].resolve({ok:true,enabled:false}); await drain();
  assert.equal(f.$('translation-enabled').checked,true); assert.equal(f.$('x-status').textContent,'저장 중');
  pending[1].resolve({ok:true,enabled:true}); await drain(); await f.advance(599);
  assert.equal(f.$('x-status').textContent,'저장 중'); await f.advance(1); assert.match(f.$('x-status').textContent,/저장됨/);
  await f.change('youtube-fontScale','1.15'); await f.change('youtube-position','raised');
  pending[2].resolve({ok:true,settings:{fontScale:1.15,position:'default'}}); await drain();
  assert.equal(f.$('youtube-position').value,'raised'); assert.equal(f.$('youtube-preview').classList.contains('raised'),true);
  pending[3].resolve({ok:true,settings:{fontScale:1.15,position:'raised'}}); await drain();
});

test('failed textarea saves retain edits, retry persists the value, and later flushes do not resend it', async t => {
  let fail = true;
  const f = await fixture(t,{send:m => m.type==='translation:update' && fail ? {ok:false} : undefined});
  f.input('translation-dictionary','Cat = 고양이'); await f.advance(800);
  assert.match(f.$('translation-status').textContent,/다시 시도/); assert.equal(f.$('translation-dictionary').value,'Cat = 고양이');
  fail = false; f.$('translation-status').querySelector('button').click(); await drain();
  const count = f.messages.filter(m=>m.type==='translation:update').length;
  f.w.dispatchEvent(new f.w.Event('pagehide')); await drain();
  assert.equal(f.messages.filter(m=>m.type==='translation:update').length,count);
  assert.match(f.$('translation-status').textContent,/저장됨/);
});

test('slow initial replies reveal by 300ms without a permanent blank main', async t => {
  let resolve;
  const f = await fixture(t,{send:m => m.type==='translation:settings' ? new Promise(r=>{resolve=r;}) : undefined});
  assert.equal(f.w.document.body.classList.contains('ready'),false); await f.advance(299); assert.equal(f.w.document.body.classList.contains('ready'),false);
  await f.advance(1); assert.equal(f.w.document.body.classList.contains('ready'),true);
  resolve({ok:true,models,model:models[0].id}); await drain();
  assert.equal(f.$('translation-model').options.length,2);
});


test('rapid collection edits retain both pins and both restored folders; auto-like keeps the latest value', async t => {
  let state = {classifications:{entries:[{id:'a',name:'A',parentId:null},{id:'b',name:'B',parentId:null}]},
    profile:{pinnedClassificationIds:[],listOrder:{},preferences:{autoLikeOnSave:true}}, hiddenClassificationIds:[]};
  const pending = [];
  const f = await fixture(t,{paired:true,send:m => {
    if (m.type === 'settings:get' || m.type === 'profile:refresh') return {ok:true,paired:true,state:structuredClone(state)};
    if (m.type === 'profile:patch' || m.type === 'arc:hidden') return new Promise(resolve => pending.push({m,resolve}));
  }});
  const finish = async index => {
    const {m,resolve} = pending[index];
    if (m.patch) state.profile = {...state.profile,...m.patch,preferences:{...state.profile.preferences,...m.patch.preferences}};
    if (m.ids) state.hiddenClassificationIds = m.ids;
    resolve({ok:true,state:structuredClone(state)}); await drain();
  };
  f.$('pin-candidate').value = 'a'; f.$('pin-add').click(); await drain();
  f.$('pin-candidate').value = 'b'; f.$('pin-add').click(); await drain();
  await finish(0); assert.deepEqual(Array.from(pending[1].m.patch.pinnedClassificationIds),['a','b']); await finish(1);
  assert.equal(f.$('pins').children.length,2);
  state.hiddenClassificationIds = ['a','b']; f.$('refresh').click(); await drain();
  const restores = [...f.$('hidden-folders').querySelectorAll('button')]; restores[0].click(); restores[1].click(); await drain();
  await finish(2); assert.deepEqual(Array.from(pending[3].m.ids),[]); await finish(3); assert.equal(f.$('hidden-folders').children.length,0);
  await f.change('auto-like',false); await f.change('auto-like',true); await finish(4);
  assert.equal(f.$('auto-like').checked,true); await finish(5); assert.equal(state.profile.preferences.autoLikeOnSave,true);
});
