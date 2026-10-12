import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';
const names = ['model','surfaces','actions','menu'];
const sources = await Promise.all(names.map(name => readFile(new URL(`../src/context-menu/${name}.js`, import.meta.url), 'utf8')));
const lookup = await readFile(new URL('../src/av-lookup.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/context-menu/menu.css', import.meta.url), 'utf8');
function fixture(html = '<p id="p">Hello world</p>') {
  const dom = new JSDOM(html, { url:'https://example.test/', runScripts:'outside-only', pretendToBeVisual:true });
  const w = dom.window; w.matchMedia = () => ({matches:false});
  w.navigator.clipboard = {writeText: async () => {}}; w.__LAKOMICS_TEST__ = true; w.eval(lookup); for (const source of sources) w.eval(source);
  return {w,doc:w.document,model:w.LakomicsContextModel,close:()=>w.close()};
}
const plain = value => JSON.parse(JSON.stringify(value));
test('media contexts resolve nearby players and hide blob addresses', () => {
  const f = fixture('<div class="player"><video src="https://media.test/video.mp4" poster="https://media.test/poster.png"></video><span id="overlay"></span></div><audio src="https://media.test/audio.mp3"></audio>');
  const c = f.model.snapshot(f.doc.getElementById('overlay'), f.doc, f.w);
  assert.equal(c.mediaType, 'video'); assert.equal(c.imageUrl, '');
  assert.deepEqual(list(f,c).map(row => row.id), ['media.copyUrl','media.poster','media.frame.save','media.frame.lakomics']);
  assert.equal(list(f,f.model.snapshot(f.doc.querySelector('audio'),f.doc,f.w))[0].label,'오디오 주소 복사');
  Object.defineProperty(c.media,'currentSrc',{value:'blob:https://example.test/stream'});
  assert.equal(list(f,f.model.snapshot(c.media,f.doc,f.w)).some(row => row.id === 'media.copyUrl'),false);
  const elsewhere = f.doc.createElement('span'); f.doc.body.append(elsewhere);
  assert.equal(f.model.mediaAt(elsewhere),null); f.close();
});
test('overlay media lookup chooses the nearest media and stays within its depth/count bounds', () => {
  const f=fixture('<div class="player"><video id="far"></video><video id="near"></video><span id="overlay"></span></div>');
  const target=f.doc.getElementById('overlay');
  target.getBoundingClientRect=()=>({left:90,top:0,width:10,height:10});
  f.doc.getElementById('far').getBoundingClientRect=()=>({left:0,right:10,top:0,bottom:10});
  f.doc.getElementById('near').getBoundingClientRect=()=>({left:80,right:100,top:0,bottom:20});
  assert.equal(f.model.mediaAt(target).id,'near');
  for(let i=0;i<7;i++) target.parentElement.append(f.doc.createElement('video'));
  assert.equal(f.model.mediaAt(target),null);f.close();
});
test('frames use the outermost ancestor host and hide whole-tab page save', () => {
  const f=fixture();
  const win={location:{hostname:'frame.test',ancestorOrigins:['https://middle.test','http://excluded.test']},get top(){throw Error('cross origin');}};
  assert.equal(f.model.topHostname(win),'excluded.test');
  assert.equal(Boolean(f.model.bypass({isTrusted:true},{hostname:f.model.topHostname(win),excludedHosts:['excluded.test']})),true);
  assert.equal(f.model.items({}, {inFrame:true}).some(row=>row.id==='page.saveAs'),false);
  assert.equal(f.model.items({linkUrl:'http://example.test'}, {clipboard:false}).some(row=>row.id==='link.copy'),false); f.close();
});
test('trusted touch entry opens one menu and respects exclusions', () => {
  const f=fixture('<a href="https://example.test/link">Link</a>'), target=f.doc.querySelector('a');
  const controller=f.w.LakomicsContextMenu.createController({doc:f.doc,win:f.w,css,send:async()=>({ok:true})});
  assert.equal(controller.openTouch(trusted(target,{pointerType:'touch',button:0})),true);
  assert.equal(controller.current.surface.node.dataset.touch,'true');
  controller.openTouch(trusted(target,{pointerType:'touch',button:0}));
  assert.equal(f.doc.querySelectorAll('lakomics-menu').length,1);
  controller.update({excludedHosts:['example.test']});
  assert.equal(controller.openTouch(trusted(target,{pointerType:'touch',button:0})),false);
  controller.destroy();f.close();
});
test('frame controller mounts within its document, hides page save, and uses top-host exclusions', () => {
  const f=fixture('<iframe></iframe>'),win=f.doc.querySelector('iframe').contentWindow,doc=win.document;
  const controller=f.w.LakomicsContextMenu.createController({doc,win,css,send:async()=>({ok:true})});
  assert.equal(controller.open(trusted(doc.body)),true);
  assert.equal(doc.querySelectorAll('lakomics-menu').length,1);assert.equal(f.doc.querySelectorAll('lakomics-menu').length,0);
  assert.equal(controller.current.items.some(item=>item.id==='page.saveAs'),false);
  controller.update({excludedHosts:['example.test']});assert.equal(controller.open(trusted(doc.body)),false);
  controller.destroy();f.close();
});
const trusted = (target, extra = {}) => ({target,isTrusted:true,button:2,clientX:20,clientY:30,preventDefault(){this.defaultPrevented=true;},stopPropagation(){},composedPath(){return [target];},...extra});
function selected(f, element, start = 0, end = element.textContent.length) {
  const range = f.doc.createRange(); range.setStart(element.firstChild,start); range.setEnd(element.firstChild,end); f.w.getSelection().removeAllRanges(); f.w.getSelection().addRange(range); return range;
}
function list(f,c) { return plain(f.model.items(c,{hasApiKey:true,href:f.w.location.href})).filter(item=>!item.separator); }

