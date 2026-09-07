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

 test('list follows five canonical levels even when radial placement flattens descendants',()=>{
 const tree=Array.from({length:6},(_,i)=>({id:'d'+i,name:'분류 '+i,parentId:i?'d'+(i-1):null}));
 const layout={version:1,parents:{__pinned__:[['d0']],d0:[['d1','d2','d3','d4','d5']]}};
 const model=context.LakomicsListCollector.createModel(tree,layout);
 for(let i=0;i<6;i++){
  assert.deepEqual(Array.from(model.children(),e=>e.id),['d'+i]);
  model.activate('d'+i);assert.equal(model.canSave('d'+i),true);
 }
 assert.deepEqual(Array.from(model.names()),tree.map(e=>e.name));
 model.back();assert.equal(model.selectedId,'d3');
 model.activate('d4');assert.deepEqual(Array.from(model.children(),e=>e.id),['d5']);
 });

test('manual list order survives reopening and does not move children or change radial layout',()=>{
 const layout=context.LakomicsRadial.resetLayout(entries), before=JSON.stringify(layout);
 const model=context.LakomicsListCollector.createModel(entries,layout);
 model.activate('root'); model.activate('folder');
 assert.equal(model.move('tag29',0),true);
 assert.equal(model.children()[0].id,'tag29');
 assert.equal(model.move('root',0),false);
 assert.equal(model.move('tag1',-1),false);
 const reopened=context.LakomicsListCollector.createModel([...entries,{id:'new',name:'신규',parentId:'folder'}],layout,[],['tag3'],model.order);
 reopened.activate('root');reopened.activate('folder');
 assert.equal(reopened.children()[0].id,'tag29');
 assert.equal(reopened.children().at(-1).id,'new');
 assert.equal(reopened.children().some(e=>e.id==='tag3'),false);
 assert.equal(JSON.stringify(layout),before);
 const previous=model.order;model.move('tag29',3);model.restoreOrder(previous);
 assert.equal(model.children()[0].id,'tag29');
});
