import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api}));
import {readAlbumSnapshot} from './albumCommands';
import type {AlbumTree} from './albumModel';
const tree:AlbumTree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums:[]};
const album={id:'root',name:'Root',parentId:null,iconKey:null,colorKey:null,entityRevision:1,deleted:false,assetCount:2,totalAssetCount:5};
const page={libraryId:tree.libraryId,epoch:1,snapshotCursor:0,listGeneration:'first',items:[album],hasMore:false,nextAfter:null,likesAlbumId:null};
beforeEach(()=>mocks.api.mockReset());
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
