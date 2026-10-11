import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../../_tools/app/node_modules/jsdom/lib/api.js';
const html=await readFile(new URL('../options/options.html',import.meta.url),'utf8'),source=await readFile(new URL('../options/options.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(value){const dom=new JSDOM(html,{url:'https://extension.test/options',runScripts:'outside-only'}),w=dom.window,memory={'unrelated':123};if(value)memory['lakomics:context-menu:v1']=value;
  w.chrome={storage:{local:{async get(){return memory;},async set(value){Object.assign(memory,structuredClone(value));}}},runtime:{sendMessage:async()=>({ok:false})}};w.eval(source);await tick();return {w,doc:w.document,memory,close:()=>w.close()};}
test('context menu defaults on, persists switch/excluded hosts, and reloads without changing other settings',async()=>{
  const f=await fixture();assert.equal(f.doc.getElementById('context-menu-enabled').checked,true);assert.match(f.doc.getElementById('context-menu-section').textContent,/Shift\+우클릭: Chrome 메뉴/);
  f.doc.getElementById('context-menu-excluded').value=' Example.COM\nexample.com\nsub.site.test';f.doc.getElementById('context-menu-form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();
  assert.deepEqual(f.memory['lakomics:context-menu:v1'],{enabled:true,excludedHosts:['example.com','sub.site.test']});assert.equal(f.memory.unrelated,123);
  const checkbox=f.doc.getElementById('context-menu-enabled');checkbox.checked=false;checkbox.dispatchEvent(new f.w.Event('change'));await tick();assert.equal(f.memory['lakomics:context-menu:v1'].enabled,false);
  const g=await fixture(f.memory['lakomics:context-menu:v1']);assert.equal(g.doc.getElementById('context-menu-enabled').checked,false);assert.equal(g.doc.getElementById('context-menu-excluded').value,'example.com\nsub.site.test');f.close();g.close();
});
test('invalid site lines produce feedback and do not save malformed exclusions',async()=>{
  const f=await fixture();f.doc.getElementById('context-menu-excluded').value='https://example.com/path';f.doc.getElementById('context-menu-form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await tick();assert.equal(f.memory['lakomics:context-menu:v1'],undefined);assert.match(f.doc.getElementById('context-menu-error').textContent,/호스트/);f.close();
});
test('X card has text tint, square-free 4px block radius, header/close control, and no colored stripe',async()=>{
  const x=await readFile(new URL('../src/x-translate.js',import.meta.url),'utf8');assert.equal(x.includes('border-left'),false);assert.match(x,/background:color-mix\(in srgb,currentColor 6%,transparent\)/);assert.match(x,/margin:8px 0 12px;padding:8px 12px 12px/);assert.match(x,/번역 닫기/);assert.match(x,/color-mix\(in srgb,currentColor 55%,transparent\)/);assert.match(x,/hover:none/);
});
test('options page carries the Lakomics Companion name in title and heading',()=>{
  assert.match(html,/<title>Lakomics Companion<\/title>/);assert.match(html,/<h1>Lakomics Companion<\/h1>/);assert.equal(html.includes('Collector List'),false);
});
