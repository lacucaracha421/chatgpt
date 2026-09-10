import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {createRequire} from 'node:module';
// Reuse the workspace's existing DOM test dependency; no browser or real storage.
const {JSDOM}=createRequire(new URL('../../app/package.json',import.meta.url))('jsdom');
function setup(onReorder=async()=>({ok:true}), actions={}) {
 const dom=new JSDOM('<div id="editor"></div>',{runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window, timers=new Map();let sequence=0;
 w.matchMedia=()=>({matches:true});
 w.setTimeout=fn=>{timers.set(++sequence,fn);return sequence;};w.clearTimeout=id=>timers.delete(id);
 w.requestAnimationFrame=()=>1;w.cancelAnimationFrame=()=>{};
 w.HTMLElement.prototype.setPointerCapture=function(id){this.capture=id;};
 w.HTMLElement.prototype.hasPointerCapture=function(id){return this.capture===id;};
 w.HTMLElement.prototype.releasePointerCapture=function(){this.capture=null;};
 for(const file of ['layout','list-collector'])w.eval(fs.readFileSync(new URL('../src/'+file+'.js',import.meta.url),'utf8'));
 const entries=[{id:'a',name:'A',parentId:null},{id:'b',name:'B',parentId:null},{id:'c',name:'C',parentId:null},{id:'child',name:'Child',parentId:'a'}];
 const picker=w.LakomicsListCollector.mount({entries,layout:w.LakomicsRadial.resetLayout(entries),pinnedIds:[],hiddenIds:[],container:w.document.querySelector('#editor'),onReorder,onClose:()=>{},...actions});
 const shadow=picker.host.shadowRoot, rows=()=>[...shadow.querySelectorAll('.row')];
 function geometry(){rows().forEach((row,index)=>{row.parentElement.getBoundingClientRect=()=>({top:100+index*48,height:44});});shadow.querySelector('.rows').getBoundingClientRect=()=>({top:100,bottom:440});}
 geometry();
 const event=(element,type,y)=>{const e=new w.Event(type,{bubbles:true,cancelable:true,composed:true});Object.assign(e,{pointerId:1,button:0,clientX:50,clientY:y});element.dispatchEvent(e);};
 return {picker,shadow,rows,event,geometry,hold(){for(const fn of timers.values())fn();timers.clear();},async settle(){await new Promise(resolve=>setImmediate(resolve));},close(){picker.close();w.close();}};
}
test('long press lifts a row, drops at the insertion position, and saves once',async()=>{
 const calls=[];const h=setup(async order=>{calls.push(order);return{ok:true};});
 try {
  const row=h.rows()[2];h.event(row,'pointerdown',218);h.hold();
  assert.equal(row.classList.contains('lifted'),true);
  h.event(row,'pointermove',101);assert.equal(h.rows()[0].parentElement.classList.contains('drop-before'),true);
  h.event(row,'pointerup',101);await h.settle();
  assert.deepEqual(h.rows().map(r=>r.dataset.classificationId),['c','a','b']);
  assert.equal(calls.length,1);assert.deepEqual(Array.from(calls[0].__root__),['c','a','b']);
  assert.equal(h.shadow.querySelector('.lifted'),null);
 }finally{h.close();}
});
test('short press opens a folder; movement before hold scrolls without reordering',async()=>{
 let writes=0;const h=setup(async()=>{writes++;return{ok:true};});
 try{
  h.event(h.rows()[1],'pointerdown',170);h.event(h.rows()[1],'pointermove',140);h.hold();
  assert.equal(h.shadow.querySelector('.lifted'),null);h.event(h.rows()[1],'pointerup',140);
  assert.equal(writes,0);assert.equal(h.shadow.querySelector('.rows').scrollTop,30);
  h.event(h.rows()[0],'pointerdown',122);h.event(h.rows()[0],'pointerup',122);
  assert.deepEqual(h.rows().map(r=>r.dataset.classificationId),['child']);
  assert.equal(writes,0);
 }finally{h.close();}
});
test('pointer cancellation and Escape release lifted rows without saving',()=>{
 let writes=0;const h=setup(async()=>{writes++;return{ok:true};});
 try{
  const row=h.rows()[2];h.event(row,'pointerdown',218);h.hold();h.event(row,'pointermove',101);h.event(row,'pointercancel',101);
  assert.equal(h.shadow.querySelector('.lifted'),null);assert.equal(writes,0);
  h.event(row,'pointerdown',218);h.hold();
  row.dispatchEvent(new row.ownerDocument.defaultView.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(h.shadow.querySelector('.lifted'),null);assert.equal(writes,0);
 }finally{h.close();}
});
test('failed drop restores order and leaves navigation usable',async()=>{
 const h=setup(async()=>({ok:false}));
 try{
  const row=h.rows()[2];h.event(row,'pointerdown',218);h.hold();h.event(row,'pointermove',101);h.event(row,'pointerup',101);await h.settle();
  assert.deepEqual(h.rows().map(r=>r.dataset.classificationId),['a','b','c']);
  assert.match(h.shadow.querySelector('.notice').textContent,/원래 순서/);
  assert.equal(h.rows()[0].disabled,false);
 }finally{h.close();}
});

test('reserves enough panel height for seven destinations plus temporary save',()=>{
 const h=setup(null,{onTemporary:()=>{}});
 try {
  const css=h.shadow.querySelector('style').textContent;
  assert.match(css,/width:350px;height:480px/);
  // 52px header + 16px body margins + 7×48px rows + 56px temporary row = 460px.
  assert.ok(480>=52+16+7*48+56);
 } finally {h.close();}
});

test('temporary row hands off once without classification save and stays outside the editable order',()=>{
 let temporary=0, permanent=0;
 const h=setup(null,{onTemporary:()=>{temporary++;},onSave:()=>{permanent++;}});
 try {
  const button=h.shadow.querySelector('.temporary-save');
  assert.equal(button.textContent,'임시 저장');assert.equal(button.disabled,false);
  assert.equal(h.shadow.querySelector('.rows').lastElementChild,button);
  assert.equal(h.picker.model.canSave('temporary'),false);
  button.click();assert.equal(temporary,1);assert.equal(permanent,0);assert.equal(h.picker.host.isConnected,false);
 } finally {h.close();}
});
