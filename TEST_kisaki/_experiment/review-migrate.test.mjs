import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,transact,undo,validateSession} from './public/review-engine.mjs';
import {envelope,migrate} from './public/review-migrate.mjs';
function fixture(){
 const distances=Array.from({length:5},(_,i)=>Array.from({length:5},(_,j)=>i===j?0:.4));
 for(let i=1;i<5;i++)distances[0][i]=distances[i][0]=.15;
 return {model:{revision:'fixed'},sourceRoot:'fixture',threshold:.213,referencePool:[0],distances,
  items:Array.from({length:5},(_,id)=>({id,path:`${id}.jpg`,sha256:`hash${id}`,duplicateGroup:id,positive:id<3}))};
}
function extend(old){
 const d=structuredClone(old);d.items.push(...[5,6].map(id=>({id,path:`${id}.jpg`,sha256:`hash${id}`,duplicateGroup:id,positive:id===5})));
 d.distances=Array.from({length:7},(_,i)=>Array.from({length:7},(_,j)=>i<5&&j<5?old.distances[i][j]:i===j?0:.4));
 for(const i of [5,6])d.distances[i][0]=d.distances[0][i]=.15;
 d.distances[6][3]=d.distances[3][6]=.05;d.referencePool=[5];return d;
}
function reviewed(d){let s={state:initialState(d),history:[]};s=transact(s,d,{type:'approve',ids:[1]},'approve');s=transact(s,d,{type:'hold',ids:[2]},'hold');return transact(s,d,{type:'reject',ids:[3]},'reject');}
test('append keeps confirmations, holds, negatives, references and threshold; predicts only new images',()=>{
 const old=fixture(),s=reviewed(old),d=extend(old),result=migrate(envelope(old,s),d);
 assert.deepEqual(result.newIds,[5,6]);assert.deepEqual(result.session.state.records.slice(0,5),s.state.records);
 assert.deepEqual(result.session.state.characters,s.state.characters);
 assert.equal(result.session.state.records[5].status,'tentative');assert.equal(result.session.state.records[6].status,'inbox');
 assert.equal(result.session.state.threshold,s.state.threshold);assert.deepEqual(result.session.appendBatch.initial.after,{tp:1,fp:0,fn:0});
 assert.equal(validateSession(result.session,d),true);
});
test('renaming and reordering files maps state and refs by content, not numeric IDs',()=>{
 const old=fixture(),s=reviewed(old),order=[3,4,0,1,2],d=structuredClone(old);
 d.items=order.map((id,i)=>({...old.items[id],id:i,path:`renamed-${id}.jpg`,duplicateGroup:i}));
 d.distances=order.map(i=>order.map(j=>old.distances[i][j]));
 const result=migrate(envelope(old,s),d);
 assert.deepEqual(result.newIds,[]);assert.deepEqual(result.session.state.characters[0].refs,[2]);
 assert.equal(result.session.state.records[3].status,'confirmed');assert.deepEqual(result.session.state.records[0].rejected,['aimes']);
});
test('undo after append never removes new rows, and frozen arrival metrics survive later review',()=>{
 const d=fixture(),next=extend(d),saved=envelope(d,reviewed(d));let s=migrate(saved,next).session;
 const metrics=structuredClone(s.appendBatch.initial);
 s=transact(s,next,{type:'approve',ids:[5]},'new approval');assert.deepEqual(s.appendBatch.initial,metrics);
 s=undo(s);assert.equal(s.state.records.length,7);assert.equal(s.state.records[5].status,'tentative');
 s=undo(s);assert.equal(s.state.records.length,7);assert.equal(validateSession(s,next),true);
});
test('missing evidence or different model fails instead of silently resetting user decisions',()=>{
 const old=fixture(),saved=envelope(old,reviewed(old));let next=structuredClone(old);
 next.model.revision='changed';assert.throws(()=>migrate(saved,next),/모델/);
 next=structuredClone(old);next.items=next.items.slice(1);assert.throws(()=>migrate(saved,next),/빠져/);
 assert.equal(saved.session.state.records[1].status,'confirmed');
});
test('no new files keeps history and last arrival summary intact',()=>{
 const old=fixture(),next=extend(old),first=migrate(envelope(old,reviewed(old)),next).session;
 const second=migrate(envelope(next,first),next);
 assert.deepEqual(second.newIds,[]);assert.deepEqual(second.session,first);
});
