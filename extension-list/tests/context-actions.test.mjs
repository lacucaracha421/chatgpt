import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../../_tools/app/node_modules/jsdom/lib/api.js';
const sources=await Promise.all(['model','surfaces','actions'].map(name=>readFile(new URL(`../src/context-menu/${name}.js`,import.meta.url),'utf8')));
function fixture(html='<textarea>Hello world</textarea>') {
  const dom=new JSDOM(html,{url:'https://example.test',runScripts:'outside-only'}),w=dom.window,doc=w.document;
  w.matchMedia=()=>({matches:false});for(const source of sources)w.eval(source);
  const toasts=[],calls=[],clipboard=[];w.navigator.clipboard={writeText:async text=>clipboard.push(text),readText:async()=> 'pasted'};
  const surfaces={toast(){const state={};toasts.push(state);return {show(label,options){Object.assign(state,{label,...options});},close(){state.closed=true;}};},inline(){return {show(text,options){toasts.push({text,...options});}};}};
  const actions=w.LakomicsContextActions.createActions({doc,win:w,surfaces,send:async message=>{calls.push(message);return message.type==='translation:context'?{ok:true,text:'Translated'}:{ok:true};}});
  function context() {const field=doc.querySelector('textarea,input,[contenteditable]');field.focus();if(field.matches('textarea,input'))field.setSelectionRange(0,5);else{const range=doc.createRange();range.selectNodeContents(field);w.getSelection().removeAllRanges();w.getSelection().addRange(range);}return w.LakomicsContextModel.snapshot(field,doc,w);}
  return {w,doc,actions,toasts,calls,clipboard,context,close:()=>w.close()};
}
const gesture={isTrusted:true};const origin={x:20,y:30};
test('trusted selection copy invokes navigator clipboard immediately; untrusted actions do nothing',async()=>{
  const f=fixture(),c=f.context();const work=f.actions.activate('edit.copy',c,origin,gesture);assert.deepEqual(f.clipboard,['Hello']);await work;assert.equal(f.toasts[0].label,'복사됨');
  await f.actions.activate('translate.ja.copy',c,origin,{isTrusted:false});assert.equal(f.calls.length,0);f.close();
});
test('cut, paste, select-all and fallback input replacement emit input and preserve remaining text',async()=>{
  for(const [id,expected]of [['edit.cut',' world'],['edit.paste','pasted world']]){
    const f=fixture(),c=f.context(),events=[];c.field.addEventListener('input',event=>events.push({type:event.inputType,bubbles:event.bubbles,data:event.data}));
    await f.actions.activate(id,c,origin,gesture);assert.equal(c.field.value,expected);assert.equal(events.length,1);assert.equal(events[0].bubbles,true);if(id==='edit.cut')assert.deepEqual(f.clipboard,['Hello']);f.close();
  }
  const f=fixture(),c=f.context();await f.actions.activate('edit.selectAll',c,origin,gesture);assert.equal(c.field.selectionEnd,c.field.value.length);f.close();
});
test('execCommand insertion is used for one undo step without duplicating native input events',()=>{
  const f=fixture(),c=f.context();let command;const inputs=[];c.field.addEventListener('input',event=>inputs.push(event));
  f.doc.execCommand=(name,ui,text)=>{command=name;c.field.setRangeText(text,c.start,c.end,'end');c.field.dispatchEvent(new f.w.InputEvent('input',{bubbles:true,data:text,inputType:'insertText'}));return true;};
  assert.equal(f.w.LakomicsContextActions.replace(c,'こんにちは',f.doc,f.w),true);assert.equal(command,'insertText');assert.equal(c.field.value,'こんにちは world');assert.equal(inputs.length,1);f.close();
});
test('contenteditable fallback and select-all work with events; stale/readonly inputs never overwritten',()=>{
  const f=fixture('<div contenteditable="true">Hello</div>'),c=f.context();let inputs=0;c.field.addEventListener('input',()=>inputs++);
  assert.equal(f.w.LakomicsContextActions.replace(c,'日本語',f.doc,f.w),true);assert.equal(c.field.textContent,'日本語');assert.equal(inputs,1);f.w.LakomicsContextActions.selectAll(c,f.doc,f.w);assert.equal(f.w.getSelection().toString(),'日本語');f.close();
  const g=fixture(),old=g.context();old.field.value='User has typed';assert.equal(g.w.LakomicsContextActions.replace(old,'translated',g.doc,g.w),false);assert.equal(old.field.value,'User has typed');old.field.value=old.fieldValue;old.field.readOnly=true;assert.equal(g.w.LakomicsContextActions.replace(old,'x',g.doc,g.w),false);g.close();
});
test('translated copy goes through async background clipboard and replace changes in place without success toast',async()=>{
  const f=fixture(),c=f.context();await f.actions.activate('translate.ja.copy',c,origin,gesture);
  assert.deepEqual(f.calls.map(message=>message.type),['translation:context','context:clipboard']);assert.equal(f.calls[0].kind,'translate.ja.copy');assert.equal(f.toasts.at(-1).label,'일본어로 복사됨');assert.equal(f.toasts.at(-1).preview,'Translated');
  f.toasts.length=0;await f.actions.activate('replace.en',c,origin,gesture);assert.equal(c.field.value,'Translated world');assert.equal(f.toasts.length,0);f.close();
});
test('round-two placeholders show a clear toast, image/link/page calls and navigation dispatch correctly',async()=>{
  const f=fixture(),c=f.context();c.imageUrl='https://site.test/i.png';c.linkUrl='https://site.test/l';
  for(const id of ['image.translate','page.translate']){await f.actions.activate(id,c,origin,gesture);assert.equal(f.toasts.at(-1).label,'다음 업데이트에서 지원');}
  for(const id of ['image.save','image.saveAs','image.openTab','link.saveAs','link.openTab','page.saveAs'])await f.actions.activate(id,c,origin,gesture);
  assert.deepEqual(f.calls.map(call=>call.action),['image.save','image.saveAs','image.openTab','link.saveAs','link.openTab','page.saveAs']);
  await f.actions.activate('image.copyUrl',c,origin,gesture);await f.actions.activate('link.copy',c,origin,gesture);assert.deepEqual(f.clipboard,[c.imageUrl,c.linkUrl]);f.close();
});

