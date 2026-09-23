import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../../_tools/app/node_modules/jsdom/lib/api.js';
const service = await readFile(new URL('../src/translate-service.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../src/x-translate.js', import.meta.url), 'utf8');
function fakeTimers(w) {
  let now = 0, nextId = 0;
  const timers = new Map();
  w.Date.now = () => now;
  w.setTimeout = (callback, delay = 0, ...args) => {
    const id = ++nextId;
    timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback, args });
    return id;
  };
  w.clearTimeout = id => timers.delete(id);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await flush();
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback(...next[1].args);
    }
    now = end; await flush();
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      timers.delete(next[0]); next[1].callback(...next[1].args); await flush();
    }
  }
  return { advance };
}
function translationWindow(html, handleMessage) {
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window;
  const listeners=[];
  // The background answers an update and then announces it through storage.onChanged, which
  // is how the content script learns the new settings; that path is exercised here too.
  w.chrome={runtime:{sendMessage(message,callback){
    const result=handleMessage(message);
    if(message.type==='translation:update') for(const fn of listeners) fn({'lakomics:translation:v1':{newValue:{enabled:result.enabled}}},'local');
    callback(result);
  }},storage:{onChanged:{addListener(fn){listeners.push(fn);}}}};
  return w;
}
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
  const f=fixture({...legacy,'lakomics:translation-cache:v1':[['Hello','옛 번역']]}); const settings=await f.handle({type:'translation:settings'});
  assert.equal(settings.hasApiKey,true); assert.equal(settings.enabled,true); assert.equal(settings.apiKey,undefined);
  assert.equal(f.memory['lakomics:translation:v1'].apiKey,'fixture-key'); assert.equal(Object.keys(f.memory).some(k=>k.startsWith('xtranslate:gm:')),false);
  assert.equal(f.memory['lakomics:translation-cache:v1'],undefined); assert.deepEqual(f.memory['lakomics:translation-cache:v2']||[],[]);
});

test('requests use only Flash Lite, cache repeats and clear cached results',async()=>{
  const f=fixture(legacy); const request={type:'translation:request',text:'Hello [[LINK_0]]'};
  assert.equal((await f.handle(request)).ok,true); await f.handle(request); assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(JSON.parse(f.calls[0].init.body).model,'google/gemini-3.1-flash-lite');
  await f.handle({type:'translation:clear'}); await f.handle(request); assert.equal(f.calls.length,2);
  await f.handle({type:'translation:update',enabled:false}); assert.equal((await f.handle(request)).code,'disabled'); assert.equal(f.calls.length,2);
});

test('selected translation model persists, clears incompatible cache and is used for later requests',async()=>{
  const f=fixture(legacy); const request={type:'translation:request',text:'Hello [[LINK_0]]'};
  assert.equal((await f.handle(request)).ok,true);
  const changed=await f.handle({type:'translation:update',model:'google/gemma-4-26b-a4b-it'});
  assert.equal(changed.model,'google/gemma-4-26b-a4b-it'); assert.equal(changed.modelLabel,'Gemma 4 26B A4B');
  assert.equal(f.memory['lakomics:translation:v1'].model,'google/gemma-4-26b-a4b-it');
  assert.deepEqual(f.memory['lakomics:translation-cache:v2']||[],[]);
  assert.equal((await f.handle(request)).ok,true); assert.equal(f.calls.length,2);
  assert.equal(JSON.parse(f.calls[1].init.body).model,'google/gemma-4-26b-a4b-it');
});

test('unsupported translation model is rejected without changing the current model',async()=>{
  const f=fixture(legacy);
  const before=await f.handle({type:'translation:settings'});
  const result=await f.handle({type:'translation:update',model:'vendor/not-a-model'});
  assert.equal(result.ok,false); assert.equal(result.code,'invalid_model');
  const after=await f.handle({type:'translation:settings'}); assert.equal(after.model,before.model);
});

test('off or cache clear rejects in-flight results without repopulating the cache',async()=>{
  for(const message of [{type:'translation:clear'},{type:'translation:update',enabled:false}]) {
    let finish, started;
    const ready=new Promise(r=>started=r);
    const f=fixture(legacy,async()=>{started(); return new Promise(r=>finish=r);});
    const pending=f.handle({type:'translation:request',text:'Hello'}); await ready; await f.handle(message);
    finish({ok:true,json:async()=>({choices:[{message:{content:'안녕하세요'}}]})});
    assert.equal((await pending).code,'disabled'); assert.deepEqual(f.memory['lakomics:translation-cache:v2']||[],[]);
  }
});

test('duplicated or unknown placeholders are rejected rather than cached',async()=>{
  for(const content of ['안녕 [[LINK_0]] [[LINK_0]]','안녕 [[LINK_1]]']){
    const f=fixture(legacy,async()=>({ok:true,json:async()=>({choices:[{message:{content}}]})}));
    assert.equal((await f.handle({type:'translation:request',text:'Hello [[LINK_0]]'})).code,'invalid_translation');
    assert.deepEqual(f.memory['lakomics:translation-cache:v2']||[],[]);
  }
});

test('a dropped placeholder is accepted so the page can re-attach the link',async()=>{
  const f=fixture(legacy,async()=>({ok:true,json:async()=>({choices:[{message:{content:'링크 없음'}}]})}));
  const result=await f.handle({type:'translation:request',text:'Hello [[LINK_0]]'});
  assert.equal(result.ok,true); assert.equal(result.text,'링크 없음');
});

