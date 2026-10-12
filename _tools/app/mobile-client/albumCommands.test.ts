import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api}));
import {albumBatchCommand,readAlbumSnapshot} from './albumCommands';
import type {AlbumTree} from './albumModel';
const tree:AlbumTree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums:[]};
const album={id:'root',name:'Root',parentId:null,iconKey:null,colorKey:null,entityRevision:1,deleted:false,assetCount:2,totalAssetCount:5};
const page={libraryId:tree.libraryId,epoch:1,snapshotCursor:0,listGeneration:'first',items:[album],hasMore:false,nextAfter:null,likesAlbumId:null};
beforeEach(()=>{mocks.api.mockReset();});
it('preserves direct and descendant counts through a paginated album snapshot',async()=>{
  mocks.api.mockResolvedValueOnce({...page,hasMore:true,nextAfter:'root'})
    .mockResolvedValueOnce({...page,items:[{...album,id:'second',assetCount:0,totalAssetCount:0}]});
  expect((await readAlbumSnapshot(tree)).albums).toEqual([album,{...album,id:'second',assetCount:0,totalAssetCount:0}]);
  expect(mocks.api.mock.calls[1][0]).toContain('snapshot=0');
});
it('rejects counts combined across a lifecycle or membership generation change',async()=>{
  mocks.api.mockResolvedValueOnce({...page,hasMore:true,nextAfter:'root'})
    .mockResolvedValueOnce({...page,listGeneration:'changed'});
  await expect(readAlbumSnapshot(tree)).rejects.toThrow('앨범 목록이 변경되었습니다.');
});

const member=(index:number)=>({commandType:'setAlbumMembership',albumId:'likes',assetId:`asset-${index}`,desiredState:true,expectedRevision:0});
const answer=(commands:{operationId:string}[],status='applied')=>({results:commands.map(command=>({operationId:command.operationId,status,changed:status==='applied',changeSequence:status==='applied'?1:null}))});
it('sends commands in batch requests of at most 100 and merges the results in order',async()=>{
  const requests:{commands:{operationId:string;assetId:string}[]}[]=[];
  mocks.api.mockImplementation(async(_path:string,_signal:unknown,body:{commands:{operationId:string;assetId:string}[]})=>{requests.push(body);return answer(body.commands);});
  const outcomes=await albumBatchCommand(tree,Array.from({length:250},(_,index)=>member(index)));
  expect(requests.map(request=>request.commands.length)).toEqual([100,100,50]);
  expect(mocks.api.mock.calls.every(([path,signal,,method])=>path==='/v1/albums/commands/batch'&&signal===undefined&&method==='PUT')).toBe(true);
  expect(mocks.api.mock.calls[0][2]).toMatchObject({libraryId:tree.libraryId,epoch:1,contractVersion:1});
  expect(new Set(requests.map(request=>(request as unknown as {batchId:string}).batchId)).size).toBe(3);
  expect(outcomes).toHaveLength(250);
  expect(outcomes.map(outcome=>outcome.operationId)).toEqual(requests.flatMap(request=>request.commands.map(command=>command.operationId)));
  expect(new Set(outcomes.map(outcome=>outcome.operationId)).size).toBe(250);
  expect(requests[2].commands[49].assetId).toBe('asset-249');
});
it('keeps earlier results when a later request does not complete and fails only that chunk',async()=>{
  let calls=0;
  mocks.api.mockImplementation(async(_path:string,_signal:unknown,body:{commands:{operationId:string}[]})=>{if(++calls===2)throw new Error('연결 끊김');return answer(body.commands);});
  const outcomes=await albumBatchCommand(tree,Array.from({length:130},(_,index)=>member(index)));
  expect(outcomes.slice(0,100).every(outcome=>outcome.status==='applied')).toBe(true);
  expect(outcomes.slice(100).every(outcome=>outcome.status==='failed'&&outcome.error?.message==='연결 끊김')).toBe(true);
});
it('treats a reply that does not match the request as a failure of that chunk',async()=>{
  mocks.api.mockResolvedValue({results:[{operationId:'someone-else',status:'applied',changed:true,changeSequence:1}]});
  const outcomes=await albumBatchCommand(tree,[member(1)]);
  expect(outcomes).toHaveLength(1);expect(outcomes[0].status).toBe('failed');
});
it('passes server refusals through on their own entries',async()=>{
  mocks.api.mockImplementation(async(_path:string,_signal:unknown,body:{commands:{operationId:string}[]})=>({results:[
    {operationId:body.commands[0].operationId,status:'conflict',changed:false,changeSequence:null,error:{code:'revisionConflict',status:409,current:{entityRevision:4}}},
    {operationId:body.commands[1].operationId,status:'noop',changed:false,changeSequence:null}]}));
  const outcomes=await albumBatchCommand(tree,[member(1),member(2)]);
  expect(outcomes.map(outcome=>outcome.status)).toEqual(['conflict','noop']);
  expect(outcomes[0].error?.code).toBe('revisionConflict');
});
it('refuses to send before the Album authority is adopted',async()=>{
  await expect(albumBatchCommand({...tree,adopted:false},[member(1)])).rejects.toThrow('동기화');
  expect(mocks.api).not.toHaveBeenCalled();
});
