import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const context={};context.globalThis=context;
for(const file of ['layout','list-collector'])vm.runInNewContext(fs.readFileSync(new URL('../src/'+file+'.js',import.meta.url),'utf8'),context);
const entries=[{id:'root',name:'게임',parentId:null},{id:'folder',name:'리버스',parentId:'root'},...Array.from({length:30},(_,i)=>({id:'tag'+i,name:'태그 '+i,parentId:'folder'}))];
test('list selects only one leaf and preserves the current breadcrumb',()=>{
 const model=context.LakomicsListCollector.createModel(entries,context.LakomicsRadial.resetLayout(entries),[],['tag3']);
 assert.equal(model.canSave('root'),true);
 model.activate('root');model.activate('folder');assert.equal(model.children().length,29);
 model.activate('tag29');model.activate('tag0');
 assert.equal(model.selectedId,'tag0');
 assert.deepEqual(Array.from(model.names()),['게임','리버스','태그 0']);
 assert.equal(model.canSave('tag3'),false);
 model.back();assert.equal(model.selectedId,'root');
 assert.deepEqual(Array.from(model.names()),['게임']);
});
test('pinned tags stay available at top level and hidden tags are excluded',()=>{
 const model=context.LakomicsListCollector.createModel(entries,context.LakomicsRadial.resetLayout(entries),['tag2'],['tag3']);
 assert.ok(model.children().some(e=>e.id==='tag2'));
 model.activate('root');model.activate('folder');
 assert.ok(!model.children().some(e=>['tag2','tag3'].includes(e.id)));
});
