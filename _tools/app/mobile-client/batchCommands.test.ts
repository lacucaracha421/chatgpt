import {expect,it} from 'vitest';
import {batches,BATCH_LIMIT,manyFailures} from './batchCommands';

it('splits a selection into requests of at most 100 while keeping order',()=>{
  const ids=Array.from({length:201},(_,index)=>index);
  const chunks=batches(ids);
  expect(BATCH_LIMIT).toBe(100);
  expect(chunks.map(chunk=>chunk.length)).toEqual([100,100,1]);
  expect(chunks.flat()).toEqual(ids);
  expect(batches([])).toEqual([]);
  expect(batches([1,2,3],2)).toEqual([[1,2],[3]]);
});
it('turns a bridge reply into one failure message or null per asset',()=>{
  const reply={adopted:true,results:[
    {assetId:'a',ok:true,pending:true,blocked:false,conflictCode:null,message:''},
    {assetId:'b',ok:false,pending:false,blocked:true,conflictCode:'blocked',message:'충돌'},
    {assetId:'c',ok:true,pending:false,blocked:true,conflictCode:'blocked',message:''}]};
  expect(manyFailures(['a','b','c','d'],reply,'기본')).toEqual([null,'충돌','기본','기본']);
  expect(manyFailures(['a'],{...reply,adopted:false},'기본')).toEqual(['기본']);
  expect(manyFailures(['a'],undefined,'기본')).toEqual(['기본']);
});