test('output without Korean is a silent no-translation result, cached, while untranslated Kana stays invalid',async()=>{
  const f=fixture(legacy,async()=>({ok:true,json:async()=>({choices:[{message:{content:'Blue Archive www'}}]})}));
  const first=await f.handle({type:'translation:request',text:'Blue Archive www'});
  assert.equal(first.ok,true); assert.equal(first.text,null); assert.equal(first.untranslated,true);
  const again=await f.handle({type:'translation:request',text:'Blue Archive www'});
  assert.equal(again.text,null); assert.equal(f.calls.length,1);
  const kana=fixture(legacy,async()=>({ok:true,json:async()=>({choices:[{message:{content:'ブルアカ最高'}}]})}));
  assert.equal((await kana.handle({type:'translation:request',text:'ブルアカ最高'})).code,'invalid_translation');
});

test('single and batch requests time out at 12 and 18 seconds',async()=>{
  const delays=[], memory=structuredClone(legacy);
  const context=vm.createContext({ AbortController, clearTimeout,
    setTimeout:(callback,delay)=>{ delays.push(delay); return setTimeout(callback,delay>=12000?0:delay); },
    chrome:{storage:{local:{async get(){return structuredClone(memory);},async set(v){Object.assign(memory,structuredClone(v));},async remove(){}}}},
    fetch:(url,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')))),
  });
  vm.runInContext(service,context);
  assert.equal((await context.LakomicsTranslation.handle({type:'translation:request',text:'Slow post'})).code,'timeout');
  assert.equal((await context.LakomicsTranslation.handle({type:'translation:request-batch',items:[{id:'1',text:'Slow a'},{id:'2',text:'Slow b'}]})).code,'timeout');
  assert.deepEqual(delays.filter(delay=>delay>=12000),[12000,12000,18000,18000]);
});

test('Gemini 3.5 Flash Lite is offered while 3.1 Flash Lite stays the default',async()=>{
  const f=fixture({});
  const settings=await f.handle({type:'translation:settings'});
  assert.equal(settings.model,'google/gemini-3.1-flash-lite');
  assert.ok(settings.models.some(model=>model.id==='google/gemini-3.5-flash-lite'&&model.label==='Gemini 3.5 Flash Lite'));
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
  const w = dom.window, element = w.document.querySelector('div'), clock = fakeTimers(dom.window);
  let enabled = true, changed, requests = 0;
  element.getBoundingClientRect = () => ({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  w.chrome = {runtime:{sendMessage(message, callback) {
    if(message.type==='translation:settings') callback({ok:true,enabled,hasApiKey:true});
    if(message.type==='translation:request') { requests++; callback({ok:true,text:message.text.includes('Changed')?'변경된 글':'안녕하세요'}); return; }
    if(message.type==='translation:request-batch') { requests++; callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:item.text.includes('Changed')?'변경된 글':'안녕하세요'}))}); }
  }}, storage:{onChanged:{addListener(fn) { changed=fn; }}}};
  w.eval(content); await clock.advance(400); assert.equal(w.document.querySelector('.lakomics-translation').textContent,'안녕하세요');
  element.textContent='Changed post'; await clock.advance(500);
  assert.equal(w.document.querySelector('.lakomics-translation').textContent,'변경된 글');
  enabled=false; changed({'lakomics:translation:v1':{newValue:{enabled:false}}},'local'); await clock.advance(400);
  assert.equal(w.document.querySelector('.lakomics-translation'),null); assert.equal(requests,2);
  enabled=true; changed({'lakomics:translation:v1':{newValue:{enabled:true}}},'local'); await clock.advance(400);
  assert.equal(w.document.querySelector('.lakomics-translation').textContent,'변경된 글'); assert.equal(requests,3); w.close();
});

test('batch request translates four items in one structured OpenRouter call',async()=>{
  const f=fixture(legacy,async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({translations:[
    {id:'a',text:'안녕 [[LINK_0]]'}, {id:'b',text:'좋은 아침'}, {id:'c',text:'반가워요'}, {id:'d',text:'잘 자요'}
  ]})}}]})}));
  const result=await f.handle({type:'translation:request-batch',items:[
    {id:'a',text:'Hello [[LINK_0]]'}, {id:'b',text:'Good morning'}, {id:'c',text:'Nice to meet you'}, {id:'d',text:'Good night'}
  ]});
  assert.equal(result.ok,true); assert.equal(result.items.length,4); assert.equal(result.items[0].text,'안녕 [[LINK_0]]');
  assert.equal(f.calls.length,1);
  const body=JSON.parse(f.calls[0].init.body);
  assert.equal(body.model,'google/gemini-3.1-flash-lite'); assert.equal(body.response_format.type,'json_schema'); assert.equal(body.provider.require_parameters,true);
});

test('placeholder validation accepts reordered links',async()=>{
  const f=fixture(legacy,async()=>({ok:true,json:async()=>({choices:[{message:{content:'안녕 [[LINK_1]] 그리고 [[LINK_0]]'}}]})}));
  const result=await f.handle({type:'translation:request',text:'Hello [[LINK_0]] and [[LINK_1]]'});
  assert.equal(result.ok,true); assert.equal(result.text,'안녕 [[LINK_1]] 그리고 [[LINK_0]]');
});

test('background scheduler allows two translations in flight',async()=>{
  let active=0,maxActive=0; const releases=[];
  const f=fixture(legacy,async()=>{
    active+=1; maxActive=Math.max(maxActive,active);
    return new Promise(resolve=>releases.push(()=>{active-=1; resolve({ok:true,json:async()=>({choices:[{message:{content:'번역됨'}}]})});}));
  });
  const jobs=['One','Two','Three'].map(text=>f.handle({type:'translation:request',text}));
  await new Promise(resolve=>setTimeout(resolve,20)); assert.equal(maxActive,2);
  releases.shift()(); await new Promise(resolve=>setTimeout(resolve,20)); assert.equal(maxActive,2);
  while(releases.length) releases.shift()();
  await Promise.all(jobs); assert.equal(f.calls.length,3);
});

