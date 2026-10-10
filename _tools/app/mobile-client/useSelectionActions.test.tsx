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
  it.each(['like','unlike'] as const)('%s uses explicit desired state and fresh per-asset revisions',async action=>{
    mocks.api.mockImplementation(async(path:string,_signal:unknown,body:Record<string,unknown>)=>path.includes('/likes?')?{albumId:'likes',memberships:[{assetId:new URL(`https://test${path}`).searchParams.get('assetIds'),entityRevision:6,desiredState:action!=='like'}]}:body.commandType==='ensureLikesAlbum'?{album:{id:'likes'}}:{membership:{}});
    const props=options(),{result}=renderHook(()=>useSelectionActions(props));
    await act(()=>result.current.run(action));
    const writes=mocks.api.mock.calls.filter(([, ,body])=>body?.commandType==='setAlbumMembership');
    expect(writes.map(([, ,body])=>[body.assetId,body.desiredState,body.expectedRevision])).toEqual([['a',action==='like',6],['b',action==='like',6],['c',action==='like',6]]);
    expect(props.onComplete).toHaveBeenCalledWith(['a','b','c'],action);expect(result.current.notice).toBe('');
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
  it('removes only membership in the current album and retains blocked failures',async()=>{
    mocks.native.mockImplementation(async(_op:string,body:{assetId:string})=>({adopted:true,albums:[{id:'album',desiredState:false,blocked:body.assetId==='b'}]}));
    const props={...options(),albumId:'album'},{result}=renderHook(()=>useSelectionActions(props));
    await act(()=>result.current.run('remove'));
    expect(mocks.native.mock.calls.filter(([op])=>op==='albumMembershipSet')).toEqual(['a','b','c'].map(assetId=>['albumMembershipSet',{assetId,albumId:'album',desiredState:false}]));
    expect(props.onComplete).toHaveBeenCalledWith(['a','c'],'remove');expect(mocks.api).not.toHaveBeenCalled();
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
    fireEvent.click(await screen.findByRole('button',{name:'실행 취소'}));await screen.findByText('visible');
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
