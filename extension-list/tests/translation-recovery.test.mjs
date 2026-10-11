import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from '../../_tools/app/node_modules/jsdom/lib/api.js';
const content=readFileSync(new URL('../src/x-translate.js',import.meta.url),'utf8');
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

function mount(texts, handler, concurrency=2) {
  const dom=new JSDOM(texts.map(text=>`<article><div data-testid="tweetText" lang="en">${text}</div></article>`).join(''),{url:'https://x.com/home',runScripts:'outside-only'});
  const w=dom.window, clock=fakeTimers(w), elements=[...w.document.querySelectorAll('[data-testid="tweetText"]')];
  const positions=texts.map((_,i)=>100+i*100), messages=[], observers=[];
  for(const [i,el] of elements.entries()) el.getBoundingClientRect=()=>({width:300,height:60,top:positions[i],bottom:positions[i]+60});
  let changed;
  w.IntersectionObserver=class { constructor(cb,options){this.cb=cb;this.options=options;observers.push(this);} observe(){} unobserve(){} disconnect(){} };
  w.chrome={runtime:{sendMessage(message,callback){
    if(message.type==='translation:settings') { callback({ok:true,enabled:true,hasApiKey:true,concurrency}); return; }
    messages.push(message); handler(message,callback,w);
  }},storage:{onChanged:{addListener(fn){changed=fn;}}}};
  w.eval(content);
  const scroll=(y)=>{w.scrollY=y;w.dispatchEvent(new w.Event('scroll'));};
  const reply=(message,callback,text='번역됨')=>callback(message.items?{ok:true,items:message.items.map(item=>({id:item.id,ok:true,text}))}:{ok:true,text});
  return {w,clock,elements,positions,messages,observers,scroll,reply,changed:()=>changed({'lakomics:translation:v1':{}},'local'),close:()=>w.close()};
}
const card=el=>el.parentElement.querySelector('.lakomics-translation');

test('a delayed busy callback from a reset cannot show the newer request early',async()=>{
  const f=mount(['Timer ownership'],()=>{});
  await f.clock.advance(100); f.changed(); await f.clock.advance(300);
  assert.equal(card(f.elements[0]),null,'old request timer must not label the new request');
  await f.clock.advance(100); assert.equal(card(f.elements[0]).dataset.state,'pending'); f.close();
});

test('out-of-order settings responses do not restore an older enabled epoch',async()=>{
  const f=mount(['Settings race'],(m,cb)=>cb({ok:true,text:'번역됨'}));
  await f.clock.advance(10);
  const settings=[], original=f.w.chrome.runtime.sendMessage;
  f.w.chrome.runtime.sendMessage=(m,cb)=>m.type==='translation:settings'?settings.push(cb):original(m,cb);
  f.changed(); f.changed();
  settings[1]({ok:true,enabled:false,hasApiKey:true}); await f.clock.advance(10);
  settings[0]({ok:true,enabled:true,hasApiKey:true}); await f.clock.advance(500);
  assert.equal(card(f.elements[0]),null); assert.equal(f.messages.length,1); f.close();
});

test('true viewport re-entry retries a parked transient failure inside the larger prefetch window',async()=>{
  const f=mount(['Reenter visible'],(m,cb)=>cb({ok:false,code:'network_error'}));
  await f.clock.advance(21000); assert.equal(f.messages.length,3);
  f.positions[0]=1000; f.scroll(100); await f.clock.advance(60);
  f.positions[0]=100; f.scroll(0); await f.clock.advance(60);
  assert.equal(f.messages.length,4,'does not require leaving the IO prefetch margin'); f.close();
});

test('pending age includes the fallback wait and a fallback watchdog leaves a retryable card',async()=>{
  const calls=[];
  const f=mount(['Fast lane','Fallback post','Other batch'],(m,cb)=>calls.push({m,cb}),1);
  f.positions.splice(0,3,350,100,200);
  await f.clock.advance(10); f.reply(calls[0].m,calls[0].cb); await f.clock.advance(10);
  await f.clock.advance(39000);
  const batch=calls[1];
  batch.cb({ok:true,items:batch.m.items.map(item=>({id:item.id,ok:false,code:'invalid_translation'}))});
  await f.clock.advance(10); assert.equal(calls[2].m.fallback,true);
  await f.clock.advance(4100);
  assert.equal(f.w.document.querySelectorAll('[data-state="pending"]').length,0);
  assert.equal(f.w.document.querySelectorAll('.lakomics-translation-retry').length,2);
  calls[2].cb({ok:true,text:'Expired fallback'}); await f.clock.advance(10);
  assert.equal(f.w.document.querySelectorAll('.lakomics-translation-retry').length,2); f.close();
});