test('transient server failure retries once before succeeding',async()=>{
  let attempts=0;
  const f=fixture(legacy,async()=>++attempts===1
    ? {ok:false,status:500,headers:{get(){return null;}}}
    : {ok:true,json:async()=>({choices:[{message:{content:'재시도 성공'}}]})});
  const result=await f.handle({type:'translation:request',text:'Retry me'});
  assert.equal(result.ok,true); assert.equal(result.text,'재시도 성공'); assert.equal(attempts,2);
});

test('language detection trusts explicit tags but skips tiny foreign snippets',()=>{
  const dom=new JSDOM('<div data-testid="tweetText">text</div>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window; w.__LAKOMICS_TEST__=true; w.IntersectionObserver=class{}; w.eval(content);
  const api=w.LakomicsTranslateContent, element=w.document.querySelector('div');
  element.lang='ko'; assert.equal(api.needsTranslation(element,'한국어 게시물'),false);
  element.lang='en'; assert.equal(api.needsTranslation(element,'OK'),false); assert.equal(api.needsTranslation(element,'Hello world'),true);
  element.lang='ja'; assert.equal(api.needsTranslation(element,'猫が好き'),true);
  element.lang='und'; assert.equal(api.needsTranslation(element,'한국어 문장입니다'),false); assert.equal(api.needsTranslation(element,'mostly English words'),true);
  w.close();
});

test('visible tweets use one fast lane request and keep the remainder in a four-item batch',async()=>{
  const html=Array.from({length:5},(_,i)=>`<div data-testid="tweetText" lang="en">Post number ${i} text</div>`).join('');
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window, clock=fakeTimers(dom.window);
  const batches=[]; let singles=0;
  for(const [i,el] of [...w.document.querySelectorAll('[data-testid="tweetText"]')].entries()) el.getBoundingClientRect=()=>({width:300,height:40,top:10+i*50,bottom:50+i*50});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){singles+=1; callback({ok:true,text:'빠른 번역'});}
    else if(message.type==='translation:request-batch'){batches.push(message.items.length); callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:`번역 ${item.id}`}))});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(120);
  assert.equal(singles,1); assert.deepEqual(batches,[4]); assert.equal(w.document.querySelectorAll('.lakomics-translation').length,5); w.close();
});

test('rate limit header parsing falls back to the default unless the header states a value',()=>{
  const cases=[null,'','   ','soon','-1'];
  return Promise.all(cases.map(header=>{
    const f=fixture(legacy,async()=>({ok:false,status:429,headers:{get(name){return name.toLowerCase()==='retry-after'?header:null;}}}));
    return f.handle({type:'translation:request',text:'Rate limited'}).then(result=>{
      assert.equal(result.code,'http_429',`${JSON.stringify(header)} must stay a rate limit`);
      assert.equal(result.retryAfterMs,1500,`${JSON.stringify(header)} must use the default wait`);
    });
  }));
});

test('an explicit Retry-After of zero is honored instead of the default wait',async()=>{
  const f=fixture(legacy,async()=>({ok:false,status:429,headers:{get(name){return name.toLowerCase()==='retry-after'?'0':null;}}}));
  const result=await f.handle({type:'translation:request',text:'Rate limited'});
  assert.equal(result.code,'http_429'); assert.equal(result.retryAfterMs,0);
});

test('an HTTP-date Retry-After is converted to a bounded wait',async()=>{
  const f=fixture(legacy,async()=>({ok:false,status:429,headers:{get(name){return name.toLowerCase()==='retry-after'?new Date(Date.now()+4000).toUTCString():null;}}}));
  const result=await f.handle({type:'translation:request',text:'Rate limited'});
  assert.equal(result.code,'http_429'); assert.ok(result.retryAfterMs>0&&result.retryAfterMs<=4000,`wait was ${result.retryAfterMs}`);
});

test('a persistent rate limit stops after the documented retries instead of looping',async()=>{
  let attempts=0;
  const f=fixture(legacy,async()=>{attempts+=1; return {ok:false,status:429,headers:{get(){return '0';}}};});
  const results=await Promise.all([f.handle({type:'translation:request',text:'One'}),
    f.handle({type:'translation:request',text:'Two'})]);
  assert.ok(results.every(result=>result.ok===false&&result.code==='http_429'));
  // One attempt plus the single bounded retry the service is allowed to make.
  assert.equal(attempts,4,'a persistent rate limit is retried once per request and then gives up');
});

const contentSettingsKey=(()=>{
  const match=/const SETTINGS = "([^"]+)"/.exec(content);
  return match?match[1]:null;
})();
const serviceSettingsKey=(()=>{
  const match=/const SETTINGS = "([^"]+)"/.exec(service);
  return match?match[1]:null;
})();

test('content script and service worker agree on the lakomics:translation:v1 settings key',()=>{
  assert.equal(contentSettingsKey,'lakomics:translation:v1');
  assert.equal(serviceSettingsKey,'lakomics:translation:v1');
  assert.equal(serviceSettingsKey,contentSettingsKey,'both clients must share one storage key');
});

