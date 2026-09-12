import test from 'node:test';
import assert from 'node:assert/strict';
await import('../src/classification-tree.js');
const tree = globalThis.LakomicsClassificationTree;

test('list model uses canonical hierarchy with portable pins and sibling order', () => {
  const entries = [
    {id:'games',name:'게임',parentId:null},
    {id:'manga',name:'만화',parentId:null},
    {id:'blue',name:'블루 아카이브',parentId:'games'},
    {id:'kisaki',name:'키사키',parentId:'blue'},
    {id:'hoshino',name:'호시노',parentId:'blue'},
  ];
  const model = tree.createModel(entries, {
    revision: 4,
    pinnedClassificationIds:['kisaki'],
    listOrder:{blue:['hoshino','kisaki']},
  });
  assert.deepEqual(model.rootItems().map(({entry,shortcut})=>[entry.id,shortcut]), [['kisaki',true],['games',false],['manga',false]]);
  assert.deepEqual(model.children('blue').map(entry=>entry.id), ['hoshino','kisaki']);
  assert.deepEqual(model.path('kisaki').map(entry=>entry.id), ['games','blue','kisaki']);
});

test('stale pinned ids are ignored without changing the real tree', () => {
  const model = tree.createModel([{id:'games',name:'게임',parentId:null}], {pinnedClassificationIds:['gone']});
  assert.deepEqual(model.rootItems().map(item=>item.entry.id), ['games']);
});

test('arc slots survive additions and deletions and reset only for an explicit order edit', () => {
  const entries = ['a', 'b', 'c'].map(id => ({ id, name: id, parentId: null }));
  const first = tree.reconcileArcLayout(entries, {}, {});
  const removed = tree.reconcileArcLayout(entries.filter(e => e.id !== 'b'), {}, first);
  assert.deepEqual(removed.__root__.slots, ['a', null, 'c']);
  const added = tree.reconcileArcLayout([...entries.filter(e => e.id !== 'b'), { id: 'd', name: 'd', parentId: null }], {}, removed);
  assert.deepEqual(added.__root__.slots, ['a', 'd', 'c']);
  const reordered = tree.reconcileArcLayout(entries, { listOrder: { __root__: ['c', 'b', 'a'] } }, first);
  assert.deepEqual(reordered.__root__.slots, ['c', 'b', 'a']);
});