test('selection lists translation, then a single recognized cover send, then the browser copy group; no Google item and copy is not forced to the top',()=>{
  const f=fixture('<p>Hello SSIS001</p>'); const p=f.doc.querySelector('p'); selected(f,p);
  const items=list(f,f.model.snapshot(p,f.doc,f.w));
  assert.deepEqual(items.map(item=>item.id),['translate.ko.inline','translate.ja.copy','translate.en.copy','av.send','edit.copy']);
  const cover=items.find(item=>item.id==='av.send'); assert.equal(cover.label,'표지 찾기:'); assert.equal(cover.quote,'SSIS-001');
  assert.equal(items.some(item=>/Google|av.lookup/.test(item.label+item.id)),false);
  p.textContent='한국어 문장'; selected(f,p); assert.equal(list(f,f.model.snapshot(p,f.doc,f.w)).some(item=>item.id==='translate.ko.inline'),false);
  assert.equal(list(f,f.model.snapshot(p,f.doc,f.w)).some(item=>item.id==='av.send'),false); f.close();
});
test('whitespace selection still offers copy without meaningless translation requests',()=>{
  const f=fixture('<p>   </p>'),p=f.doc.querySelector('p');selected(f,p);assert.deepEqual(list(f,f.model.snapshot(p,f.doc,f.w)).map(item=>item.id),['edit.copy']);f.close();
});
test('editable contexts offer at most two replacements excluding source; readonly/password/no selection',()=>{
  const f=fixture('<textarea>안녕하세요</textarea><input type="password" value="secret">'); const field=f.doc.querySelector('textarea'); field.focus(); field.select();
  let c=f.model.snapshot(field,f.doc,f.w), ids=list(f,c).map(item=>item.id);
  assert.deepEqual(ids,['replace.ja','replace.en','translate.ja.copy','translate.en.copy','edit.cut','edit.copy','edit.paste','edit.selectAll']);
  for (const [text,source] of [['日本語','ja'],['Hello','en'],['한국어','ko']]) { field.value=text; field.select(); const replacements=list(f,f.model.snapshot(field,f.doc,f.w)).filter(item=>item.id.startsWith('replace.')); assert.equal(replacements.length,2); assert.equal(replacements.some(item=>item.id==='replace.'+source),false); }
  field.readOnly=true; ids=list(f,f.model.snapshot(field,f.doc,f.w)).map(item=>item.id); assert.equal(ids.includes('edit.cut'),false); assert.equal(ids.includes('edit.paste'),false); assert.equal(ids.some(id=>id.startsWith('replace.')),false);
  field.readOnly=false;field.setSelectionRange(0,0); assert.deepEqual(list(f,f.model.snapshot(field,f.doc,f.w)).map(item=>item.id),['edit.paste','edit.selectAll']);
  const password=f.doc.querySelector('input');password.select();ids=list(f,f.model.snapshot(password,f.doc,f.w)).map(item=>item.id);assert.deepEqual(ids,['edit.cut','edit.copy','edit.paste','edit.selectAll']);f.close();
});
test('selection/image/link combinations group correctly; picture, poster, and empty page save-as',()=>{
  const f=fixture('<p>Hello</p><a href="https://site.test/x"><picture><img src="https://site.test/i.png"></picture></a><video poster="https://site.test/poster.png"></video>');
  const image=f.doc.querySelector('img');selected(f,f.doc.querySelector('p'));
  let c=f.model.snapshot(image,f.doc,f.w,()=>({mediaUrl:image.src}));
  assert.deepEqual(list(f,c).map(item=>item.id),['translate.ko.inline','translate.ja.copy','translate.en.copy','edit.copy','image.translate','image.lakomics','link.openTab','link.copy','link.saveAs','image.save','image.saveAs','image.copyUrl','image.openTab']);
  f.w.getSelection().removeAllRanges(); assert.equal(f.model.snapshot(f.doc.querySelector('picture'),f.doc,f.w).imageUrl,image.src);
  assert.equal(f.model.snapshot(f.doc.querySelector('video'),f.doc,f.w).posterUrl,'https://site.test/poster.png');
  const empty=list(f,f.model.snapshot(f.doc.body,f.doc,f.w));assert.deepEqual(empty.map(item=>item.id),['page.translate','page.saveAs','nav.back','nav.forward','nav.reload']);assert.equal(empty.find(item=>item.id==='nav.forward').disabled,true);f.close();
});
test('bypass is strict for untrusted/defaultPrevented/Shift/gesture/picker/disabled/excluded sites and own UI',()=>{
  const f=fixture(); const event=trusted(f.doc.body);
  for(const override of [{defaultPrevented:true},{shiftKey:true},{isTrusted:false}]) assert.equal(Boolean(f.model.bypass({...event,...override})),true);
  for(const state of [{enabled:false},{phase:'armed'},{phase:'opening'},{picker:true},{hostname:'a.example.test',excludedHosts:['example.test']}]) assert.equal(Boolean(f.model.bypass(event,state)),true);
  assert.equal(Boolean(f.model.bypass(event,{hostname:'notexample.test',excludedHosts:['example.test']})),false);
  const own=f.doc.createElement('lakomics-menu');assert.equal(Boolean(f.model.bypass(trusted(own))),true);
  assert.deepEqual(plain(f.model.hosts(' Example.COM\nexample.com\nhttps://bad.test\nsite.test/path')),['example.com']);f.close();
});
test('placement flips independently and clamps oversize menus to visual viewport margins',()=>{
  const f=fixture(); const view={width:800,height:600};
  assert.deepEqual(plain(f.model.placement(40,60,232,200,view)),{x:42,y:62,flipX:false,flipY:false});
  assert.deepEqual(plain(f.model.placement(790,590,232,200,view)),{x:556,y:388,flipX:true,flipY:true});
  assert.equal(f.model.placement(790,30,232,200,view).flipY,false);
  const clamped=f.model.placement(0,0,900,900,{width:400,height:300,offsetLeft:20,offsetTop:30});assert.equal(clamped.x,28);assert.equal(clamped.y,38);f.close();
});
test('bubble window ownership respects site menu; keyboard navigation includes disabled slots, activation gates and focus return',async()=>{
  const f=fixture('<button id="focus">Focus</button><p>Hello</p>'); const focus=f.doc.querySelector('button');focus.focus();
  const calls=[];const controller=f.w.LakomicsContextMenu.createController({doc:f.doc,win:f.w,css,send:async message=>{calls.push(message);return {ok:true,hasApiKey:true};}});
  assert.equal(controller.open(trusted(f.doc.body,{defaultPrevented:true})),false);
  assert.equal(controller.open(trusted(f.doc.body)),true);let session=controller.current;
  assert.equal(session.surface.node.shadowRoot,null);assert.equal(session.menu.getAttribute('role'),'menu');assert.equal(session.index,-1);
  controller.keydown(trusted(session.menu,{key:'ArrowDown'}));assert.equal(session.index,0);
  controller.keydown(trusted(session.menu,{key:'End'}));assert.equal(session.items[session.index].id,'nav.reload');
  controller.keydown(trusted(session.menu,{key:'ArrowDown'}));assert.equal(session.index,0);
  controller.keydown(trusted(session.menu,{key:'Home'}));controller.keydown(trusted(session.menu,{key:'ArrowDown'}));controller.keydown(trusted(session.menu,{key:'ArrowDown'}));assert.equal(session.items[session.index].disabled,true);
  controller.keydown(trusted(session.menu,{key:'Enter'}));assert.equal(controller.current,session);
  controller.keydown(trusted(session.menu,{key:'Escape'}));assert.equal(controller.current,null);assert.equal(f.doc.activeElement,focus);
  controller.open(trusted(focus,{key:'ContextMenu'}),true);assert.equal(controller.current.index,0);controller.keydown(trusted(controller.current.menu,{key:'Tab'}));assert.equal(controller.current,null);
  controller.open(trusted(f.doc.body));session=controller.current;controller.keydown(trusted(session.menu,{key:'End',isTrusted:false}));assert.equal(session.index,-1);
  session.nodes[0].dispatchEvent(new f.w.MouseEvent('click',{bubbles:true}));assert.equal(controller.current,session);
  f.doc.dispatchEvent(new f.w.Event('scroll'));assert.equal(controller.current,null);
  await Promise.resolve();controller.destroy();f.close();
});
test('setup states, selection-end block placement, Unicode quote, theme, motion and forced colors',()=>{
  const f=fixture('<div><p>First</p><p id="last">日本語</p></div>');selected(f,f.doc.getElementById('last'));
  const c=f.model.snapshot(f.doc.body,f.doc,f.w);assert.equal(c.block.id,'last');
  const range=f.doc.createRange();range.selectNodeContents(f.doc.querySelector('div'));f.w.getSelection().removeAllRanges();f.w.getSelection().addRange(range);assert.equal(f.model.snapshot(f.doc.body,f.doc,f.w).block.id,'last','element-boundary selection ends at its last paragraph');
  assert.equal(f.model.items(c,{href:f.w.location.href,hasApiKey:false}).find(item=>item.id==='translate.ko.inline').setup,true);
  const keyed=(availability)=>f.model.items(c,{href:f.w.location.href,...availability}).find(item=>item.id==='translate.ko.inline').setup;
  assert.equal(keyed({hasApiKey:true,hasContextApiKey:false}),true,'setup follows the right-click model key, not the X model key');
  assert.equal(keyed({hasApiKey:false,hasContextApiKey:true}),false);
  assert.equal(f.model.quote('👨‍👩‍👧‍👦'.repeat(41)).endsWith('…'),true);
  assert.equal(f.w.LakomicsContextSurfaces.opaqueTheme('rgb(30, 30, 30)'),'dark');assert.equal(f.w.LakomicsContextSurfaces.opaqueTheme('rgba(0, 0, 0, 0)'),null);
  assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/forced-colors:active/);assert.match(css,/background-size:8px 2px,2px 8px/);assert.equal(css.includes('border-left'),false);f.close();
});
test('popover hosts enter the top layer, append inside fullscreen and are removed on immediate close',()=>{
  const f=fixture('<div id="full"><p>Hello</p></div>');const full=f.doc.getElementById('full'),shown=[];
  Object.defineProperty(f.doc,'fullscreenElement',{value:full});f.w.HTMLElement.prototype.showPopover=function(){shown.push(this);};
  const controller=f.w.LakomicsContextMenu.createController({doc:f.doc,win:f.w,css,send:async()=>({ok:true,hasApiKey:true})});
  controller.open(trusted(full));const host=controller.current.surface.node;assert.equal(host.parentElement,full);assert.equal(host.getAttribute('popover'),'manual');assert.ok(shown.includes(host));controller.close({immediate:true});assert.equal(host.isConnected,false);controller.destroy();f.close();
});
test('menu opens with an 80 ms opacity-only fade (no translate/scale) and closes instantly',()=>{
  const keyframes=css.match(/@keyframes menuIn\{[^@]*?\}\}/)?.[0]||'';
  assert.match(css,/\.cmA\{[^}]*animation:menuIn 80ms/);assert.match(keyframes,/opacity:0/);assert.equal(/transform|translate|scale/.test(keyframes),false);
  assert.equal(css.includes('--rise'),false);assert.equal(/\.cmA\.exit/.test(css),false);assert.match(css,/prefers-reduced-motion:reduce\)\{\.cmA,/);
  const f=fixture('<p>Hello</p>');const controller=f.w.LakomicsContextMenu.createController({doc:f.doc,win:f.w,css,send:async()=>({ok:true,hasApiKey:true})});
  controller.open(trusted(f.doc.body));const host=controller.current.surface.node;controller.close();assert.equal(host.isConnected,false,'removed in the same tick, no exit timer');controller.destroy();f.close();
});