test('language detection translates short Han and Kana posts but still skips noise',()=>{
  const dom=new JSDOM('<div data-testid="tweetText">text</div>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window; w.__LAKOMICS_TEST__=true; w.IntersectionObserver=class{}; w.eval(content);
  const api=w.LakomicsTranslateContent, element=w.document.querySelector('div');
  element.lang='ja'; assert.equal(api.needsTranslation(element,'最高'),true);
  element.lang='zh'; assert.equal(api.needsTranslation(element,'谢谢'),true);
  element.lang='en'; assert.equal(api.needsTranslation(element,'OK'),false); assert.equal(api.needsTranslation(element,'AI'),false);
  element.lang='und'; assert.equal(api.needsTranslation(element,'好'),true); assert.equal(api.needsTranslation(element,'한'),false);
  assert.equal(api.needsTranslation(element,'a'),false); assert.equal(api.needsTranslation(element,'한국어'),false); w.close();
});

test('a transient content failure is retried on viewport re-entry but not on unrelated DOM changes',async()=>{
  let requests=0, succeed=false;
  const w=translationWindow('<div data-testid="tweetText" lang="en">Retry this post</div>',message=>{
    if(message.type==='translation:settings') return {ok:true,enabled:true,hasApiKey:true};
    requests+=1;
    if(!succeed) return {ok:false,code:'network_error'};
    return {ok:true,text:'재시도 성공',items:(message.items||[]).map(item=>({id:item.id,ok:true,text:'재시도 성공'}))};
  });
  const element=w.document.querySelector('div'), clock=fakeTimers(w); let observer;
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{constructor(cb){observer={cb};} observe(){} unobserve(){}};
  w.eval(content); await clock.advance(600);
  assert.equal(requests,1); assert.ok(w.document.querySelector('.lakomics-translation').dataset.error==='true');
  // Unrelated DOM churn alone must not re-offer the unchanged failing post.
  for(let round=0;round<4;round+=1){
    w.document.body.append(w.document.createElement('div'));
    await clock.advance(600);
  }
  assert.equal(requests,1,'an unrelated DOM change must not retry an unchanged failed post');
  succeed=true;
  observer.cb([{isIntersecting:false,target:element}]);
  observer.cb([{isIntersecting:true,target:element}]);
  await clock.advance(600);
  assert.equal(requests,2); assert.equal(w.document.querySelector('.lakomics-translation').textContent,'재시도 성공'); w.close();
});

test('repeated unrelated DOM changes cause zero retries of an unchanged failed post',async()=>{
  let requests=0;
  const w=translationWindow('<div data-testid="tweetText" lang="en">Broken post</div>',message=>{
    if(message.type==='translation:settings') return {ok:true,enabled:true,hasApiKey:true};
    requests+=1;
    return {ok:false,code:'invalid_translation'};
  });
  const element=w.document.querySelector('div'), clock=fakeTimers(w);
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.eval(content); await clock.advance(600);
  assert.equal(requests,1); assert.equal(w.document.querySelector('.lakomics-translation').dataset.error,'true');
  for(let round=0;round<5;round+=1){
    w.document.body.append(w.document.createElement('div'));
    w.document.body.append(w.document.createElement('span'));
    await clock.advance(600);
  }
  assert.equal(requests,1,'unrelated DOM changes must not re-run an unchanged failed post');
  assert.equal(w.document.querySelector('.lakomics-translation').dataset.error,'true');
  assert.equal(w.document.querySelector('.lakomics-translation').textContent,'번역 실패 · 다시 보이면 재시도'); w.close();
});

test('a post edited after a failure is translated again with a fresh attempt',async()=>{
  let requests=0, succeed=false;
  const w=translationWindow('<div data-testid="tweetText" lang="en">Broken post</div>',message=>{
    if(message.type==='translation:settings') return {ok:true,enabled:true,hasApiKey:true};
    requests+=1;
    if(!succeed) return {ok:false,code:'invalid_translation'};
    return {ok:true,text:'고친 번역',items:(message.items||[]).map(item=>({id:item.id,ok:true,text:'고친 번역'}))};
  });
  const element=w.document.querySelector('div'), clock=fakeTimers(w);
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.eval(content); await clock.advance(600);
  assert.equal(requests,1); assert.equal(w.document.querySelector('.lakomics-translation').dataset.error,'true');
  w.document.body.append(w.document.createElement('div')); await clock.advance(600);
  assert.equal(requests,1,'unchanged content must stay parked');
  succeed=true; element.textContent='Fixed post text'; await clock.advance(600);
  assert.equal(requests,2);
  assert.equal(w.document.querySelector('.lakomics-translation').dataset.error,'false');
  assert.equal(w.document.querySelector('.lakomics-translation').textContent,'고친 번역'); w.close();
});

test('re-enabling automatic translation resets failure state and translates once',async()=>{
  let enabled=true, succeed=false, requests=0;
  const w=translationWindow('<div data-testid="tweetText" lang="en">Broken post</div>',message=>{
    if(message.type==='translation:settings') return {ok:true,enabled,hasApiKey:true};
    if(message.type==='translation:update'){ enabled=message.enabled; return {ok:true,enabled,hasApiKey:true}; }
    requests+=1;
    if(!succeed) return {ok:false,code:'invalid_translation'};
    return {ok:true,text:'복구 번역',items:(message.items||[]).map(item=>({id:item.id,ok:true,text:'복구 번역'}))};
  });
  const element=w.document.querySelector('div'), clock=fakeTimers(w);
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{observe(){} unobserve(){}};

  w.eval(content); await clock.advance(600);
  assert.equal(requests,1); assert.ok(w.document.querySelector('.lakomics-translation').dataset.error==='true');
  succeed=true;
  const toggle=w.document.getElementById('lakomics-translation-controls').shadowRoot.getElementById('auto');
  toggle.checked=false; await toggle.onchange(); await clock.advance(600);
  assert.equal(w.document.querySelector('.lakomics-translation'),null);
  assert.equal(enabled,false);
  toggle.checked=true; await toggle.onchange(); await clock.advance(600);
  assert.equal(requests,2,'re-enabling translates once, not as a retry loop');
  assert.equal(w.document.querySelector('.lakomics-translation').dataset.error,'false');
  assert.equal(w.document.querySelector('.lakomics-translation').textContent,'복구 번역'); w.close();
});

test('initial intersection delivery and DOM changes during a request cannot retry its failure',async()=>{
  const dom=new JSDOM('<div data-testid="tweetText" lang="en">Pending post</div>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window, clock=fakeTimers(w), element=w.document.querySelector('div'); let requests=0, finish, observer;
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{constructor(cb){observer={cb};} observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else { requests++; finish=callback; }
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(40);
  observer.cb([{isIntersecting:true,target:element}]);
  w.document.body.append(w.document.createElement('aside')); await clock.advance(400);
  finish({ok:false,code:'network_error'}); await clock.advance(400);
  observer.cb([{isIntersecting:true,target:element}]); await clock.advance(400);
  assert.equal(requests,1); w.close();
});

test('a non-transient failure retries once on viewport re-entry, then stays parked',async()=>{
  let requests=0, observer;
  const w=translationWindow('<div data-testid="tweetText" lang="en">Invalid post</div>',message=>{
    if(message.type==='translation:settings') return {ok:true,enabled:true,hasApiKey:true};
    requests++; return {ok:false,code:'invalid_translation'};
  });
  const clock=fakeTimers(w), element=w.document.querySelector('div');
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{constructor(cb){observer={cb};} observe(){} unobserve(){}};
  w.eval(content); await clock.advance(400);
  for(let i=0;i<4;i++) {
    observer.cb([{isIntersecting:false,target:element}]);
    observer.cb([{isIntersecting:true,target:element}]);
    await clock.advance(400);
  }
  assert.equal(requests,2);
  assert.equal(w.document.querySelector('.lakomics-translation').textContent,'번역 실패 · 자동 번역을 껐다 켜면 재시도'); w.close();
});

test('content rate-limit cooldown survives DOM churn and re-entry and eventually stops',async()=>{
  let requests=0, observer;
  const w=translationWindow('<div data-testid="tweetText" lang="en">Rate limited post</div>',message=>{
    if(message.type==='translation:settings') return {ok:true,enabled:true,hasApiKey:true};
    requests++; return {ok:false,code:'http_429',retryAfterMs:2000};
  });
  const clock=fakeTimers(w), element=w.document.querySelector('div');
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{constructor(cb){observer={cb};} observe(){} unobserve(){}};
  w.eval(content); await clock.advance(40);
  w.document.body.append(w.document.createElement('aside')); await clock.advance(400);
  observer.cb([{isIntersecting:false,target:element}]);
  observer.cb([{isIntersecting:true,target:element}]); await clock.advance(400);
  assert.equal(requests,1,'DOM and viewport events must not bypass Retry-After');
  await clock.advance(6000);
  assert.equal(requests,3,'stop after three failed content requests, including the initial one');
  assert.equal(w.document.querySelector('.lakomics-translation').textContent,'번역 요청 한도 · 자동 재시도 중단');
  w.document.body.append(w.document.createElement('aside'));
  observer.cb([{isIntersecting:false,target:element}]);
  observer.cb([{isIntersecting:true,target:element}]); await clock.advance(10000);
  assert.equal(requests,3); w.close();
});

test('a cache clear removes parked failures and requests the visible post again',async()=>{
  let requests=0, changed;
  const w=translationWindow('<div data-testid="tweetText" lang="en">Invalid post</div>',message=>{
    if(message.type==='translation:settings') return {ok:true,enabled:true,hasApiKey:true};
    requests++; return {ok:false,code:'invalid_translation'};
  });
  const clock=fakeTimers(w), element=w.document.querySelector('div');
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome.storage.onChanged.addListener=fn=>{changed=fn;};
  w.eval(content); await clock.advance(400);
  changed({'lakomics:translation-cache:v2':{newValue:[]}},'local'); await clock.advance(400);
  assert.equal(requests,2); w.close();
});

test('editing a post during an in-flight request translates its new text',async()=>{
  const dom=new JSDOM('<div data-testid="tweetText" lang="en">Old post text</div>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window, clock=fakeTimers(w), element=w.document.querySelector('div'); let requests=0, finish;
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(++requests===1) finish=callback;
    else callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:'새 번역'}))});
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(40);
  element.textContent='New post text'; await clock.advance(400);
  finish({ok:true,text:'옛 번역'}); await clock.advance(400);
  assert.equal(requests,2); assert.equal(w.document.querySelector('.lakomics-translation').textContent,'새 번역'); w.close();
});

