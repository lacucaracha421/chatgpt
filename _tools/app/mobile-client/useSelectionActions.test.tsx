import {act,cleanup,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useSelectionActions} from './useSelectionActions';
import {useLibraryTrash} from './useLibraryTrash';
import type {AlbumTree} from './albumModel';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>reason instanceof Error?reason.message:String(reason)}));
const tree:AlbumTree={adopted:true,libraryId:'a'.repeat(32),epoch:1,code:'',albums:[]};
beforeEach(()=>{mocks.api.mockReset();mocks.native.mockReset();});
afterEach(()=>{cleanup();vi.useRealTimers();});
const options=()=>({scope:'folder',selectedIds:new Set(['a','b','c']),tree,onTrash:vi.fn(async()=>{}),onComplete:vi.fn()});
describe('tablet selection actions',()=>{
  const likesApi=(action:'like'|'unlike',options:{refuse?:string[];conflict?:string[];revisions?:Record<string,number>}={})=>async(path:string,_signal:unknown,body:Record<string,unknown>&{commands?:Record<string,unknown>[]})=>{
    if(path.includes('/likes?')){
      const ids=(new URL(`https://test${path}`).searchParams.get('assetIds')??'').split(',');
      return {albumId:'likes',memberships:ids.map(assetId=>({assetId,entityRevision:options.revisions?.[assetId]??6,desiredState:action!=='like'}))};
    }
    if(path==='/v1/albums/commands/batch')return {results:body.commands!.map(command=>options.conflict?.includes(command.assetId as string)
      ?{operationId:command.operationId,status:'conflict',changed:false,changeSequence:null,error:{code:'revisionConflict',status:409}}
      :options.refuse?.includes(command.assetId as string)
        ?{operationId:command.operationId,status:'rejected',changed:false,changeSequence:null,error:{code:'assetTombstoned',status:409,message:'영구 삭제된 자산입니다.'}}
        :{operationId:command.operationId,status:'applied',changed:true,changeSequence:1,membership:{}})};
    if(body.commandType==='ensureLikesAlbum')return {album:{id:'likes'}};
    throw new Error(`unexpected ${path}`);
  };
  it.each(['like','unlike'] as const)('%s reads revisions once and writes every asset in one batch request',async action=>{
    mocks.api.mockImplementation(likesApi(action));
    const props=options(),{result}=renderHook(()=>useSelectionActions(props));
    await act(()=>result.current.run(action));
    const batch=mocks.api.mock.calls.filter(([path])=>path==='/v1/albums/commands/batch');
    expect(batch).toHaveLength(1);
    expect(batch[0][3]).toBe('PUT');
    expect(batch[0][2]).toMatchObject({libraryId:tree.libraryId,epoch:1,contractVersion:1});
    expect((batch[0][2].commands as Record<string,unknown>[]).map(body=>[body.commandType,body.assetId,body.desiredState,body.expectedRevision,body.albumId])).toEqual(['a','b','c'].map(assetId=>['setAlbumMembership',assetId,action==='like',6,'likes']));
    expect(mocks.api.mock.calls.filter(([path])=>String(path).includes('/likes?'))).toHaveLength(1);
    expect(mocks.api.mock.calls.filter(([, ,body])=>body?.commandType==='setAlbumMembership')).toHaveLength(0);
    expect(props.onComplete).toHaveBeenCalledWith(['a','b','c'],action);expect(result.current.notice).toBe('');
  });
  it('writes nothing for assets that already have the requested state',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path.includes('/likes?')?{albumId:'likes',memberships:['a','b','c'].map(assetId=>({assetId,entityRevision:2,desiredState:true}))}:{album:{id:'likes'}});
    const props=options(),{result}=renderHook(()=>useSelectionActions(props));
    await act(()=>result.current.run('like'));
    expect(mocks.api.mock.calls.some(([path])=>path==='/v1/albums/commands/batch')).toBe(false);
    expect(props.onComplete).toHaveBeenLastCalledWith(['a','b','c'],'like');
  });
  it('reports a stale or refused favorite per asset and keeps only those selected',async()=>{
    mocks.api.mockImplementation(likesApi('like',{conflict:['b'],refuse:['c']}));
    const props=options(),{result}=renderHook(()=>useSelectionActions(props));
    await act(()=>result.current.run('like'));
    expect(props.onComplete).toHaveBeenCalledWith(['a'],'like');
    expect(result.current.notice).toContain('3개 중 1개 완료, 2개 실패');expect(result.current.notice).toContain('선택을 유지');
    expect(result.current.notice).toContain('다른 기기에서 먼저 바뀌었습니다');
  });
  it('splits favorites into chunks of 100 assets for both the read and the write',async()=>{
    const ids=Array.from({length:230},(_,index)=>`asset-${index}`);
    mocks.api.mockImplementation(likesApi('like'));
    const props={...options(),selectedIds:new Set(ids)},{result}=renderHook(()=>useSelectionActions(props));
    await act(()=>result.current.run('like'));
    const reads=mocks.api.mock.calls.filter(([path])=>String(path).includes('/likes?')).map(([path])=>new URL(`https://test${path}`).searchParams.get('assetIds')!.split(',').length);
    const writes=mocks.api.mock.calls.filter(([path])=>path==='/v1/albums/commands/batch').map(([, ,body])=>(body.commands as unknown[]).length);
    expect(reads).toEqual([100,100,30]);expect(writes).toEqual([100,100,30]);
    expect(props.onComplete).toHaveBeenCalledWith(ids,'like');expect(result.current.progress).toEqual({done:230,total:230});
  });
  it('marks only the failed request chunk when one batch request does not complete',async()=>{
    const ids=Array.from({length:150},(_,index)=>`asset-${index}`),inner=likesApi('like');let writes=0;
    mocks.api.mockImplementation(async(path:string,signal:unknown,body:Record<string,unknown>)=>{
      if(path==='/v1/albums/commands/batch'&&++writes===2)throw new Error('연결 끊김');
      return inner(path,signal,body);
    });
    const props={...options(),selectedIds:new Set(ids)},{result}=renderHook(()=>useSelectionActions(props));
    await act(()=>result.current.run('like'));
    expect(props.onComplete).toHaveBeenCalledWith(ids.slice(0,100),'like');
    expect(result.current.notice).toContain('150개 중 100개 완료, 50개 실패');expect(result.current.notice).toContain('연결 끊김');
  });
  it('runs sequentially, rejects duplicate clicks and reports partial failures',async()=>{
    let release!:()=>void;
    const props=options();props.onTrash.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;})).mockRejectedValueOnce(new Error('연결 실패'));
    const {result}=renderHook(()=>useSelectionActions(props));let work!:Promise<void>;
    act(()=>{work=result.current.run('trash');});
    expect(props.onTrash.mock.calls).toEqual([['a']]);expect(result.current.progress).toEqual({done:0,total:3});
    await act(()=>result.current.run('trash'));expect(props.onTrash).toHaveBeenCalledOnce();
    await act(async()=>{release();await work;});
    expect(props.onTrash.mock.calls).toEqual([['a'],['b'],['c']]);
    expect(props.onComplete).toHaveBeenCalledWith(['a','c'],'trash');
    expect(result.current.notice).toContain('3개 중 2개 완료, 1개 실패');expect(result.current.notice).toContain('선택을 유지');
  });
  it('removes only membership in the current album with one native call and retains blocked failures',async()=>{
    mocks.native.mockImplementation(async(_op:string,body:{assetIds:string[]})=>({adopted:true,results:body.assetIds.map(assetId=>({assetId,ok:assetId!=='b',pending:assetId!=='b',blocked:assetId==='b',conflictCode:assetId==='b'?'blocked':null,message:assetId==='b'?'앨범 연결 충돌을 먼저 해결해 주세요.':''}))}));
    const props={...options(),albumId:'album'},{result}=renderHook(()=>useSelectionActions(props));
    await act(()=>result.current.run('remove'));
    expect(mocks.native.mock.calls.filter(([op])=>op==='albumMembershipSetMany')).toEqual([['albumMembershipSetMany',{albumId:'album',assetIds:['a','b','c'],desiredState:false}]]);
    expect(mocks.native.mock.calls.filter(([op])=>op==='albumMembershipSet')).toHaveLength(0);
    expect(props.onComplete).toHaveBeenCalledWith(['a','c'],'remove');expect(mocks.api).not.toHaveBeenCalled();
    expect(result.current.notice).toContain('3개 중 2개 완료, 1개 실패');expect(result.current.notice).toContain('앨범 연결 충돌');
  });
  it('removes more than 100 assets in chunks of 100',async()=>{
    const ids=Array.from({length:101},(_,index)=>`asset-${index}`);
    mocks.native.mockImplementation(async(_op:string,body:{assetIds:string[]})=>({adopted:true,results:body.assetIds.map(assetId=>({assetId,ok:true,pending:true,blocked:false,conflictCode:null,message:''}))}));
    const props={...options(),selectedIds:new Set(ids),albumId:'album'},{result}=renderHook(()=>useSelectionActions(props));
    await act(()=>result.current.run('remove'));
    expect(mocks.native.mock.calls.filter(([op])=>op==='albumMembershipSetMany').map(([,body])=>body.assetIds.length)).toEqual([100,1]);
    expect(props.onComplete).toHaveBeenCalledWith(ids,'remove');
  });
  it('stops the remaining writes when the user changes scope',async()=>{
    let release!:()=>void;const props=options();props.onTrash.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    const {result,rerender}=renderHook(({scope})=>useSelectionActions({...props,scope}),{initialProps:{scope:'one'}});let work!:Promise<void>;
    act(()=>{work=result.current.run('trash');});rerender({scope:'two'});
    await act(async()=>{release();await work;});expect(props.onTrash).toHaveBeenCalledOnce();expect(props.onComplete).not.toHaveBeenCalled();
  });
  it('does not send album commands before authority is adopted',async()=>{
    const props={...options(),tree:{...tree,adopted:false}},{result}=renderHook(()=>useSelectionActions(props));
    await act(()=>result.current.run('like'));expect(mocks.api).not.toHaveBeenCalled();expect(result.current.notice).toContain('동기화');
  });
  it('queues recoverable trash and rejects blocked/tombstoned rows without hiding them',async()=>{
    mocks.native.mockImplementation(async(op:string,body:{assetId:string})=>op==='assetLifecycleState'?{available:true,items:[]}:{available:true,tombstoned:body.assetId==='gone',items:[{assetId:body.assetId,command:'trash',state:body.assetId==='blocked'?'blocked':'pending'}]});
    const {result}=renderHook(()=>useLibraryTrash(true,'endpoint',vi.fn()));
    await waitFor(()=>expect(result.current.available).toBe(true));
    await act(()=>result.current.trashSelected({id:'ok',kind:'image'}));
    expect(result.current.hidden.has('ok')).toBe(true);expect(result.current.known.get('ok')).toBeTruthy();
    for(const id of ['blocked','gone'])await act(async()=>{await expect(result.current.trashSelected({id,kind:'image'})).rejects.toThrow();});
    expect(result.current.hidden.has('blocked')).toBe(false);
    expect(mocks.native).toHaveBeenCalledWith('assetLifecycleSet',{assetId:'ok',command:'trash',seenRevision:0});
  });
  it('offers one undo for all successful batch trash intents',async()=>{
    mocks.native.mockImplementation(async(op:string,body:{assetId:string;command:string})=>op==='assetLifecycleState'?{available:true,items:[]}:{available:true,items:[{assetId:body.assetId,command:body.command,state:'pending'}]});
    function Host(){const trash=useLibraryTrash(true,'endpoint',vi.fn());return <><button onClick={()=>void (async()=>{await trash.trashSelected({id:'a',kind:'image'});await trash.trashSelected({id:'b',kind:'image'});trash.offerBatchUndo(['a','b']);})()}>trash both</button><span>{[...trash.hidden].join(',')||'visible'}</span>{trash.snackbar}</>;}
    render(<Host/>);fireEvent.click(screen.getByText('trash both'));await screen.findByText('a,b');
    fireEvent.click(await screen.findByRole('button',{name:'되돌리기'}));await screen.findByText('visible');
    expect(mocks.native.mock.calls.filter(([op,body])=>op==='assetLifecycleSet'&&body.command==='restore').map(([,body])=>body.assetId)).toEqual(['a','b']);
  });
  it('delays progress text and keeps it briefly after a long batch finishes',async()=>{
    vi.useFakeTimers();const props=options();let release!:()=>void;props.onTrash.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    function Host(){const state=useSelectionActions(props);return <><button onClick={()=>void state.run('trash')}>run</button><BusyLabel delay={400} busy={state.busy}>선택 작업 처리 중 {state.progress.done}/{state.progress.total}</BusyLabel></>;}
    render(<Host/>);fireEvent.click(screen.getByText('run'));
    expect(screen.queryByText(/선택 작업 처리 중/)).toBeNull();act(()=>vi.advanceTimersByTime(399));expect(screen.queryByText(/선택 작업 처리 중/)).toBeNull();
    act(()=>vi.advanceTimersByTime(1));expect(screen.getByText('선택 작업 처리 중 0/3')).toBeTruthy();
    await act(async()=>release());
    expect(screen.getByText(/선택 작업 처리 중/)).toBeTruthy();
    act(()=>vi.advanceTimersByTime(400));expect(screen.queryByText(/선택 작업 처리 중/)).toBeNull();
  });
});
