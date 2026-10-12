import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/context-menu/background.js',import.meta.url),'utf8');
const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
const offscreenSource=await readFile(new URL('../src/context-menu/offscreen.js',import.meta.url),'utf8');
const sender={id:'fixture',url:'https://example.test/page',tab:{id:7,index:3,title:'A page'}};
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture({downloadError=false,contexts=[]}={}){
  const downloads=[],tabs=[],offscreen=[],messages=[],captures=[];let changed;
  const ctx={URL,Uint8Array,btoa,chrome:{runtime:{id:'fixture',getURL:path=>'chrome-extension://fixture/'+path,getContexts:async()=>contexts,sendMessage(message,callback){messages.push(message);callback(message.operation==='blob'?{ok:true,url:'blob:chrome-extension://fixture/id'}:{ok:true});}},offscreen:{createDocument:async value=>{offscreen.push(value);contexts=[{}];}},downloads:{download(value,callback){downloads.push(value);ctx.chrome.runtime.lastError=downloadError?{message:'cancelled'}:null;callback(downloadError?undefined:downloads.length);ctx.chrome.runtime.lastError=null;},onChanged:{addListener(fn){changed=fn;}}},pageCapture:{saveAsMHTML(value,callback){captures.push(value);callback(new Blob(['MIME page data']));}},tabs:{create:async value=>tabs.push(value)}}};
  vm.runInNewContext(source,ctx);return {handle:(message,who=sender)=>ctx.LakomicsContextBackground.handle(message,who),api:ctx.LakomicsContextBackground,downloads,tabs,offscreen,messages,captures,change:value=>changed(value)};
}
test('HTTP and child-frame senders are accepted, frame page capture is rejected',async()=>{
  const f=fixture(), message={type:'context:action',action:'link.openTab',url:'http://site.test/file'};
  for(const who of [{...sender,url:'http://example.test/'},{...sender,frameId:2,url:'https://frame.test/'},{...sender,frameId:2,url:'about:srcdoc',origin:'https://frame.test',tab:{...sender.tab,url:'https://example.test/'}},{...sender,frameId:2,url:'about:blank',origin:'http://frame.test',tab:{...sender.tab,url:'http://example.test/'}}]) assert.equal((await f.handle(message,who)).ok,true);
  assert.equal((await f.handle(message,{...sender,url:'file:///page.html'})).code,'forbidden_sender');
  assert.equal((await f.handle({type:'context:action',action:'page.saveAs'},{...sender,frameId:2})).code,'top_frame_only');
  assert.equal(f.captures.length,0);
});
test('downloads saveAs flags, adjacent link/image tabs, and URLs are constrained',async()=>{
  const f=fixture();for(const action of ['image.save','image.saveAs','link.saveAs'])assert.equal((await f.handle({type:'context:action',action,url:'https://site.test/file'})).ok,true);
  assert.deepEqual(f.downloads.map(value=>value.saveAs),[false,true,true]);
  for(const action of ['link.openTab','image.openTab'])await f.handle({type:'context:action',action,url:'https://site.test/file'});
  assert.deepEqual(plain(f.tabs[0]),{url:'https://site.test/file',index:4,openerTabId:7});
  for(const url of ['javascript:alert(1)','file:///c:/test','https://user:pass@example.test'])assert.equal((await f.handle({type:'context:action',action:'link.openTab',url})).code,'invalid_url');
  assert.equal((await f.handle({type:'context:action',action:'image.saveAs',url:'https://site.test'},{...sender,id:'other'})).code,'forbidden_sender');
  for(const url of ['data:image/png;base64,AA==','blob:https://example.test/image'])assert.equal((await f.handle({type:'context:action',action:'image.saveAs',url})).ok,true);
  for(const url of ['data:text/html,unsafe','blob:https://other.test/image'])assert.equal((await f.handle({type:'context:action',action:'image.openTab',url})).code,'invalid_url');
});
test('page capture uses sender tab, sanitised title and saveAs, then revokes the blob URL',async()=>{
  const f=fixture();const result=await f.handle({type:'context:action',action:'page.saveAs',title:'CON:/unsafe\\title?'});assert.equal(result.ok,true);
  assert.deepEqual(plain(f.captures),[{tabId:7}]);assert.equal(f.downloads[0].saveAs,true);assert.equal(f.downloads[0].filename,'CON__unsafe_title_.mhtml');assert.equal(f.downloads[0].url,'blob:chrome-extension://fixture/id');
  f.change({id:1,state:{current:'complete'}});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.messages.at(-1).operation,'revoke');
  assert.equal(f.api.filename('CON'),'_CON.mhtml');assert.equal(f.api.filename(' ... '),'page.mhtml');assert.equal(f.api.filename('a\u0000b.'),'a_b.mhtml');
});
test('async clipboard uses a single offscreen document, validates senders and never touches page clipboard',async()=>{
  const f=fixture();await Promise.all([f.handle({type:'context:clipboard',text:'日本語'}),f.handle({type:'context:clipboard',text:'English'})]);assert.equal(f.offscreen.length,1);assert.deepEqual(plain(f.offscreen[0].reasons),['CLIPBOARD','BLOBS']);assert.deepEqual(f.messages.map(value=>value.text),['日本語','English']);
  assert.equal((await f.handle({type:'context:clipboard',text:'hi'},{})).code,'forbidden_sender');assert.equal((await f.handle({type:'context:clipboard',text:'x'.repeat(40001)})).code,'invalid_text');
  await f.handle({type:'context:settings'});assert.equal(f.tabs[0].url,'chrome-extension://fixture/options/options.html#translation-section');
});
test('capture download cancellation revokes URL and download failures remain explicit',async()=>{
  const f=fixture({downloadError:true});assert.equal((await f.handle({type:'context:action',action:'page.saveAs',title:'test'})).code,'browser_action_failed');assert.equal(f.messages.at(-1).operation,'revoke');
});
test('approved clipboard, capture and offscreen permissions with isolated classic collector bundles',()=>{
  for(const permission of ['clipboardRead','clipboardWrite','pageCapture','offscreen'])assert.ok(manifest.permissions.includes(permission));
  for(const bundle of manifest.content_scripts.filter(entry=>entry.js?.includes('src/content.js'))){assert.notEqual(bundle.world,'MAIN');for(const file of ['model','surfaces','actions','menu'])assert.ok(bundle.js.includes(`src/context-menu/${file}.js`));assert.ok(bundle.js.indexOf('src/context-menu/menu.js')<bundle.js.indexOf('src/content.js'));}
  assert.deepEqual(manifest.web_accessible_resources,[{resources:['src/context-menu/menu.css'],matches:['https://*/*','http://*/*']}]);
});
test('offscreen writes clipboard with execCommand, rejects page senders and owns blob cleanup',()=>{
  let listener,copied,removed=false,revoked=[];const elements=[];
  const ctx={Uint8Array,Blob,atob,setTimeout:()=>1,clearTimeout(){},URL:{createObjectURL:()=> 'blob:extension/page',revokeObjectURL:url=>revoked.push(url)},document:{body:{append:node=>elements.push(node)},createElement:()=>({value:'',select(){},remove(){removed=true;}}),execCommand:command=>{copied={command,text:elements.at(-1).value};return true;}},chrome:{runtime:{id:'fixture',onMessage:{addListener(fn){listener=fn;}}}}};
  vm.runInNewContext(offscreenSource,ctx);const dispatch=(message,sender={id:'fixture'})=>{let result;listener({type:'context:offscreen',...message},sender,value=>result=value);return result;};
  assert.equal(dispatch({operation:'clipboard',text:'日本語'}).ok,true);assert.deepEqual(copied,{command:'copy',text:'日本語'});assert.equal(removed,true);
  assert.equal(dispatch({operation:'clipboard',text:'bad'},{id:'fixture',tab:{id:1}}).code,'forbidden_sender');assert.equal(copied.text,'日本語');
  assert.equal(dispatch({operation:'blob',base64:'YWJj'}).url,'blob:extension/page');assert.equal(dispatch({operation:'revoke',url:'blob:extension/page'}).ok,true);assert.deepEqual(revoked,['blob:extension/page']);
});