test('translator uses a compact floating icon popover and themed translation card',async()=>{
  const dom=new JSDOM('<body style="background:rgb(0,0,0)"><div data-testid="tweetText" lang="en">Hello <a href="https://x.com/hashtag/test">#test</a></div></body>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window, element=w.document.querySelector('[data-testid="tweetText"]'), clock=fakeTimers(dom.window);
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70}); w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true,model:'google/gemma-4-26b-a4b-it',modelLabel:'Gemma 4 26B A4B'});
    else if(message.type==='translation:request') callback({ok:true,text:'안녕 [[LINK_0]]'});
    else if(message.type==='translation:request-batch') callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:'안녕 [[LINK_0]]'}))});
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(450);
  const host=w.document.getElementById('lakomics-translation-controls'), shadow=host.shadowRoot;
  assert.ok(shadow.getElementById('translator-button')); assert.equal(shadow.getElementById('translator-popover').hidden,true);
  assert.equal(shadow.querySelector('.model').textContent,'Gemma 4 26B A4B');
  shadow.getElementById('translator-button').click(); assert.equal(shadow.getElementById('translator-popover').hidden,false);
  const card=w.document.querySelector('.lakomics-translation'); assert.equal(card.dataset.theme,'lights-out');
  assert.equal(card.querySelector('a').textContent,'#test'); assert.match(w.document.head.textContent,/29,\s*155,\s*240/); w.close();
});

