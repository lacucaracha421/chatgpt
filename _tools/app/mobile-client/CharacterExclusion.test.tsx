import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Asset} from './types';
import type {CharacterIndex,CharacterNode} from './characterModel';
import {viewerCharacterContext} from './CharacterBrowser';
import {characterExclusion,characterExclusionTarget} from './characterModel';
import {ApiError} from './transport';

const mocks=vi.hoisted(()=>({api:vi.fn(),ticket:vi.fn(),decode:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:vi.fn(),
  ApiError:class ApiError extends Error{status:number|null;details:unknown;constructor(message:string,status:number|null,details:unknown){super(message);this.status=status;this.details=details;}},
  errorText:(error:Error)=>error.message}));
vi.mock('./media',()=>({mediaTicket:mocks.ticket,decodeImage:mocks.decode,invalidateTicket:vi.fn(),loadThumbnail:vi.fn(),clearMediaCache:vi.fn(),prepareAssets:vi.fn()}));
vi.mock('./AlbumMembershipEditor',()=>({AlbumMembershipEditor:()=>null}));
vi.mock('./ClassificationAssignmentEditor',()=>({ClassificationAssignmentEditor:()=>null}));
vi.mock('./ViewerInfo',()=>({ViewerInfo:()=>null}));
// The shared Gallery virtualizes its rows, so these browser-level assertions use the same
// lightweight items/onOpen projection the existing CharacterBrowser suite uses.
vi.mock('./Gallery',()=>({Gallery:({items,onOpen,intro}:{intro?:import('react').ReactNode;items:Asset[];onOpen(i:number,character?:unknown):void})=><div aria-label="character gallery">{intro}{items.map((a,i)=><button key={a.id} onClick={()=>onOpen(i,undefined)}>{a.id}</button>)}</div>}));
import {Viewer} from './Viewer';
import {CharacterBrowser} from './CharacterBrowser';
import {exclusionStorageKey} from './CharacterExclusion';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const revision='a'.repeat(64);
const libraryId='0123456789abcdef0123456789abcdef';
const endpoint='https://example.invalid';
/** The index advertises the exclusion capability with its own publication revision. */
const index:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false,manualExclusion:true},
  libraryId,exclusionCursor:4,ready:true,revision,publishedAt:'2026',nodes:[
    {id:'series:s',kind:'series',sourceId:'s',seriesId:'s',parentId:null,name:'Series',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false},
    {id:'group:g',kind:'group',sourceId:'g',seriesId:'s',parentId:'series:s',name:'Group',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false},
    {id:'character:c',kind:'character',sourceId:'char-77',seriesId:'s',parentId:'group:g',name:'Lumi',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false,protectedAssetIds:['asset-base']},
    {id:'folder:f',kind:'folder',sourceId:'f',seriesId:'s',parentId:'series:s',name:'Folder',description:'',thumbnailAssetId:null,manualOnly:false,excluded:false},
  ],scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2},{nodeId:'group:g',filter:'all',totalCount:2,sourceCount:2},{nodeId:'character:c',filter:'all',totalCount:2,sourceCount:2},{nodeId:'folder:f',filter:'all',totalCount:2,sourceCount:2}]};
const node=(id:string)=>index.nodes.find(n=>n.id===id) as CharacterNode;
const items:Asset[]=[{id:'asset-1',kind:'image',preview:'https://test.invalid/1',creator_name:'First'},{id:'asset-2',kind:'image',preview:'https://test.invalid/2'}];
const receipt=(over:Record<string,unknown>={})=>({version:1,operationId:'op',libraryId,targetId:'char-77',assetId:'asset-1',sequence:5,revision:'b'.repeat(64),pendingPc:true,...over});
const keyFor=(assetId:string,at=endpoint)=>({endpoint:at,libraryId,targetId:'char-77',assetId});
const stored=(assetId:string,at=endpoint)=>{const raw=localStorage.getItem(exclusionStorageKey(keyFor(assetId,at)));return raw?JSON.parse(raw):null;};
const echoReceipt=()=>mocks.api.mockImplementation(async(_path:string,_signal:AbortSignal,body:unknown)=>receipt({operationId:(body as {operationId:string}).operationId}));
const bodies=()=>mocks.api.mock.calls.map(call=>call[2] as {operationId:string;assetId:string});

