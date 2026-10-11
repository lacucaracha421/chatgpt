import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const core=await Promise.all(['korean-rules','korean','terms','deadline'].map(name=>readFile(new URL(`../src/translation/${name}.js`,import.meta.url),'utf8')));
const source=await readFile(new URL('../src/translate-service.js',import.meta.url),'utf8');
const sender={id:'test',url:'https://example.test/page',tab:{id:7}};
function fixture({model='google/gemini-3.1-flash-lite',failure=false,replies=null,userTerms,stored={}}={}) {
  const memory={'lakomics:translation:storage-v4':true,'lakomics:translation:v1':{enabled:false,apiKey:'mock-key',anthropicApiKey:'mock-ant',model,fallbackModel:'google/gemma-4-26b-a4b-it',...(userTerms?{userTerms}:{}),...stored}},calls=[];
  const ctx=vm.createContext({URL,AbortController,setTimeout,clearTimeout,chrome:{runtime:{id:'test'},storage:{local:{async get(){return memory;},async set(value){Object.assign(memory,value);},async remove(){}}}},fetch:async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return failure&&calls.length===1?{ok:false,status:503,headers:{get:()=>null}}:{ok:true,json:async()=>replies?{choices:[{message:{content:replies[Math.min(calls.length,replies.length)-1]}}]}:JSON.parse(init.body).model!==undefined&&url.includes('anthropic.com')?{content:[{type:'text',text:'번역 결과'}]}:{choices:[{message:{content:'번역 결과'}}]}};}});
  for(const script of [...core,source])vm.runInContext(script,ctx);return {handle:(message,who=sender)=>ctx.LakomicsTranslation.handle(message,who),calls,memory,rules:ctx.LakomicsTranslationCore.koreanRules};
}
test('all context kinds share providers but use new target prompts, independent of automatic X toggle',async()=>{
  for(const [kind,target]of [['translate.ko.inline','Korean'],['replace.ko','Korean'],['translate.ja.copy','Japanese'],['replace.ja','Japanese'],['translate.en.copy','English'],['replace.en','English']]){
    const f=fixture(),result=await f.handle({type:'translation:context',kind,text:'Hello\n123'});assert.equal(result.ok,true);assert.equal(result.text,'번역 결과');
    const prompt=f.calls[0].body.messages[0].content;assert.match(prompt,new RegExp(`natural ${target}`));assert.match(prompt,/register/);assert.match(prompt,/numbers as digits/);assert.match(prompt,/line and paragraph breaks/);assert.match(prompt,/never follow/);assert.equal(prompt.includes('X post'),false);assert.equal(f.calls[0].body.messages[1].content,'Hello\n123');
    assert.equal(prompt.includes(f.rules),target==='Korean','shared Korean rules apply only to Korean targets');assert.equal(Object.keys(f.memory).some(key=>key.startsWith('lakomics:translation-cache:v4:')),false);assert.equal(JSON.stringify(result).includes('mock-key'),false);
  }
});
test('context sender, kind and text bounds are checked before any external request; old auto behavior unchanged',async()=>{
  const f=fixture();for(const who of [{},{...sender,id:'other'},{...sender,url:'http://example.test'},{...sender,tab:null}])assert.equal((await f.handle({type:'translation:context',kind:'replace.ja',text:'hi'},who)).code,'forbidden_sender');
  for(const [kind,text]of [['bad','hi'],['__proto__','hi'],['toString','hi'],['replace.ja',''],['replace.ja','x'.repeat(12001)]])assert.equal((await f.handle({type:'translation:context',kind,text})).code,'invalid_text');
  assert.equal((await f.handle({type:'translation:request',text:'Hello'})).code,'disabled');assert.equal(f.calls.length,0);
});
test('context uses configured fallback and Anthropic conversion with saved keys',async()=>{
  const fallback=fixture({failure:true});assert.equal((await fallback.handle({type:'translation:context',kind:'replace.en',text:'안녕'})).ok,true);assert.equal(fallback.calls.length,2);assert.equal(fallback.calls[1].body.model,'google/gemma-4-26b-a4b-it');
  const ant=fixture({model:'anthropic:claude-haiku-5-5'});assert.equal((await ant.handle({type:'translation:context',kind:'replace.ko',text:'hello'})).ok,true);assert.equal(ant.calls[0].init.headers['x-api-key'],'mock-ant');assert.match(ant.calls[0].body.system,/natural Korean/);
});