test('rate limit honors Retry-After and retries without invalidating the key',async()=>{
  let attempts=0;
  const f=fixture(legacy,async()=>++attempts===1
    ? {ok:false,status:429,headers:{get(name){return name.toLowerCase()==='retry-after'?'0':null;}}}
    : {ok:true,json:async()=>({choices:[{message:{content:'한도 복구'}}]})});
  const result=await f.handle({type:'translation:request',text:'Rate limited'});
  assert.equal(result.ok,true); assert.equal(result.text,'한도 복구'); assert.equal(attempts,2);
  const settings=await f.handle({type:'translation:settings'}); assert.equal(settings.hasApiKey,true);
});

test('invalid item in the non-fast-lane batch falls back alone without discarding valid translations',async()=>{
  const html='<div data-testid="tweetText" lang="en">Fast post</div><div data-testid="tweetText" lang="en">First post</div><div data-testid="tweetText" lang="en">Second post</div>';
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window, clock=fakeTimers(dom.window); let batchCalls=0,singleCalls=0;
  const positions=[[350,390],[10,50],[60,100]];
  for(const [i,el] of [...w.document.querySelectorAll('[data-testid="tweetText"]')].entries()) el.getBoundingClientRect=()=>({width:300,height:40,top:positions[i][0],bottom:positions[i][1]});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){singleCalls+=1; callback({ok:true,text:message.text==='Fast post'?'빠른 번역':'두 번째 번역'});}
    else if(message.type==='translation:request-batch'){batchCalls+=1; const first=message.items.find(item=>item.text==='First post'), second=message.items.find(item=>item.text==='Second post'); callback({ok:true,items:[{id:first.id,ok:true,text:'첫 번째 번역'},{id:second.id,ok:false,code:'invalid_translation'}]});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(150);
  assert.equal(batchCalls,1); assert.equal(singleCalls,2); assert.deepEqual([...w.document.querySelectorAll('.lakomics-translation')].map(n=>n.textContent),['빠른 번역','첫 번째 번역','두 번째 번역']); w.close();
});

test('one X tab keeps the fast lane and first batch in flight together',async()=>{
  const html=Array.from({length:8},(_,i)=>`<div data-testid="tweetText" lang="en">Concurrent post ${i}</div>`).join('');
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window, clock=fakeTimers(dom.window);
  let active=0,maxActive=0,batchCalls=0,singleCalls=0;
  for(const [i,el] of [...w.document.querySelectorAll('[data-testid="tweetText"]')].entries()) el.getBoundingClientRect=()=>({width:300,height:35,top:5+i*40,bottom:40+i*40});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  const finish=(callback,result)=>{active+=1; maxActive=Math.max(maxActive,active); w.setTimeout(()=>{active-=1; callback(result);},120);};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){singleCalls+=1; finish(callback,{ok:true,text:'빠른 번역'});}
    else if(message.type==='translation:request-batch'){batchCalls+=1; finish(callback,{ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:`번역 ${item.id}`}))});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(380);
  assert.equal(singleCalls,1); assert.equal(batchCalls,2); assert.equal(maxActive,2); assert.equal(w.document.querySelectorAll('.lakomics-translation').length,8); w.close();
});

test('runtime mounts as soon as body exists without waiting for DOMContentLoaded',()=>{
  const dom=new JSDOM('<body></body>',{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window;
  Object.defineProperty(w.document,'readyState',{configurable:true,value:'loading'});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){if(message.type==='translation:settings') callback({ok:true,enabled:false,hasApiKey:true});}},storage:{onChanged:{addListener(){}}}};
  w.eval(content);
  assert.ok(w.document.getElementById('lakomics-translation-controls')); w.close();
});

test('initial visible tweet scan starts a translation without the 120 ms debounce',async()=>{
  const dom=new JSDOM('<div data-testid="tweetText" lang="en">Immediate translation text</div>',{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window; let requests=0;
  const element=w.document.querySelector('[data-testid="tweetText"]'), clock=fakeTimers(dom.window); element.getBoundingClientRect=()=>({width:300,height:50,top:10,bottom:60});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type.startsWith('translation:request')){requests+=1; callback(message.type.endsWith('batch')?{ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:'즉시 번역'}))}:{ok:true,text:'즉시 번역'});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(40);
  assert.equal(requests,1); w.close();
});
test('first visible tweet uses a single fast lane while the next batch starts concurrently',async()=>{
  const html=Array.from({length:5},(_,i)=>`<div data-testid="tweetText" lang="en">Fast lane post ${i}</div>`).join('');
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window, clock=fakeTimers(dom.window);
  let singleCalls=0,batchCalls=0,releaseBatch;
  for(const [i,el] of [...w.document.querySelectorAll('[data-testid="tweetText"]')].entries()) el.getBoundingClientRect=()=>({width:300,height:40,top:280+i*45,bottom:320+i*45});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){singleCalls+=1; callback({ok:true,text:'가장 먼저 번역'});}
    else if(message.type==='translation:request-batch'){batchCalls+=1; releaseBatch=()=>callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:`배치 ${item.id}`}))});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(40);
  assert.equal(singleCalls,1); assert.equal(batchCalls,1); assert.equal(w.document.querySelectorAll('.lakomics-translation').length,1);
  releaseBatch(); await clock.advance(30); assert.equal(w.document.querySelectorAll('.lakomics-translation').length,5); w.close();
});
test('a no-translation result shows no card and is not requested again',async()=>{
  let requests=0;
  const w=translationWindow('<div data-testid="tweetText" lang="en">Blue Archive</div>',message=>{
    if(message.type==='translation:settings') return {ok:true,enabled:true,hasApiKey:true};
    requests+=1; return {ok:true,text:null,untranslated:true};
  });
  const element=w.document.querySelector('div'), clock=fakeTimers(w);
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.eval(content); await clock.advance(400);
  for(let round=0;round<3;round+=1){ w.document.body.append(w.document.createElement('div')); await clock.advance(400); }
  assert.equal(requests,1); assert.equal(w.document.querySelector('.lakomics-translation'),null);
  assert.equal(w.document.querySelector('#lakomics-translation-controls').shadowRoot.querySelector('#status').textContent,''); w.close();
});