function clock(w){let now=0,next=0;const timers=new Map();w.setTimeout=(fn,delay)=>{const id=++next;timers.set(id,{fn,at:now+delay});return id;};w.clearTimeout=id=>timers.delete(id);w.Date.now=()=>now;
  const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};return {now:()=>now,async advance(ms){const end=now+ms;for(;;){await flush();const entry=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;now=entry[1].at;timers.delete(entry[0]);entry[1].fn();}now=end;await flush();}};}
test('busy labels wait 400ms, remain >=600ms, and fast work shows only its final content',async()=>{
  const f=fixture(),timer=clock(f.w);let finish,done=false,labels=[];
  const pending=f.w.LakomicsContextSurfaces.delayed(()=>new Promise(resolve=>finish=resolve),()=>labels.push('번역 중'),{win:f.w,now:timer.now}).then(()=>done=true);
  await timer.advance(399);assert.deepEqual(labels,[]);await timer.advance(1);assert.deepEqual(labels,['번역 중']);finish({ok:true});await timer.advance(599);assert.equal(done,false);await timer.advance(1);await pending;assert.equal(done,true);
  labels=[];const quick=f.w.LakomicsContextSurfaces.delayed(async()=>true,()=>labels.push('busy'),{win:f.w,now:timer.now});await timer.advance(0);await quick;await timer.advance(400);assert.deepEqual(labels,[]);f.close();
});
test('inline result/pending/error/retry/close and toast states render safely in closed Shadow DOM',()=>{
  const f=fixture('<p>Source</p>');clock(f.w);const roots=new Map(),attach=f.w.Element.prototype.attachShadow;
  f.w.Element.prototype.attachShadow=function(options){const root=attach.call(this,options);roots.set(this,root);return root;};
  const surfaces=f.w.LakomicsContextSurfaces.createSurfaces({doc:f.doc,win:f.w}),p=f.doc.querySelector('p'),card=surfaces.inline(p);
  card.show('',{pending:true});let host=p.nextElementSibling;assert.equal(host.shadowRoot,null);assert.equal(roots.get(host).querySelector('.h').textContent,'번역 중');
  card.show('<img onerror="bad">');assert.equal(roots.get(host).querySelector('[lang="ko"]').textContent,'<img onerror="bad">');assert.equal(roots.get(host).querySelector('img'),null);
  card.show('',{pending:true});assert.match(roots.get(host).textContent,/<img onerror/,'refresh keeps the old result');
  let retried=false;card.show('',{error:true,retry:()=>retried=true});assert.equal(roots.get(host).querySelector('.retry').textContent,'다시 시도');roots.get(host).querySelector('.retry').click();assert.equal(retried,false);roots.get(host).querySelector('.x').click();assert.equal(card.closed,true);
  const toast=surfaces.toast(origin,p);toast.show('번역 중',{pending:true});host=f.doc.querySelector('lakomics-toast');assert.equal(roots.get(host).querySelector('.toastA').getAttribute('role'),'status');toast.show('번역 실패',{error:true,retry(){}});assert.equal(roots.get(host).querySelector('.toastA').getAttribute('role'),'alert');toast.show('복사됨',{preview:'hello'});assert.equal(roots.get(host).querySelector('.pv').textContent,'hello');toast.close(0);assert.equal(host.isConnected,false);f.close();
});
test('latest inline request owns its block; stale results and navigation cannot overwrite it',async()=>{
  const f=fixture('<p>Hello</p>'),p=f.doc.querySelector('p'),roots=new Map(),attach=f.w.Element.prototype.attachShadow;
  f.w.Element.prototype.attachShadow=function(options){const root=attach.call(this,options);roots.set(this,root);return root;};
  const range=f.doc.createRange();range.selectNodeContents(p);f.w.getSelection().addRange(range);const c=f.w.LakomicsContextModel.snapshot(p,f.doc,f.w),finishes=[];
  const actions=f.w.LakomicsContextActions.createActions({doc:f.doc,win:f.w,surfaces:f.w.LakomicsContextSurfaces.createSurfaces({doc:f.doc,win:f.w}),send:()=>new Promise(resolve=>finishes.push(resolve)),alive:context=>!context.departed});
  const first=actions.activate('translate.ko.inline',c,origin,gesture),second=actions.activate('translate.ko.inline',c,origin,gesture);
  finishes[1]({ok:true,text:'최신 번역'});await second;finishes[0]({ok:true,text:'오래된 번역'});await first;assert.equal(roots.get(p.nextElementSibling).querySelector('[lang="ko"]').textContent,'최신 번역');
  const third=actions.activate('translate.ko.inline',c,origin,gesture);c.departed=true;finishes[2]({ok:true,text:'다른 페이지 결과'});await third;assert.equal(roots.get(p.nextElementSibling).querySelector('[lang="ko"]').textContent,'최신 번역');f.close();
});
test('cover action uses normalized existing AV send request and image save opens collector adapter',async()=>{
  const f=fixture(),c=f.context();c.text='Title SSIS001';c.candidate={mediaUrl:'https://site.test/image.png'};
  f.w.__LAKOMICS_TEST__=true;f.w.eval(await readFile(new URL('../src/av-lookup.js',import.meta.url),'utf8'));
  let opened;const calls=[];const surfaces={toast(){return {show(){},close(){}};}};
  const actions=f.w.LakomicsContextActions.createActions({doc:f.doc,win:f.w,surfaces,send:async message=>{calls.push(message);return {ok:true};},collector:{open(candidate,point){opened={candidate,point};}}});
  await actions.activate('av.send',c,origin,gesture);assert.equal(calls[0].type,'av-send');assert.equal(calls[0].request.productCode,'SSIS-001');assert.equal(calls[0].request.sourceUrl,'https://example.test/');
  await actions.activate('image.lakomics',c,origin,gesture);assert.equal(opened.candidate,c.candidate);assert.equal(opened.point,origin);f.close();
});
test('a document selection outside the right-clicked editable field can never be cut or replaced',async()=>{
  const f=fixture('<p>Outside</p><div contenteditable="true">Field</div>'),p=f.doc.querySelector('p'),field=f.doc.querySelector('div');
  const range=f.doc.createRange();range.selectNodeContents(p);f.w.getSelection().addRange(range);
  const c=f.w.LakomicsContextModel.snapshot(field,f.doc,f.w);assert.equal(c.text,'');assert.equal(c.range.collapsed,true);
  await f.actions.activate('edit.paste',c,origin,gesture);assert.equal(p.textContent,'Outside');assert.equal(field.textContent,'Fieldpasted');f.close();
});
