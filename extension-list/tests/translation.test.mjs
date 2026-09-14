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
    if (message.type === 'translation:request-batch') { requests++; callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:item.text.includes('Changed')?'변경된 글':'안녕하세요'}))}); }
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

test('placeholder validation rejects reordered links',async()=>{
  const f=fixture(legacy,async()=>({ok:true,json:async()=>({choices:[{message:{content:'안녕 [[LINK_1]] 그리고 [[LINK_0]]'}}]})}));
  const result=await f.handle({type:'translation:request',text:'Hello [[LINK_0]] and [[LINK_1]]'});
  assert.equal(result.code,'invalid_translation');
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
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window;
  const batches=[]; let singles=0;
  for(const [i,el] of [...w.document.querySelectorAll('[data-testid="tweetText"]')].entries()) el.getBoundingClientRect=()=>({width:300,height:40,top:10+i*50,bottom:50+i*50});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){singles+=1; callback({ok:true,text:'빠른 번역'});}
    else if(message.type==='translation:request-batch'){batches.push(message.items.length); callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:`번역 ${item.id}`}))});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(singles,1); assert.deepEqual(batches,[4]); assert.equal(w.document.querySelectorAll('.lakomics-translation').length,5); w.close();
});

test('transient content failure is retried when the tweet re-enters the viewport',async()=>{
  const dom=new JSDOM('<div data-testid="tweetText" lang="en">Retry this post</div>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window, element=w.document.querySelector('div'); let observer, requests=0;
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70});
  w.IntersectionObserver=class{constructor(cb){this.cb=cb;observer=this;} observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){requests+=1; callback(requests===1?{ok:false,code:'network_error'}:{ok:true,text:'재시도 성공'});}
    else if(message.type==='translation:request-batch'){requests+=1; callback(requests===1?{ok:false,code:'network_error'}:{ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:'재시도 성공'}))});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await new Promise(resolve=>setTimeout(resolve,450));
  observer.cb([{isIntersecting:true,target:element}]); await new Promise(resolve=>setTimeout(resolve,450));
  assert.equal(requests,2); assert.equal(w.document.querySelector('.lakomics-translation').textContent,'재시도 성공'); w.close();
});

test('translator uses a compact floating icon popover and themed translation card',async()=>{
  const dom=new JSDOM('<body style="background:rgb(0,0,0)"><div data-testid="tweetText" lang="en">Hello <a href="https://x.com/hashtag/test">#test</a></div></body>',{url:'https://x.com',runScripts:'outside-only'});
  const w=dom.window, element=w.document.querySelector('[data-testid="tweetText"]');
  element.getBoundingClientRect=()=>({width:300,height:60,top:10,bottom:70}); w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true,model:'google/gemini-3.1-flash-lite'});
    else if(message.type==='translation:request') callback({ok:true,text:'안녕 [[LINK_0]]'});
    else if(message.type==='translation:request-batch') callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:'안녕 [[LINK_0]]'}))});
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await new Promise(resolve=>setTimeout(resolve,450));
  const host=w.document.getElementById('lakomics-translation-controls'), shadow=host.shadowRoot;
  assert.ok(shadow.getElementById('translator-button')); assert.equal(shadow.getElementById('translator-popover').hidden,true);
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
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window; let batchCalls=0,singleCalls=0;
  const positions=[[350,390],[10,50],[60,100]];
  for(const [i,el] of [...w.document.querySelectorAll('[data-testid="tweetText"]')].entries()) el.getBoundingClientRect=()=>({width:300,height:40,top:positions[i][0],bottom:positions[i][1]});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){singleCalls+=1; callback({ok:true,text:message.text==='Fast post'?'빠른 번역':'두 번째 번역'});}
    else if(message.type==='translation:request-batch'){batchCalls+=1; const first=message.items.find(item=>item.text==='First post'), second=message.items.find(item=>item.text==='Second post'); callback({ok:true,items:[{id:first.id,ok:true,text:'첫 번째 번역'},{id:second.id,ok:false,code:'invalid_translation'}]});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(batchCalls,1); assert.equal(singleCalls,2); assert.deepEqual([...w.document.querySelectorAll('.lakomics-translation')].map(n=>n.textContent),['빠른 번역','첫 번째 번역','두 번째 번역']); w.close();
});

test('one X tab keeps the fast lane and first batch in flight together',async()=>{
  const html=Array.from({length:8},(_,i)=>`<div data-testid="tweetText" lang="en">Concurrent post ${i}</div>`).join('');
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window;
  let active=0,maxActive=0,batchCalls=0,singleCalls=0;
  for(const [i,el] of [...w.document.querySelectorAll('[data-testid="tweetText"]')].entries()) el.getBoundingClientRect=()=>({width:300,height:35,top:5+i*40,bottom:40+i*40});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  const finish=(callback,result)=>{active+=1; maxActive=Math.max(maxActive,active); setTimeout(()=>{active-=1; callback(result);},120);};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){singleCalls+=1; finish(callback,{ok:true,text:'빠른 번역'});}
    else if(message.type==='translation:request-batch'){batchCalls+=1; finish(callback,{ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:`번역 ${item.id}`}))});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await new Promise(resolve=>setTimeout(resolve,380));
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
  const element=w.document.querySelector('[data-testid="tweetText"]'); element.getBoundingClientRect=()=>({width:300,height:50,top:10,bottom:60});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type.startsWith('translation:request')){requests+=1; callback(message.type.endsWith('batch')?{ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:'즉시 번역'}))}:{ok:true,text:'즉시 번역'});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(requests,1); w.close();
});
test('first visible tweet uses a single fast lane while the next batch starts concurrently',async()=>{
  const html=Array.from({length:5},(_,i)=>`<div data-testid="tweetText" lang="en">Fast lane post ${i}</div>`).join('');
  const dom=new JSDOM(html,{url:'https://x.com',runScripts:'outside-only'}); const w=dom.window;
  let singleCalls=0,batchCalls=0,releaseBatch;
  for(const [i,el] of [...w.document.querySelectorAll('[data-testid="tweetText"]')].entries()) el.getBoundingClientRect=()=>({width:300,height:40,top:280+i*45,bottom:320+i*45});
  w.IntersectionObserver=class{observe(){} unobserve(){}};
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') callback({ok:true,enabled:true,hasApiKey:true});
    else if(message.type==='translation:request'){singleCalls+=1; callback({ok:true,text:'가장 먼저 번역'});}
    else if(message.type==='translation:request-batch'){batchCalls+=1; releaseBatch=()=>callback({ok:true,items:message.items.map(item=>({id:item.id,ok:true,text:`배치 ${item.id}`}))});}
  }},storage:{onChanged:{addListener(){}}}};
  w.eval(content); await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(singleCalls,1); assert.equal(batchCalls,1); assert.equal(w.document.querySelectorAll('.lakomics-translation').length,1);
  releaseBatch(); await new Promise(resolve=>setTimeout(resolve,30)); assert.equal(w.document.querySelectorAll('.lakomics-translation').length,5); w.close();
});