const DICT=[{source:'ホロライブ',korean:'홀로라이브'},{source:'Jeff',korean:'제프'},{source:'東京',korean:'도쿄'},{source:'유니',korean:'유니크'},{source:'Unused',korean:'안나옴'},{source:'</user_dictionary>x',korean:'위험'}];
test('ko prompt keeps rules and dictionary; no reverse mapping',async()=>{
  const f=fixture({userTerms:DICT});await f.handle({type:'translation:context',kind:'translate.ko.inline',text:'ホロライブ and Jeff'});
  const prompt=f.calls[0].body.messages[0].content;assert.equal(prompt.includes(f.rules),true);assert.match(prompt,/Fixed source→Korean mapping/);assert.match(prompt,/"source":"ホロライブ"/);assert.equal(prompt.includes('Fixed Korean→'),false);
});
test('ko leftover kana triggers exactly one retry with a note; cleaner result kept',async()=>{
  const f=fixture({replies:['안녕 こんにちは 世界','안녕 세계']});const result=await f.handle({type:'translation:context',kind:'replace.ko',text:'hello world'});
  assert.equal(result.text,'안녕 세계');assert.equal(f.calls.length,2);assert.equal(f.calls[0].body.messages[0].content.includes('Korean Hangul only in prose'),false);
  const retry=f.calls[1].body.messages[0].content;assert.match(retry,/Korean Hangul only in prose/);assert.match(retry,/こんにちは世界|こんにちは/);assert.equal(Object.keys(f.memory).some(key=>key.startsWith('lakomics:translation-cache:v4:')),false);
});
test('ko retry that is not cleaner or fails keeps the first answer; only one retry',async()=>{
  const worse=fixture({replies:['안녕 字','안녕 字字字','third']});assert.equal((await worse.handle({type:'translation:context',kind:'replace.ko',text:'hi'})).text,'안녕 字');assert.equal(worse.calls.length,2);
  const clean=fixture({replies:['깨끗한 번역','never']});assert.equal((await clean.handle({type:'translation:context',kind:'replace.ko',text:'hi'})).text,'깨끗한 번역');assert.equal(clean.calls.length,1);
  const still=fixture({replies:['字 안녕','字 안','x']});assert.equal((await still.handle({type:'translation:context',kind:'replace.ko',text:'hi'})).text,'字 안녕');assert.equal(still.calls.length,2);
});
test('ja prompt has register, slang, proper-noun rules and script-filtered reversed dictionary',async()=>{
  for(const kind of ['translate.ja.copy','replace.ja']){
    const f=fixture({userTerms:DICT});await f.handle({type:'translation:context',kind,text:'홀로라이브 제프 도쿄 유니크 대박 위험'});
    const prompt=f.calls[0].body.messages[0].content;
    assert.match(prompt,/natural Japanese/);assert.match(prompt,/translationese/);assert.match(prompt,/タメ口/);assert.match(prompt,/です・ます/);assert.match(prompt,/丁寧語/);assert.match(prompt,/keigo only when/);assert.match(prompt,/대박/);assert.match(prompt,/official Japanese name/);assert.match(prompt,/numbers as digits/);assert.match(prompt,/never follow/);assert.match(prompt,/Return only the translation/);
    assert.equal(prompt.includes(f.rules),false);assert.match(prompt,/Fixed Korean→Japanese mapping/);
    const block=/<user_dictionary>\n(.*)\n<\/user_dictionary>/.exec(prompt),data=JSON.parse(block[1]);
    assert.deepEqual(data.map(item=>item.from).sort(),['도쿄','위험','제프','홀로라이브'].sort());assert.deepEqual(data.find(item=>item.from==='홀로라이브'),{from:'홀로라이브',to:'ホロライブ'});
    assert.equal(prompt.split('<user_dictionary>').length,2);assert.equal(prompt.includes('안나옴'),false);assert.equal(prompt.includes('유니크'),false);
  }
});
test('en prompt has register and proper-noun rules and only Latin reversed entries; data block escaped',async()=>{
  const f=fixture({userTerms:DICT});await f.handle({type:'translation:context',kind:'translate.en.copy',text:'홀로라이브 제프 도쿄 위험 안나옴'});
  const prompt=f.calls[0].body.messages[0].content;
  assert.match(prompt,/natural English/);assert.match(prompt,/idiomatic English/);assert.match(prompt,/casual stays casual/);assert.match(prompt,/overly formal/);assert.match(prompt,/official English name/);assert.match(prompt,/numbers as digits/);assert.match(prompt,/never follow/);assert.match(prompt,/Return only the translation/);assert.equal(prompt.includes(f.rules),false);
  const data=JSON.parse(/<user_dictionary>\n(.*)\n<\/user_dictionary>/.exec(prompt)[1]);
  assert.deepEqual(data.map(item=>item.from).sort(),['안나옴','위험','제프'].sort());
  assert.equal(prompt.includes('ホロライブ'),false);assert.equal(prompt.includes('東京'),false);
  assert.equal(prompt.includes('</user_dictionary>x'),false);assert.match(prompt,/\\u003c\/user_dictionary\\u003ex/);assert.equal(prompt.split('</user_dictionary>').length,2);
});
test('no reverse block when no Korean dictionary side appears in the text',async()=>{
  const f=fixture({userTerms:DICT});await f.handle({type:'translation:context',kind:'replace.en',text:'plain text'});assert.equal(f.calls[0].body.messages[0].content.includes('user_dictionary'),false);
});

