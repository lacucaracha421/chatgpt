import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../../_tools/app/node_modules/jsdom/lib/api.js';
const service = await readFile(new URL('../src/translate-service.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../src/x-translate.js', import.meta.url), 'utf8');
function fixture(initial={}, fetcher) {
  const memory = structuredClone(initial), calls = [];
  const context = vm.createContext({ AbortController, setTimeout, clearTimeout,
    chrome:{storage:{local:{async get(){return structuredClone(memory);},async set(v){Object.assign(memory,structuredClone(v));},async remove(keys){keys.forEach(k=>delete memory[k]);}}}},
    fetch:async(url,init)=>{calls.push({url,init}); return fetcher ? fetcher(url,init) : {ok:true,json:async()=>({choices:[{message:{content:'안녕하세요 [[LINK_0]]'}}]})};},
  });
  vm.runInContext(service,context);
  return {memory,calls,handle:message=>context.LakomicsTranslation.handle(message)};
}
const legacy = {'xtranslate:gm:oit.settings.v2':{provider:'ollama',openrouterApiKey:'fixture-key',ollamaApiKey:'retired',autoTranslate:true},'xtranslate:gm:oit.cache.v2':{old:'cache'}};

test('migration preserves OpenRouter key and automatic preference, removes retired settings without exposing keys',async()=>{
  const f=fixture(legacy); const settings=await f.handle({type:'translation:settings'});
  assert.equal(settings.hasApiKey,true); assert.equal(settings.enabled,true); assert.equal(settings.apiKey,undefined);
  assert.equal(f.memory['lakomics:translation:v1'].apiKey,'fixture-key'); assert.equal(Object.keys(f.memory).some(k=>k.startsWith('xtranslate:gm:')),false);
});

test('requests use only Flash Lite, cache repeats and clear cached results',async()=>{
  const f=fixture(legacy); const request={type:'translation:request',text:'Hello [[LINK_0]]'};
  assert.equal((await f.handle(request)).ok,true); await f.handle(request); assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(JSON.parse(f.calls[0].init.body).model,'google/gemini-2.5-flash-lite');
  await f.handle({type:'translation:clear'}); await f.handle(request); assert.equal(f.calls.length,2);
  await f.handle({type:'translation:update',enabled:false}); assert.equal((await f.handle(request)).code,'disabled'); assert.equal(f.calls.length,2);
});

test('off or cache clear rejects in-flight results without repopulating the cache',async()=>{
  for(const message of [{type:'translation:clear'},{type:'translation:update',enabled:false}]) {
    let finish, started;
    const ready=new Promise(r=>started=r);
    const f=fixture(legacy,async()=>{started(); return new Promise(r=>finish=r);});
    const pending=f.handle({type:'translation:request',text:'Hello'}); await ready; await f.handle(message);
    finish({ok:true,json:async()=>({choices:[{message:{content:'안녕하세요'}}]})});
    assert.equal((await pending).code,'disabled'); assert.deepEqual(f.memory['lakomics:translation-cache:v1']||[],[]);
  }
});

test('bad placeholder output is rejected rather than cached',async()=>{
  const f=fixture(legacy,async()=>({ok:true,json:async()=>({choices:[{message:{content:'링크 없음'}}]})}));
  assert.equal((await f.handle({type:'translation:request',text:'Hello [[LINK_0]]'})).code,'invalid_translation');
});

test('source snapshots preserve emoji, line breaks and safe clickable links without rendering model HTML',()=>{
  const dom=new JSDOM('<div data-testid="tweetText" lang="en">Hello<br><img alt="😀"><a href="https://x.com/hashtag/test">#test</a></div>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window; w.__LAKOMICS_TEST__=true; w.IntersectionObserver=class{}; w.eval(content);
  const api=w.LakomicsTranslateContent, element=w.document.querySelector('div'), snapshot=api.source(element);
  assert.equal(snapshot.text,'Hello\n😀[[LINK_0]]'); assert.equal(api.needsTranslation(element,snapshot.text),true);
  api.render(element,snapshot,'<script>bad</script> 안녕하세요 [[LINK_0]]');
  assert.equal(w.document.querySelector('script'),null); assert.equal(w.document.querySelector('.lakomics-translation a').href,'https://x.com/hashtag/test');
  element.lang='ko'; assert.equal(api.needsTranslation(element,'한국어 게시물'),false); w.close();
});

test('mounted translator handles initial scan, recycled tweet text, off and on without stale results', async () => {
  const dom = new JSDOM('<div data-testid="tweetText" lang="en">Hello world</div>', {url:'https://x.com', runScripts:'outside-only'});
  const w = dom.window, element = w.document.querySelector('div');
  let enabled = true, changed, requests = 0;
  element.getBoundingClientRect = () => ({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  w.chrome = {runtime:{sendMessage(message, callback) {
    if (message.type === 'translation:settings') callback({ok:true,enabled,hasApiKey:true});
    if (message.type === 'translation:request') { requests++; callback({ok:true,text:message.text.includes('Changed')?'변경된 글':'안녕하세요'}); }
  }}, storage:{onChanged:{addListener(fn) { changed=fn; }}}};
  w.eval(content);
  const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
  await wait(400); assert.equal(w.document.querySelector('.lakomics-translation').textContent,'안녕하세요');
  element.textContent='Changed post'; await wait(500);
  assert.equal(w.document.querySelector('.lakomics-translation').textContent,'변경된 글');
  enabled=false; changed({'lakomics:translation:v1':{newValue:{enabled:false}}},'local'); await wait(400);
  assert.equal(w.document.querySelector('.lakomics-translation'),null); assert.equal(requests,2);
  enabled=true; changed({'lakomics:translation:v1':{newValue:{enabled:true}}},'local'); await wait(400);
  assert.equal(w.document.querySelector('.lakomics-translation').textContent,'변경된 글'); assert.equal(requests,3); w.close();
});