test('auth rejection settles every pending card including another outstanding slot',async()=>{
  for(const code of ['http_401','http_402','http_403','api_key_missing']) {
    const callbacks=[];
    const f=mount(['First pending post','Second pending post'],(m,cb)=>callbacks.push(cb));
    await f.clock.advance(500);
    assert.equal(f.w.document.querySelectorAll('[data-state="pending"]').length,2);
    callbacks[0]({ok:false,code}); await f.clock.advance(10);
    assert.equal(f.w.document.querySelectorAll('[data-state="pending"]').length,0);
    assert.equal(f.w.document.querySelectorAll('.lakomics-translation-retry').length,2);
    callbacks[1]({ok:true,text:'Late translation'}); await f.clock.advance(100);
    assert.equal(f.w.document.querySelectorAll('[data-error="true"]').length,2); f.close();
  }
});

test('channel close, lastError, undefined response, synchronous throws and disabled all leave retryable states',async()=>{
  for(const mode of ['undefined','lastError','throw','disabled','bad-items','bad-text']) {
    const f=mount(['Channel failure post'],(m,cb,w)=>{
      if(mode==='throw') throw new Error('Extension context invalidated');
      if(mode==='lastError') { w.chrome.runtime.lastError={message:'The message port closed'}; cb(); delete w.chrome.runtime.lastError; }
      else cb(mode==='undefined'?undefined:mode==='disabled'?{ok:false,code:'disabled'}:mode==='bad-items'?{ok:true,items:{}}:{ok:true,text:{}});
    });
    await f.clock.advance(500);
    assert.equal(f.w.document.querySelector('[data-state="pending"]'),null,mode);
    assert.ok(f.w.document.querySelector('.lakomics-translation-retry'),mode); f.close();
  }
});

test('watchdog expires lost replies, ignores late answers and retries automatically',async()=>{
  const callbacks=[];
  const f=mount(['Lost worker response'],(m,cb)=>callbacks.push({m,cb}));
  await f.clock.advance(500); assert.equal(card(f.elements[0]).dataset.state,'pending');
  await f.clock.advance(42500); assert.equal(card(f.elements[0]).dataset.error,'true');
  callbacks[0].cb({ok:true,text:'Expired answer'}); await f.clock.advance(100);
  assert.notEqual(card(f.elements[0]).textContent,'Expired answer');
  await f.clock.advance(4100); assert.equal(callbacks.length,2);
  f.reply(callbacks[1].m,callbacks[1].cb,'복구 완료'); await f.clock.advance(10);
  assert.equal(card(f.elements[0]).textContent,'복구 완료'); f.close();
});

test('recycled text is requeued on response without depending on a mutation delivery',async()=>{
  const callbacks=[];
  const f=mount(['Old source post'],(m,cb)=>callbacks.push({m,cb}));
  await f.clock.advance(500);
  f.elements[0].textContent='New recycled source';
  callbacks[0].cb({ok:true,text:'Stale answer'}); await f.clock.advance(100);
  assert.equal(callbacks.length,2); assert.notEqual(card(f.elements[0])?.textContent,'번역 중…');
  f.reply(callbacks[1].m,callbacks[1].cb,'새 글 번역'); await f.clock.advance(20);
  assert.equal(card(f.elements[0]).textContent,'새 글 번역'); f.close();
});

test('recycled text whose old worker never answers recovers at the watchdog',async()=>{
  const callbacks=[];
  const f=mount(['Old lost source'],(m,cb)=>callbacks.push({m,cb}));
  await f.clock.advance(500); f.elements[0].textContent='New lost source';
  await f.clock.advance(43000);
  assert.equal(callbacks.length,2);
  f.reply(callbacks[1].m,callbacks[1].cb,'재사용 복구'); await f.clock.advance(20);
  assert.equal(card(f.elements[0]).textContent,'재사용 복구'); f.close();
});

test('reset followed by an old response cannot clear ownership of the new request',async()=>{
  const callbacks=[];
  const f=mount(['Epoch post'],(m,cb)=>callbacks.push({m,cb}));
  await f.clock.advance(500); f.changed(); await f.clock.advance(20);
  assert.equal(callbacks.length,2);
  callbacks[0].cb({ok:true,text:'Old epoch'}); await f.clock.advance(500);
  assert.equal(card(f.elements[0]).dataset.state,'pending');
  assert.equal(callbacks.length,2);
  f.reply(callbacks[1].m,callbacks[1].cb,'새 설정 번역'); await f.clock.advance(20);
  assert.equal(card(f.elements[0]).textContent,'새 설정 번역'); f.close();
});

test('a detached pending node is cleaned and reattachment is eligible for translation',async()=>{
  const callbacks=[];
  const f=mount(['Detached post'],(m,cb)=>callbacks.push({m,cb}));
  await f.clock.advance(500); const article=f.elements[0].parentElement; article.remove();
  await f.clock.advance(400); assert.equal(article.querySelector('.lakomics-translation'),null);
  callbacks[0].cb({ok:true,text:'Detached answer'}); await f.clock.advance(20);
  f.w.document.body.append(article); await f.clock.advance(400);
  assert.equal(callbacks.length,2); f.reply(callbacks[1].m,callbacks[1].cb); await f.clock.advance(20);
  assert.equal(card(f.elements[0]).textContent,'번역됨'); f.close();
});