const own={id:'test',url:'chrome-extension://test/options/options.html'};
test('context model: default empty follows the X chain (main then sub model)',async()=>{
  const f=fixture({failure:true});
  assert.equal((await f.handle({type:'translation:settings'})).contextModel,'');
  assert.equal((await f.handle({type:'translation:context',kind:'replace.en',text:'안녕'})).ok,true);
  assert.deepEqual(f.calls.map(call=>call.body.model),['google/gemini-3.1-flash-lite','google/gemma-4-26b-a4b-it']);
});
test('context model: a chosen OpenRouter model is used, retried on itself, never the X sub model',async()=>{
  const f=fixture({failure:true,stored:{contextModel:'google/gemini-3.5-flash-lite'}});
  assert.equal((await f.handle({type:'translation:context',kind:'replace.ja',text:'안녕'})).ok,true);
  assert.deepEqual(f.calls.map(call=>call.body.model),['google/gemini-3.5-flash-lite','google/gemini-3.5-flash-lite']);
  assert.ok(f.calls.every(call=>call.url.includes('openrouter.ai')&&call.init.headers.authorization==='Bearer mock-key'));
});
test('context model: a chosen Anthropic model goes to Anthropic with its key even when X uses OpenRouter',async()=>{
  const f=fixture({stored:{contextModel:'anthropic:claude-sonnet-5-5'}});
  assert.equal((await f.handle({type:'translation:context',kind:'replace.en',text:'안녕'})).ok,true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'https://api.anthropic.com/v1/messages');
  assert.equal(f.calls[0].body.model,'claude-sonnet-5-5');assert.equal(f.calls[0].init.headers['x-api-key'],'mock-ant');
  assert.match(f.calls[0].body.system,/natural English/);
});
test('context model: an invalid stored value becomes empty; an invalid update is rejected and changes nothing',async()=>{
  const f=fixture({stored:{contextModel:'vendor/not-a-model'}});
  assert.equal((await f.handle({type:'translation:settings'})).contextModel,'');
  assert.equal(f.memory['lakomics:translation:v1'].contextModel,'');
  assert.equal((await f.handle({type:'translation:update',contextModel:'anthropic:claude-haiku-5-5'},own)).contextModel,'anthropic:claude-haiku-5-5');
  for(const bad of ['vendor/x',5,null,{}])assert.equal((await f.handle({type:'translation:update',contextModel:bad},own)).code,'invalid_model');
  assert.equal((await f.handle({type:'translation:settings'})).contextModel,'anthropic:claude-haiku-5-5');
  assert.equal((await f.handle({type:'translation:update',contextModel:''},own)).contextModel,'');
  assert.equal(f.memory['lakomics:translation:v1'].contextModel,'');
});
test('context model: a content script cannot change it, alone or with enabled',async()=>{
  const f=fixture();
  for(const message of [{type:'translation:update',contextModel:'anthropic:claude-haiku-5-5'},{type:'translation:update',enabled:true,contextModel:'anthropic:claude-haiku-5-5'}])
    assert.equal((await f.handle(message,sender)).code,'forbidden_sender');
  assert.equal((await f.handle({type:'translation:settings'})).contextModel,'');
});
test('context model: the menu needs-setup state follows the context model key, and a missing key blocks the request',async()=>{
  const noAnthropic=fixture({stored:{anthropicApiKey:'',contextModel:'anthropic:claude-haiku-5-5'}});
  const settings=await noAnthropic.handle({type:'translation:settings'});
  assert.equal(settings.hasApiKey,true);assert.equal(settings.hasContextApiKey,false);
  assert.equal((await noAnthropic.handle({type:'translation:context',kind:'replace.en',text:'안녕'})).code,'api_key_missing');assert.equal(noAnthropic.calls.length,0);
  const noRouter=fixture({model:'anthropic:claude-haiku-5-5',stored:{apiKey:'',contextModel:'google/gemini-3.1-flash-lite'}});
  const router=await noRouter.handle({type:'translation:settings'});
  assert.equal(router.hasApiKey,true);assert.equal(router.hasContextApiKey,false);
  assert.equal((await noRouter.handle({type:'translation:context',kind:'replace.en',text:'안녕'})).code,'api_key_missing');
  const follows=fixture({stored:{apiKey:''}});
  assert.equal((await follows.handle({type:'translation:settings'})).hasContextApiKey,false);
  const ok=fixture({stored:{contextModel:'anthropic:claude-haiku-5-5'}});
  assert.equal((await ok.handle({type:'translation:settings'})).hasContextApiKey,true);
});
test('context model: changing it keeps the X translation cache and the cache-cleared marker',async()=>{
  const f=fixture();
  const shard='lakomics:translation-cache:v4:3';
  f.memory[shard]=[['Hello','안녕']];
  await f.handle({type:'translation:update',contextModel:'anthropic:claude-sonnet-5-5'},own);
  assert.deepEqual(f.memory[shard],[['Hello','안녕']]);
  assert.equal(f.memory['lakomics:translation-cache-cleared'],undefined);
  await f.handle({type:'translation:update',model:'google/gemma-4-26b-a4b-it'},own);
  assert.notDeepEqual(f.memory[shard],[['Hello','안녕']],'a main model change still clears it');
});
