import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,applyAction,predict,evaluation,transact,undo,validateSession} from './public/review-engine.mjs';

function fixture(){
 const distances=Array.from({length:5},(_,i)=>Array.from({length:5},(_,j)=>i===j?0:.5));
 const pair=(a,b,v)=>{distances[a][b]=distances[b][a]=v;};
 pair(0,1,.1);pair(0,2,.12);pair(0,3,.16);pair(0,4,.18);pair(3,4,.04);
 return {threshold:.213,referencePool:[0],items:Array.from({length:5},(_,id)=>({id,positive:id<3,duplicateGroup:id})),distances};
}
function other(s,d){return applyAction(s,d,{type:'createCharacter',id:'other',seriesId:'series-1',name:'다른 캐릭터'});}
test('negative feedback excludes the taught image; changes only unseen predictions',()=>{
 const d=fixture(),s=applyAction(initialState(d),d,{type:'reject',ids:[3]});
 const e=evaluation(s,d);
 assert.deepEqual(e.ids,[1,2,4]);assert.deepEqual(e.before,{tp:2,fp:1,fn:0});assert.deepEqual(e.after,{tp:2,fp:0,fn:0});
 assert.equal(s.records[3].status,'held');assert.equal(s.records[4].status,'inbox');
});
test('correcting destination stores rejection, confirms, but does not register a reference',()=>{
 const d=fixture();let s=other(initialState(d),d);
 s=applyAction(s,d,{type:'correct',ids:[3],classId:'other'});
 assert.deepEqual(s.records[3].rejected,['aimes']);assert.equal(s.records[3].status,'confirmed');
 assert.deepEqual(s.characters[1].refs,[]);
 s=applyAction(s,d,{type:'reference',ids:[3],enabled:true});assert.deepEqual(s.characters[1].refs,[3]);
});
test('reversing a mistaken correction removes contradictory negative and reference',()=>{
 const d=fixture();let s=other(initialState(d),d);
 s=applyAction(s,d,{type:'correct',ids:[3],classId:'other'});
 s=applyAction(s,d,{type:'reference',ids:[3],enabled:true});
 s=applyAction(s,d,{type:'correct',ids:[3],classId:'aimes'});
 assert.deepEqual(s.records[3].rejected,['other']);assert.deepEqual(s.characters[1].refs,[]);
 assert.equal(validateSession({state:s,history:[]},d),true);
});
test('confirmed and held classifications survive reference and threshold changes',()=>{
 const d=fixture();let s=applyAction(initialState(d),d,{type:'approve',ids:[1]});
 s=applyAction(s,d,{type:'hold',ids:[2]});
 s=applyAction(s,d,{type:'threshold',value:0});
 assert.equal(s.records[1].status,'confirmed');assert.equal(s.records[1].classId,'aimes');
 assert.equal(s.records[2].status,'held');assert.deepEqual(s.records[2].rejected,[]);
});
test('latest-action undo keeps previous later-than-batch corrections intact',()=>{
 const d=fixture();let session={state:other(initialState(d),d),history:[]};
 session=transact(session,d,{type:'approve',ids:[1,2]},'approve');
 session=transact(session,d,{type:'correct',ids:[1],classId:'other'},'correct');
 const corrected=structuredClone(session.state);
 session=transact(session,d,{type:'threshold',value:0},'threshold');
 session=undo(session);assert.deepEqual(session.state,corrected);
 session=undo(session);assert.equal(session.state.records[1].classId,'aimes');assert.equal(session.state.records[2].status,'confirmed');
});
test('competing characters with similar distances remain unassigned',()=>{
 const d=fixture();d.distances[1][3]=d.distances[3][1]=.105;
 let s=other(initialState(d),d);s=applyAction(s,d,{type:'correct',ids:[3],classId:'other'});
 s=applyAction(s,d,{type:'reference',ids:[3],enabled:true});
 assert.equal(predict(s,d,1).reason,'ambiguous');assert.equal(s.records[1].status,'inbox');
});
test('predictions do not consult evaluation labels or input names',()=>{
 const d=fixture(),s=initialState(d),before=predict(s,d,1);
 for(const x of d.items){x.positive=!x.positive;x.name='fake_target_name';}
 assert.deepEqual(predict(s,d,1),before);
});
test('feedback-related duplicates are excluded from the same before-after evaluation set',()=>{
 const d=fixture();d.items[4].duplicateGroup=3;
 const s=applyAction(initialState(d),d,{type:'reject',ids:[3]});
 assert.deepEqual(evaluation(s,d).ids,[1,2]);
 assert.throws(()=>applyAction(s,d,{type:'reference',ids:[2],enabled:true}));
});
