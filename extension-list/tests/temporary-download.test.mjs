import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/background.js',import.meta.url),'utf8');
function fixture(fail=false) {
  let listener; const calls=[];
  const ctx=vm.createContext({URL,importScripts(){},chrome:{runtime:{onMessage:{addListener(fn){listener=fn;}}},downloads:{async download(options){calls.push(options); if(fail) throw new Error('denied'); return 42;}}}});
  vm.runInContext(source,ctx);
  return {calls,send:message=>new Promise(resolve=>listener(message,{},resolve))};
}
test('PC temporary image starts a direct download into the browser default location with no overwrite',async()=>{
  const f=fixture(); const result=await f.send({type:'collector:temporary',candidate:{type:'image',mediaUrl:'https://pbs.twimg.com/media/a?format=jpg&name=orig'}});
  assert.equal(result.ok,true); assert.equal(result.status,'download_started'); assert.equal(result.downloadId,42);
  assert.equal(f.calls[0].saveAs,false); assert.equal(f.calls[0].conflictAction,'uniquify'); assert.equal(f.calls[0].filename,undefined);
});
test('unsupported temporary inputs and failed browser downloads are not reported as saved',async()=>{
  const f=fixture(true);
  for(const candidate of [{type:'video',mediaUrl:'https://example.com/a.mp4'},{type:'image',mediaUrl:'file:///tmp/a'},{type:'image',mediaUrl:'https://user:secret@example.com/a.jpg'}]) assert.equal((await f.send({type:'collector:temporary',candidate})).ok,false);
  assert.equal(f.calls.length,0);
  assert.equal((await f.send({type:'collector:temporary',candidate:{type:'image',mediaUrl:'https://example.com/a.jpg'}})).code,'download_failed');
});