test('quality replaces only text and links in place, keeping original folding and displayed content while waiting',async()=>{
  let quality;
  const f=mount(['Hello <a href="https://x.com/hashtag/test">#test</a>'],(m,cb)=>{
    if(m.type==='translation:quality') {quality=cb;return;}
    cb({ok:true,text:'한국어 字 [[LINK_0]]',qualityRetry:true});
  });
  await f.clock.advance(50);
  const node=card(f.elements[0]), toggle=f.elements[0].parentElement.querySelector('button');
  toggle.click(); assert.equal(f.elements[0].dataset.lakomicsCollapsed,'false');
  await f.clock.advance(1000); assert.equal(node.textContent,'한국어 字 #test');
  quality({ok:true,text:'한국어 글 [[LINK_0]]'}); await f.clock.advance(20);
  assert.equal(card(f.elements[0]),node); assert.equal(node.textContent,'한국어 글 #test');
  assert.equal(f.elements[0].parentElement.querySelector('button'),toggle);
  assert.equal(f.elements[0].dataset.lakomicsCollapsed,'false');
  assert.equal(node.querySelector('a').href,'https://x.com/hashtag/test'); f.close();
});

test('busy label starts at 400ms and a faster result never creates a pending card',async()=>{
  let done;
  const f=mount(['Delayed label'],(m,cb)=>done=cb);
  await f.clock.advance(399); assert.equal(card(f.elements[0]),null);
  await f.clock.advance(1); assert.equal(card(f.elements[0]).dataset.state,'pending');
  done({ok:true,text:'번역'}); await f.clock.advance(1); assert.equal(card(f.elements[0]).textContent,'번역'); f.close();
  const g=mount(['Fast label'],(m,cb,w)=>w.setTimeout(()=>cb({ok:true,text:'빠른 번역'}),399));
  await g.clock.advance(400); assert.equal(card(g.elements[0]).textContent,'빠른 번역');
  assert.equal(g.w.document.querySelector('[data-state="pending"]'),null); g.close();
});

test('visible centre wins, then ahead of scrolling, then behind; visible batches stay small',async()=>{
  const sent=[];
  const f=mount(['Behind','Ahead','Visible edge','Visible centre','Visible other'],(m,cb)=>sent.push({m,cb}),1);
  f.positions.splice(0,5,-100,900,20,350,600);
  await f.clock.advance(10); assert.equal(sent[0].m.text,'Visible centre');
  f.reply(sent[0].m,sent[0].cb); await f.clock.advance(10);
  assert.deepEqual(Array.from(sent[1].m.items,item=>item.text),['Visible other','Visible edge']);
  f.reply(sent[1].m,sent[1].cb); await f.clock.advance(10);
  assert.equal(sent[2].m.items[0].text,'Ahead');
  f.reply(sent[2].m,sent[2].cb); await f.clock.advance(10);
  assert.equal(sent[3].m.items[0].text,'Behind'); f.close();
});

test('scroll drops queued posts far behind, keeps in-flight work and requeues on return',async()=>{
  const sent=[];
  const f=mount(['In flight','Queued behind','Upcoming'],(m,cb)=>sent.push({m,cb}),1);
  f.positions.splice(0,3,350,500,2200);
  await f.clock.advance(10); assert.equal(sent[0].m.text,'In flight');
  f.positions[1]=-2000; f.scroll(2000); await f.clock.advance(60);
  f.reply(sent[0].m,sent[0].cb); await f.clock.advance(10);
  assert.equal(card(f.elements[0]).textContent,'번역됨','in-flight response stays valid');
  assert.deepEqual(Array.from(sent[1].m.items,item=>item.text),['Upcoming']);
  f.reply(sent[1].m,sent[1].cb); await f.clock.advance(10);
  assert.equal(sent.length,2);
  f.positions[1]=350; f.scroll(0); await f.clock.advance(60);
  assert.equal(sent[2].m.text,'Queued behind'); f.close();
});

test('direction-aware prefetch uses three screens ahead and a quarter behind, including on reverse scroll',async()=>{
  const sent=[];
  const f=mount(['Seed','Down far','Up far','Too far'],(m,cb)=>sent.push({m,cb}),1);
  const h=f.w.innerHeight;
  f.positions.splice(0,4,350,3.5*h,-2.5*h,4.1*h);
  await f.clock.advance(10);
  assert.equal(f.observers.at(-1).options.rootMargin,`${h*.25}px 0px ${h*3}px 0px`);
  f.reply(sent[0].m,sent[0].cb); await f.clock.advance(10);
  assert.deepEqual(Array.from(sent[1].m.items,item=>item.text),['Down far']);
  f.reply(sent[1].m,sent[1].cb); await f.clock.advance(10); assert.equal(sent.length,2);
  f.scroll(100); await f.clock.advance(60); f.scroll(0); await f.clock.advance(60);
  assert.equal(f.observers.at(-1).options.rootMargin,`${h*3}px 0px ${h*.25}px 0px`);
  assert.deepEqual(Array.from(sent[2].m.items,item=>item.text),['Up far']); f.close();
});
