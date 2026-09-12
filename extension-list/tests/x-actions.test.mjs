import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';
const source = await readFile(new URL('../src/x-source.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');
function fixture(body) {
  const dom = new JSDOM(body, {url:'https://x.com/home',runScripts:'outside-only'});
  dom.window.__LAKOMICS_TEST__ = true;
  dom.window.eval(source); dom.window.eval(content);
  return { dom, w:dom.window, x:dom.window.LakomicsXSource, content:dom.window.LakomicsListContent };
}
const quote = '<div data-testid="quoteTweet" role="link"><a href="/inner/status/222"><time datetime="2026-09-13"></time></a><div data-testid="videoPlayer"><div data-testid="video-player-mini-ui-222"><img id="poster" src="https://pbs.twimg.com/ext_tw_video_thumb/999/a.jpg"></div></div></div>';

test('X images carry their source into the save-success auto-like condition', () => {
  const f = fixture('<article data-testid="tweet"><a href="/user/status/111"><time></time></a><img id="image" src="https://pbs.twimg.com/media/a.jpg"><button data-testid="like"></button></article>');
  const candidate = f.x.findCandidate(f.w.document.querySelector('#image'));
  assert.equal(candidate.source, 'x'); assert.equal(f.content.plainCandidate(candidate).source, 'x'); f.w.close();
});

test('quoted video poster is collectable before X creates a video element', () => {
  const f = fixture(`<article data-testid="tweet"><a href="/outer/status/111"><time></time></a>${quote}<button data-testid="like"></button></article>`);
  const candidate = f.x.findCandidate(f.w.document.querySelector('#poster'));
  assert.equal(candidate.type, 'video'); assert.equal(candidate.postId, '222'); assert.equal(candidate.sourceUrl, 'https://x.com/inner/status/222/video/1');
  assert.equal(candidate.publishedAt, '2026-09-13'); assert.equal(f.content.findTweetArticle(f.w.document, '222'), null); f.w.close();
});

test('quote player identity wins and a missing quote identity never uses the outer tweet', () => {
  for (const marker of ['<div data-testid="video-player-mini-ui-222"></div>', '']) {
    const f = fixture(`<article data-testid="tweet"><a href="/outer/status/111"><time></time></a><div role="link"><div data-testid="videoPlayer">${marker}<video id="video"></video></div></div></article>`);
    const candidate = f.x.findCandidate(f.w.document.querySelector('#video'));
    if (marker) assert.equal(candidate.postId, '222'); else assert.equal(candidate, null);
    f.w.close();
  }
});

test('quote save likes exactly the quoted post through the session fallback', async () => {
  const f = fixture(`<article data-testid="tweet"><a href="/outer/status/111"><time></time></a>${quote}<button data-testid="like"></button></article>`);
  let clicks = 0, body;
  f.w.document.querySelector('button').onclick = () => clicks++;
  const result = await f.content.autoLikePost({postId:'222',cookieString:'ct0=fixture',fetchFn:async (_url, init) => { body=JSON.parse(init.body); return {ok:true,json:async()=>({data:{favorite_tweet:'Done'}})}; }});
  assert.equal(result.ok,true); assert.equal(clicks,0); assert.equal(body.variables.tweet_id,'222'); f.w.close();
});

test('already-liked posts never toggle unlike or send a fallback request', async () => {
  const f = fixture('<article data-testid="tweet"><a href="/user/status/111"><time></time></a><button data-testid="unlike"></button></article>');
  f.w.document.querySelector('button').onclick = () => assert.fail('unlike clicked');
  const result = await f.content.autoLikePost({postId:'111',fetchFn:()=>assert.fail('API called')});
  assert.equal(result.status,'already_liked'); f.w.close();
});

test('quote poster long press suppresses native context and successful save reaches the exact auto-like target', async () => {
  const dom = new JSDOM(`<article data-testid="tweet"><a href="/outer/status/111"><time></time></a>${quote}<button data-testid="like"></button></article><article data-testid="tweet"><a href="/inner/status/222"><time></time></a><button id="inner-like" data-testid="like"></button></article>`, {url:'https://x.com/home',runScripts:'outside-only'});
  const w=dom.window, requests=[]; let mounted, clicks=0, saveOk=false;
  w.chrome={runtime:{sendMessage(message,callback){requests.push(message); callback(message.type==='collector:save'?{ok:saveOk,status:'captured'}:{ok:true,state:{classifications:{entries:[{id:'games',name:'게임'}]},profile:{preferences:{}}}});}}};
  w.LakomicsClassificationTree={createModel:()=>({path:()=>[{name:'게임'}]})};
  w.LakomicsArcCollector={mount(options){mounted=options; return {host:w.document.createElement('div'),unlockInput(){}};}};
  w.eval(source); w.eval(content);
  w.document.querySelector('#inner-like').onclick=event=>{clicks++;event.currentTarget.dataset.testid='unlike';};
  const poster=w.document.querySelector('#poster');
  const pointer=type=>{const event=new w.MouseEvent(type,{bubbles:true,cancelable:true,clientX:30,clientY:40});Object.defineProperties(event,{pointerType:{value:'touch'},pointerId:{value:1}});poster.dispatchEvent(event);return event;};
  pointer('pointerdown');
  const context=new w.MouseEvent('contextmenu',{bubbles:true,cancelable:true});poster.dispatchEvent(context);assert.equal(context.defaultPrevented,true);
  await new Promise(resolve=>setTimeout(resolve,550)); assert.ok(mounted); pointer('pointerup');
  assert.equal((await mounted.onSave('games')).ok,false); assert.equal(clicks,0);
  saveOk=true; const result=await mounted.onSave('games');
  assert.equal(result.ok,true); assert.match(result.message,/좋아요 완료/); assert.equal(clicks,1);
  assert.equal(requests.find(message=>message.type==='collector:save').payload.candidate.postId,'222');
  assert.equal(w.document.querySelector('article button').dataset.testid,'like'); w.close();
});