test('a link the translation dropped is re-attached at the end and stays clickable',()=>{
  const dom=new JSDOM('<div data-testid="tweetText">Hi <a href="https://x.com/hashtag/tag">#tag</a> and <a href="https://example.com/">site</a></div>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window; w.__LAKOMICS_TEST__=true; w.IntersectionObserver=class{}; w.eval(content);
  const api=w.LakomicsTranslateContent, element=w.document.querySelector('div'), snapshot=api.source(element);
  api.render(element,snapshot,'[[LINK_1]] 안녕');
  const card=w.document.querySelector('.lakomics-translation');
  assert.equal(card.textContent,'site 안녕 #tag');
  assert.deepEqual([...card.querySelectorAll('a')].map(a=>a.href),['https://example.com/','https://x.com/hashtag/tag']); w.close();
});

test('a slow batch does not hold the other slot: the next group starts as soon as a slot frees',async()=>{
  const html=Array.from({length:9},(_,i)=>`<div data-testid="tweetText" lang="en">Slot post ${i}</div>`).join('');
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window, clock=fakeTimers(dom.window);
  let singles=0; const batches=[];
  for(const [i,el] of [...w.document.querySelectorAll('[data-testid="tweetText"]')].entries()) el.getBoundingClientRect=()=>({width:300,height:35,top:5+i*40,bottom:40+i*40});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){singles+=1; w.setTimeout(()=>callback({ok:true,text:'빠른 번역'}),50);}
    else if(message.type==='translation:request-batch'){batches.push(()=>callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:`번역 ${item.id}`}))}));}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(100);
  // The fast lane finished while the first batch is still out: the freed slot already
  // carries the next batch instead of waiting for the slow one.
  assert.equal(singles,1); assert.equal(batches.length,2);
  batches.forEach(release=>release()); await clock.advance(50);
  assert.equal(w.document.querySelectorAll('.lakomics-translation').length,9); w.close();
});

test('posts scrolled into view send the one nearest the centre alone first',async()=>{
  const dom=new JSDOM('<div data-testid="tweetText" lang="en">First screen post</div>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window, clock=fakeTimers(dom.window), sent=[]; let observer;
  const first=w.document.querySelector('div'); first.getBoundingClientRect=()=>({width:300,height:40,top:350,bottom:390});
  w.IntersectionObserver=class{constructor(cb){observer={cb};} observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){sent.push(['single',message.text]); callback({ok:true,text:'단독 번역'});}
    else if(message.type==='translation:request-batch'){sent.push(['batch',message.items.map(item=>item.text)]); callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:'묶음 번역'}))});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(200);
  first.getBoundingClientRect=()=>({width:300,height:40,top:-200,bottom:-160});
  const added=['Edge post','Centre post','Lower post'].map((text,i)=>{const el=w.document.createElement('div'); el.dataset.testid='tweetText'; el.lang='en'; el.textContent=text; const top=[20,360,700][i]; el.getBoundingClientRect=()=>({width:300,height:40,top,bottom:top+40}); w.document.body.append(el); return el;});
  observer.cb(added.map(target=>({isIntersecting:true,target})));
  await clock.advance(400);
  assert.deepEqual(sent.slice(1)[0],['single','Centre post']);
  assert.equal(sent.slice(1).length,2); w.close();
});

test('a slow request shows a quiet pending line that the result replaces, fast answers never flash it',async()=>{
  const dom=new JSDOM('<div data-testid="tweetText" lang="en">Slow post text</div><div data-testid="tweetText" lang="en">Fast post text</div>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window, clock=fakeTimers(dom.window), [slow,fast]=w.document.querySelectorAll('[data-testid="tweetText"]'); let release;
  slow.getBoundingClientRect=()=>({width:300,height:20,top:370,bottom:390}); fast.getBoundingClientRect=()=>({width:300,height:20,top:10,bottom:30});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request') release=()=>callback({ok:true,text:'느린 번역'});
    else callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:'빠른 번역'}))});
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(100);
  assert.equal(fast.nextElementSibling.textContent,'빠른 번역');
  assert.equal(slow.nextElementSibling?.className==='lakomics-translation',false);
  await clock.advance(200);
  assert.equal(slow.nextElementSibling.dataset.state,'pending'); assert.equal(slow.nextElementSibling.textContent,'번역 중…');
  release(); await clock.advance(10);
  assert.equal(slow.nextElementSibling.textContent,'느린 번역'); assert.equal(slow.nextElementSibling.dataset.state,undefined);
  assert.equal(w.document.querySelectorAll('.lakomics-translation').length,2); w.close();
});