afterEach(()=>{cleanup();localStorage.clear();});
beforeEach(()=>{
  localStorage.clear();mocks.api.mockReset();mocks.ticket.mockReset();mocks.decode.mockReset();
  mocks.ticket.mockImplementation((asset:Asset)=>Promise.resolve({url:`https://test.invalid/original-${asset.id}`}));
});

describe('character exclusion context',()=>{
  it('reports a character target only for a character node, using the publisher id',()=>{
    expect(characterExclusionTarget(node('character:c'))?.sourceId).toBe('char-77');
    for(const other of ['series:s','group:g','folder:f'])expect(characterExclusionTarget(node(other))).toBeNull();
    const context=viewerCharacterContext(node('character:c'),index)!;
    expect(context).toMatchObject({targetId:'char-77',name:'Lumi',libraryId,revision,protectedAssetIds:['asset-base']});
    for(const other of ['series:s','group:g','folder:f'])expect(viewerCharacterContext(node(other),index)).toBeNull();
  });
  it('withholds context when protected reference metadata is missing or malformed',()=>{
    for(const protectedAssetIds of [undefined,null,'asset-base',[42]]){
      expect(viewerCharacterContext({...node('character:c'),protectedAssetIds} as CharacterNode,index)).toBeNull();
    }
  });
  it('reads the capability from the index revision and its own cursor',()=>{
    // `revision` is the index's publication revision — the field the asset scopes are read at —
    // paired with the separate numeric exclusion cursor.
    expect(characterExclusion(index)).toEqual({libraryId,revision,exclusionCursor:4});
    expect(characterExclusion({...index,capabilities:{read:true,write:false}})).toBeNull();
    // A half-read identity is refused rather than defaulted.
    for(const broken of [
      {...index,libraryId:undefined},
      {...index,libraryId:'not-hex'},
      {...index,revision:null},
      {...index,revision:'short'},
      {...index,exclusionCursor:undefined},
      {...index,exclusionCursor:-1},
      {...index,exclusionCursor:1.5},
    ])expect(characterExclusion(broken as CharacterIndex)).toBeNull();
  });
});

