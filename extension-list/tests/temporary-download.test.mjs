import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/background.js',import.meta.url),'utf8');
function fixture(fail=false) {
  let listener; const calls=[];
  const runtime={onMessage:{addListener(fn){listener=fn;}}};
  const ctx=vm.createContext({URL,importScripts(){},chrome:{runtime,downloads:{download(options,callback){calls.push(options); queueMicrotask(()=>{if(fail) runtime.lastError={message:'denied'}; callback(fail?undefined:42); delete runtime.lastError;}); return Promise.resolve(undefined);}}}});
  vm.runInContext(source,ctx);
  return {calls,send:message=>new Promise(resolve=>listener(message,{},resolve))};
}
function callbackFixture() {
  let listener; const calls=[];
  const ctx=vm.createContext({URL,importScripts(){},chrome:{runtime:{onMessage:{addListener(fn){listener=fn;}}},downloads:{download(options,callback){calls.push(options); if(typeof callback!=='function') throw new TypeError('No matching signature'); callback(42);}}}});
  vm.runInContext(source,ctx);
  return {calls,send:message=>new Promise(resolve=>listener(message,{},resolve))};
}
test('PC temporary image starts a direct download into the browser default location with no overwrite',async()=>{
  const f=fixture(); const result=await f.send({type:'collector:temporary',candidate:{type:'image',mediaUrl:'https://pbs.twimg.com/media/a?format=jpg&name=orig'}});
  assert.equal(result.ok,true); assert.equal(result.status,'download_started'); assert.equal(result.downloadId,42);
  assert.equal(f.calls[0].saveAs,false); assert.equal(f.calls[0].conflictAction,'uniquify'); assert.equal(f.calls[0].filename,undefined);
});
test('PC temporary image supports callback-only Chromium downloads APIs',async()=>{
  const f=callbackFixture(); const result=await f.send({type:'collector:temporary',candidate:{type:'image',mediaUrl:'https://pbs.twimg.com/media/a?format=jpg&name=orig'}});
  assert.equal(result.ok,true); assert.equal(result.downloadId,42); assert.equal(f.calls.length,1);
});
test('unsupported temporary inputs and failed browser downloads are not reported as saved',async()=>{
  const f=fixture(true);
  for(const candidate of [{type:'video',mediaUrl:'https://example.com/a.mp4'},{type:'image',mediaUrl:'file:///tmp/a'},{type:'image',mediaUrl:'https://user:secret@example.com/a.jpg'}]) assert.equal((await f.send({type:'collector:temporary',candidate})).ok,false);
  assert.equal(f.calls.length,0);
  assert.equal((await f.send({type:'collector:temporary',candidate:{type:'image',mediaUrl:'https://example.com/a.jpg'}})).code,'download_failed');
});
test('browser download errors retain a useful reason without exposing URLs or credentials',async()=>{
  let listener; const runtime={onMessage:{addListener(fn){listener=fn;}}};
  const ctx=vm.createContext({URL,importScripts(){},chrome:{runtime,downloads:{download(_options,callback){runtime.lastError={message:'Invalid URL https://user:secret@example.com/a.jpg?token=private-value'}; callback(); delete runtime.lastError;}}}});
  vm.runInContext(source,ctx);
  const result=await new Promise(resolve=>listener({type:'collector:temporary',candidate:{type:'image',mediaUrl:'https://example.com/a.jpg'}},{},resolve));
  assert.equal(result.code,'download_failed'); assert.equal(result.browserMessage,'Invalid URL [URL]');
  assert.equal(JSON.stringify(result).includes('secret'),false); assert.equal(JSON.stringify(result).includes('private-value'),false);
});