test('a long original folds to two lines behind a toggle that never opens the post; short originals stay open',async()=>{
  const dom=new JSDOM('<article><div data-testid="tweetText" lang="en">Long post text</div></article><article><div data-testid="tweetText" lang="en">Short post text</div></article>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window, clock=fakeTimers(dom.window), [long,short]=w.document.querySelectorAll('[data-testid="tweetText"]'); let opened=0;
  long.getBoundingClientRect=()=>({width:300,height:80,top:10,bottom:90}); short.getBoundingClientRect=()=>({width:300,height:20,top:100,bottom:120});
  w.document.addEventListener('click',()=>{opened+=1;});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request') callback({ok:true,text:'번역'});
    else callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:'번역'}))});
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(200);
  assert.equal(long.dataset.lakomicsCollapsed,'true'); assert.equal(short.dataset.lakomicsCollapsed,undefined);
  const toggle=w.document.querySelector('.lakomics-translation-toggle');
  assert.equal(toggle.textContent,'원문 펼치기'); assert.equal(toggle.getAttribute('aria-expanded'),'false');
  toggle.click();
  assert.equal(long.dataset.lakomicsCollapsed,'false'); assert.equal(toggle.textContent,'원문 접기'); assert.equal(opened,0);
  await clock.advance(400);
  assert.equal(w.document.querySelectorAll('.lakomics-translation-toggle').length,1,'the toggle must not trigger a rescan loop'); w.close();
});

test('the floating translation button has an accessible name and no hover tooltip',()=>{
  const dom=new JSDOM('<body></body>',{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window;
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){if(message.type==='translation:settings') callback({ok:true,enabled:false,hasApiKey:true});}},storage:{onChanged:{addListener(){}}}};
  w.eval(content);
  const button=w.document.getElementById('lakomics-translation-controls').shadowRoot.getElementById('translator-button');
  assert.equal(button.getAttribute('aria-label'),'AI 번역'); assert.equal(button.hasAttribute('title'),false); w.close();
});

test('requests turn reasoning off (minimal where mandatory) and ask OpenRouter for the lowest-latency provider',async()=>{
  const f=fixture(legacy,async()=>({ok:true,json:async()=>({choices:[{message:{content:'번역'}}]})}));
  await f.handle({type:'translation:request',text:'Hello'});
  let body=JSON.parse(f.calls[0].init.body);
  assert.equal(body.model,'google/gemini-3.1-flash-lite'); assert.deepEqual(body.reasoning,{enabled:false}); assert.equal(body.provider.sort,'latency');
  await f.handle({type:'translation:update',model:'google/gemini-3.5-flash-lite'});
  await f.handle({type:'translation:request-batch',items:[{id:'a',text:'One'},{id:'b',text:'Two'}]});
  body=JSON.parse(f.calls.at(-1).init.body);
  assert.deepEqual(body.reasoning,{effort:'minimal'}); assert.equal(body.provider.sort,'latency'); assert.equal(body.provider.require_parameters,true);
});

test('the Gemma sub model answers when the main model times out, errors or answers badly, and can be turned off',async()=>{
  const models=[];
  let mode='error';
  const f=fixture(legacy,async(url,init)=>{
    const body=JSON.parse(init.body); models.push(body.model);
    if(body.model==='google/gemma-4-26b-a4b-it') return {ok:true,json:async()=>({choices:[{message:{content:'보조 번역'}}]})};
    if(mode==='error') return {ok:false,status:503,headers:{get(){return null;}}};
    return {ok:true,json:async()=>({choices:[{message:{content:'ブルアカ'}}]})};
  });
  const settings=await f.handle({type:'translation:settings'});
  assert.equal(settings.fallbackModel,'google/gemma-4-26b-a4b-it');
  assert.equal((await f.handle({type:'translation:request',text:'Server error post'})).text,'보조 번역');
  assert.deepEqual(models,['google/gemini-3.1-flash-lite','google/gemma-4-26b-a4b-it']);
  mode='invalid'; models.length=0;
  assert.equal((await f.handle({type:'translation:request',text:'Invalid answer post'})).text,'보조 번역');
  assert.deepEqual(models,['google/gemini-3.1-flash-lite','google/gemma-4-26b-a4b-it']);
  models.length=0;
  assert.equal((await f.handle({type:'translation:request',text:'Batch leftover',fallback:true})).text,'보조 번역');
  assert.deepEqual(models,['google/gemma-4-26b-a4b-it']);
  const off=await f.handle({type:'translation:update',fallbackModel:''});
  assert.equal(off.fallbackModel,''); mode='error'; models.length=0;
  assert.equal((await f.handle({type:'translation:request',text:'No sub model post'})).code,'http_503');
  assert.deepEqual(models,['google/gemini-3.1-flash-lite','google/gemini-3.1-flash-lite']);
  assert.equal((await f.handle({type:'translation:update',fallbackModel:'google/gemini-3.1-flash-lite'})).fallbackModel,'','the sub model cannot equal the main model');
});

test('auth failures never fall back to the sub model',async()=>{
  const models=[];
  const f=fixture(legacy,async(url,init)=>{models.push(JSON.parse(init.body).model); return {ok:false,status:401,headers:{get(){return null;}}};});
  assert.equal((await f.handle({type:'translation:request',text:'Auth post'})).code,'http_401');
  assert.deepEqual(models,['google/gemini-3.1-flash-lite']);
});

test('posts just below the viewport are translated ahead, after the ones on screen',async()=>{
  const html=['On screen post','Ahead post','Far below post'].map(text=>`<div data-testid="tweetText" lang="en">${text}</div>`).join('');
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window, clock=fakeTimers(dom.window), sent=[];
  const tops=[300, w.innerHeight+400, w.innerHeight*4];
  for(const [i,el] of [...w.document.querySelectorAll('[data-testid="tweetText"]')].entries()) el.getBoundingClientRect=()=>({width:300,height:40,top:tops[i],bottom:tops[i]+40});
  let options; w.IntersectionObserver=class{constructor(cb,opts){options=opts;} observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){sent.push(message.text); callback({ok:true,text:'번역'});}
    else {sent.push(...message.items.map(item=>item.text)); callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:'번역'}))});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await clock.advance(200);
  assert.deepEqual(sent,['On screen post','Ahead post']);
  assert.equal(options.rootMargin,'25% 0px 150% 0px'); w.close();
});