describe('character exclusion confirmation',()=>{
  const backRef:{current:(()=>boolean)|null}={current:null};
  const renderViewer=(character:unknown=viewerCharacterContext(node('character:c'),index),excluded=vi.fn(),at=endpoint)=>{
    const view=render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}} backRef={backRef} endpoint={at}
      character={character as never} onCharacterExcluded={excluded}/>);
    return {view,excluded};
  };
  const open=()=>fireEvent.click(screen.getByRole('button',{name:'Lumi에서 제외'}));

  it('offers the action only from a character origin and names that character',()=>{
    const {view}=renderViewer();
    expect(screen.getByRole('button',{name:'Lumi에서 제외'})).toBeTruthy();
    view.rerender(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}} endpoint={endpoint}/>);
    expect(screen.queryByRole('button',{name:/에서 제외/})).toBeNull();
  });
  it('withholds the action without a configured endpoint',()=>{
    renderViewer(undefined,vi.fn(),'');
    expect(screen.queryByRole('button',{name:/에서 제외/})).toBeNull();
  });
  it('withholds the action for one of the character\'s own reference assets',()=>{
    renderViewer({...viewerCharacterContext(node('character:c'),index),protectedAssetIds:['asset-1']});
    expect(screen.queryByRole('button',{name:/에서 제외/})).toBeNull();
  });
  it('says the file, folder and other characters are untouched, and sends nothing until confirmed',async()=>{
    renderViewer();open();
    const dialog=await screen.findByRole('dialog',{name:'Lumi에서 제외'});
    expect(dialog.textContent).toContain('파일은 삭제되지 않고 폴더도 그대로 남습니다.');
    expect(dialog.textContent).toContain('다른 캐릭터에는 영향이 없습니다.');
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it('cancels without sending',()=>{
    const {excluded}=renderViewer();
    open();fireEvent.click(screen.getByRole('button',{name:'취소'}));
    expect(mocks.api).not.toHaveBeenCalled();
    expect(excluded).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog',{name:'미디어 감상'})).toBeTruthy();
  });
  it('lets Android Back close the confirmation before the viewer',()=>{
    renderViewer();open();
    let consumed=false;
    act(()=>{consumed=backRef.current?.()??false;});
    expect(consumed).toBe(true);
    expect(screen.queryByRole('dialog',{name:'Lumi에서 제외'})).toBeNull();
    expect(screen.getByRole('dialog',{name:'미디어 감상'})).toBeTruthy();
    act(()=>{expect(backRef.current?.()).toBe(false);});
  });
  it('sends the agreed body and reports success only after a matching receipt',async()=>{
    echoReceipt();
    const {excluded}=renderViewer();
    open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await waitFor(()=>expect(excluded).toHaveBeenCalledTimes(1));
    const sent=bodies()[0];
    expect(mocks.api.mock.calls[0][0]).toBe('/v1/library/characters/exclusions');
    expect(sent).toMatchObject({version:1,libraryId,targetId:'char-77',assetId:'asset-1',revision});
    expect(sent.operationId).toMatch(/^[a-f0-9-]{36}$/);
    // A validated receipt retires the pending operation.
    await waitFor(()=>expect(stored('asset-1')).toBeNull());
  });
  it('refuses a malformed receipt before the asset is removed',async()=>{
    for(const bad of [
      {sequence:'5'},{sequence:5.5},{sequence:-1},{sequence:0},{revision:'short'},{pendingPc:'true'},
      {libraryId:'f'.repeat(32)},{targetId:'other'},{assetId:'asset-2'},{version:2},
      {operationId:'00000000-0000-0000-0000-000000000000'},
    ]){
      localStorage.clear();mocks.api.mockReset();
      mocks.api.mockImplementation(async()=>receipt(bad as never));
      const {view,excluded}=renderViewer();
      open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
      await screen.findByRole('alert');
      expect(excluded).not.toHaveBeenCalled();
      // The pending operation survives a reply that was not this operation's receipt.
      expect(stored('asset-1')).not.toBeNull();
      view.unmount();
    }
  });
  it('keeps the asset and the exact body on a transport failure',async()=>{
    mocks.api.mockImplementation(async()=>{throw new Error('연결 실패');});
    const {excluded}=renderViewer();
    open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await screen.findByText('연결 실패');
    expect(excluded).not.toHaveBeenCalled();
    const first=stored('asset-1');
    expect(first).toMatchObject({assetId:'asset-1'});
    fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(2));
    expect(bodies()[1]).toEqual(bodies()[0]);
    expect(stored('asset-1')).toEqual(first);
  });

  // Regression: a confirmed but unanswered operation must survive closing the confirmation and
  // reopening it for the same pair, including when the publication revision has advanced.
  it('replays the exact stored body after close and reopen with an advanced revision',async()=>{
    mocks.api.mockImplementation(async()=>{throw new Error('연결 실패');});
    const {view}=renderViewer();
    open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await screen.findByText('연결 실패');
    const original=stored('asset-1');
    expect(original.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(original.revision).toBe(revision);
    // Close the confirmation, then let the publication advance behind the still-open viewer.
    fireEvent.click(screen.getByRole('button',{name:'취소'}));
    const advanced='c'.repeat(64);
    view.rerender(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}} endpoint={endpoint}
      character={viewerCharacterContext(node('character:c'),{...index,revision:advanced})} onCharacterExcluded={vi.fn()}/>);
    // The pending operation survived the dismissal.
    expect(stored('asset-1')).toEqual(original);
    mocks.api.mockReset();echoReceipt();
    const excluded=vi.fn();
    view.rerender(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}} endpoint={endpoint}
      character={viewerCharacterContext(node('character:c'),{...index,revision:advanced})} onCharacterExcluded={excluded}/>);
    open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await waitFor(()=>expect(excluded).toHaveBeenCalledTimes(1));
    const sent=bodies()[0];
    // The exact stored body is resent: same operation id AND the old revision, because the
    // server looks up the receipt before it compares revisions.
    expect(sent).toEqual(original);
    expect(sent.revision).toBe(revision);
    await waitFor(()=>expect(stored('asset-1')).toBeNull());
  });

  // Regression: the pending operation belongs to one asset, so a swipe must not let the next
  // asset's confirmation replay it.
  it('does not replay one asset\'s pending operation for another asset',async()=>{
    mocks.api.mockImplementation(async()=>{throw new Error('연결 실패');});
    const {view,excluded}=renderViewer();
    open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await screen.findByText('연결 실패');
    const first=stored('asset-1');
    const character=viewerCharacterContext(node('character:c'),index);
    view.rerender(<Viewer items={items} index={1} onIndex={()=>{}} onClose={()=>{}} endpoint={endpoint} character={character} onCharacterExcluded={excluded}/>);
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Lumi에서 제외'})).toBeNull());
    // The first asset's operation is still pending under its own key, untouched.
    expect(stored('asset-1')).toEqual(first);
    expect(stored('asset-2')).toBeNull();
    open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(2));
    const [sentFirst,sentSecond]=bodies();
    expect(sentSecond.assetId).toBe('asset-2');
    expect(sentSecond.operationId).not.toBe(sentFirst.operationId);
    expect(stored('asset-2')).toMatchObject({assetId:'asset-2'});
  });

  // Regression: two endpoints can carry the same library/character/asset ids, so a late reply
  // from the previous endpoint must not be accepted as the current endpoint's success.
  it('ignores a late reply from another endpoint holding the same ids',async()=>{
    const other='https://other.invalid';
    let release!:(value:unknown)=>void;
    mocks.api.mockImplementation((_path:string,_signal:AbortSignal,body:unknown)=>
      new Promise(resolve=>{release=()=>resolve(receipt({operationId:(body as {operationId:string}).operationId}));}));
    const {view,excluded}=renderViewer(undefined,vi.fn(),other);
    open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(1));
    const pendingAtOther=stored('asset-1',other);
    expect(pendingAtOther).not.toBeNull();
    // The viewer is now pointed at the original endpoint for the same ids.
    const excludedNow=vi.fn();
    view.rerender(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}} endpoint={endpoint}
      character={viewerCharacterContext(node('character:c'),index)} onCharacterExcluded={excludedNow}/>);
    await act(async()=>release(undefined));
    // The other endpoint's reply is not this endpoint's success.
    expect(excludedNow).not.toHaveBeenCalled();
    // ...and the other endpoint's pending operation was neither consumed nor duplicated here.
    expect(stored('asset-1',other)).toEqual(pendingAtOther);
    expect(stored('asset-1')).toBeNull();
  });

  // Regression: unmounting during an in-flight confirm must not let the settled promise act.
  it('ignores a reply that arrives after unmount',async()=>{
    let release!:(value:unknown)=>void;
    mocks.api.mockImplementation((_path:string,_signal:AbortSignal,body:unknown)=>
      new Promise(resolve=>{release=()=>resolve(receipt({operationId:(body as {operationId:string}).operationId}));}));
    const {view,excluded}=renderViewer();
    open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async()=>release(undefined));
    expect(excluded).not.toHaveBeenCalled();
    // The confirmed operation stays durable, so it can still be retried after a reopen.
    expect(stored('asset-1')).not.toBeNull();
  });

  it('retires the pending operation only on an authoritative coded rejection',async()=>{
    const refused:[string,RegExp][] = [
      ['characterReferenceProtected',/기준 이미지로 쓰이는 자산/],
      ['characterSnapshotChanged',/캐릭터 보기가 변경되었습니다/],
      ['characterExclusionUnsupported',/서버에 캐릭터 제외 기능이 없습니다/],
      ['libraryMismatch',/다른 라이브러리/],
    ];
    for(const [code,expected] of refused){
      localStorage.clear();mocks.api.mockReset();
      mocks.api.mockImplementation(async()=>{throw new ApiError('서버가 요청을 거부했습니다.',409,{detail:{code}});});
      const {view,excluded}=renderViewer();
      open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
      await screen.findByText(expected);
      expect(excluded).not.toHaveBeenCalled();
      // Nothing was accepted, so the operation is retired rather than left to resend.
      expect(stored('asset-1')).toBeNull();
      view.unmount();
    }
  });
  it('reads a coded reason from the rejection body root as well as its detail object',async()=>{
    // The native bridge passes the parsed body as `details`, so a flat `code` must also work.
    mocks.api.mockImplementation(async()=>{throw new ApiError('거부',409,{code:'libraryMismatch'});});
    renderViewer();open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await screen.findByText(/다른 라이브러리/);
    expect(stored('asset-1')).toBeNull();
  });
  it('keeps the pending operation for an uncoded failure',async()=>{
    mocks.api.mockImplementation(async()=>{throw new ApiError('서버가 요청을 처리하지 못했습니다.',500,{detail:{code:'somethingNew'}});});
    renderViewer();open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
    await screen.findByText(/서버가 요청을 처리하지 못했습니다/);
    // An unrecognized failure proves nothing about acceptance, so the retry identity stays.
    expect(stored('asset-1')).not.toBeNull();
  });
  it('does not send when the pending operation cannot be stored durably',async()=>{
    const setItem=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota');});
    try{
      renderViewer();open();fireEvent.click(screen.getByRole('button',{name:'제외'}));
      await screen.findByText(/안전하게 보관할 수 없습니다/);
      expect(mocks.api).not.toHaveBeenCalled();
    }finally{setItem.mockRestore();}
  });
});

describe('character exclusion refresh',()=>{
  const backRef:{current:(()=>boolean)|null}={current:null};
  const onOpen=vi.fn();
  const props={active:true,paused:false,density:1,refreshKey:1,onOpen,backRef,onExit:vi.fn()};
  let pageItems:Asset[];
  beforeEach(()=>{
    pageItems=[...items];
    vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
    mocks.api.mockReset();onOpen.mockReset();backRef.current=null;
  });
  afterEach(()=>vi.unstubAllGlobals());
  it('hands the viewer a character context only for a character gallery',async()=>{
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/characters')?structuredClone(index):{revision,items:pageItems,totalCount:2,sourceCount:2,has_more:false,next_cursor:null});
    render(<CharacterBrowser {...props}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
    // The action is viewer-only: no gallery offers it from its own header.
    expect(screen.queryByRole('button',{name:/에서 제외/})).toBeNull();
    fireEvent.click(await screen.findByRole('button',{name:'Group · 2개'}));
    expect(screen.queryByRole('button',{name:/에서 제외/})).toBeNull();
    fireEvent.click(await screen.findByRole('button',{name:'Lumi · 2개'}));
    await screen.findByText('asset-1');
    expect(screen.queryByRole('button',{name:/에서 제외/})).toBeNull();
    fireEvent.click(screen.getByText('asset-1'));
    await waitFor(()=>expect(onOpen).toHaveBeenCalled());
    expect(onOpen.mock.calls[0][2]).toMatchObject({targetId:'char-77',libraryId,revision});
  });
  it('shows the excluded asset going away by refetching the character scope',async()=>{
    mocks.api.mockImplementation(async(path:string)=>{
      if(path.endsWith('/characters'))return structuredClone(index);
      return {revision,items:pageItems,totalCount:pageItems.length,sourceCount:2,has_more:false,next_cursor:null};
    });
    const result=render(<CharacterBrowser {...props}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Series · 2개'}));
    fireEvent.click(await screen.findByRole('button',{name:'Group · 2개'}));
    fireEvent.click(await screen.findByRole('button',{name:'Lumi · 2개'}));
    await screen.findByText('asset-1');
    pageItems=[items[1]];
    result.rerender(<CharacterBrowser {...props} refreshKey={2}/>);
    await waitFor(()=>expect(screen.queryByText('asset-1')).toBeNull());
    expect(screen.getByText('asset-2')).toBeTruthy();
  });
});
