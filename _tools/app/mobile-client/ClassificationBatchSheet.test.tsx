import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
import {ClassificationBatchSheet} from './ClassificationBatchSheet';
import type {ClassificationAssignmentState} from './ClassificationAssignmentEditor';
import {ASSET_LIST_CHANGED_EVENT} from './listGeneration';
const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,errorText:(e:unknown)=>e instanceof Error?e.message:String(e)}));
vi.mock('./BottomSheet',()=>({BottomSheet:({title,onClose,children}:{title:string;onClose():void;children:ReactNode})=><section><h2>{title}</h2>{children}<button onClick={onClose}>닫기</button></section>}));
const state=(assetId='a',classificationId:string|null='old',overrides:Partial<ClassificationAssignmentState>={}):ClassificationAssignmentState=>({adopted:true,assetId,classificationId,classifications:[
  {id:'old',name:'이전',kind:'root',parentId:null,iconKey:null,colorKey:null},
  {id:'new',name:'게임',kind:'root',parentId:null,iconKey:null,colorKey:null},
  {id:'child',name:'원신',kind:'work',parentId:'new',iconKey:null,colorKey:null},
],...overrides});
const props=(assetIds=['a','b'])=>({assetIds,onClose:vi.fn(),onComplete:vi.fn(),onBusyChange:vi.fn()});
const many=(ids:string[],overrides:Record<string,Partial<{ok:boolean;pending:boolean;blocked:boolean;message:string}>>={})=>({adopted:true,results:ids.map(assetId=>({assetId,ok:true,pending:false,blocked:false,conflictCode:null,message:'',...overrides[assetId]}))});
const setMany=()=>mocks.native.mock.calls.filter(([op])=>op==='classificationAssignmentSetMany').map(([,payload])=>payload);
beforeEach(()=>mocks.native.mockImplementation((op:string,p:{assetId:string;assetIds:string[];classificationId:string|null})=>op==='classificationAssignmentSetMany'?Promise.resolve(many(p.assetIds)):Promise.resolve(state(p.assetId,'old'))));
afterEach(()=>{cleanup();vi.restoreAllMocks();mocks.native.mockReset();});
describe('ClassificationBatchSheet',()=>{
  it('warns before replacing and sends one classification intent for every asset in a single native call, including an already assigned one',async()=>{
    mocks.native.mockImplementation((op:string,p:{assetId:string;assetIds:string[];classificationId:string|null})=>op==='classificationAssignmentSetMany'?Promise.resolve(many(p.assetIds)):Promise.resolve(state(p.assetId,p.assetId==='b'?'new':'old')));
    const callbacks=props();render(<ClassificationBatchSheet {...callbacks}/>);
    expect(screen.getByRole('heading').textContent).toBe('분류 변경 (2개)');
    fireEvent.click(await screen.findByRole('radio',{name:'게임'}));
    expect(screen.getByText('1개의 현재 분류가 선택한 분류로 대체됩니다.')).toBeTruthy();
    expect(setMany()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(callbacks.onComplete).toHaveBeenCalledWith('2/2개 분류 변경'));
    expect(setMany()).toEqual([{assetIds:['a','b'],classificationId:'new'}]);
    expect(mocks.native.mock.calls.filter(([op])=>op==='classificationAssignmentSet')).toHaveLength(0);
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });
  it('reports per-asset failures, refreshes once and reports partial success',async()=>{
    const changed=vi.fn();window.addEventListener(ASSET_LIST_CHANGED_EVENT,changed);
    try{
      mocks.native.mockImplementation((op:string,p:{assetId:string;assetIds:string[];classificationId:string|null})=>op==='classificationAssignmentSetMany'?Promise.resolve(many(p.assetIds,{b:{ok:false,message:'분류 저장 실패'}})):Promise.resolve(state(p.assetId,'old')));
      const callbacks=props(['a','b','c']);render(<ClassificationBatchSheet {...callbacks}/>);
      fireEvent.click(await screen.findByRole('radio',{name:'게임'}));fireEvent.click(screen.getByRole('button',{name:'적용'}));
      await waitFor(()=>expect(callbacks.onComplete).toHaveBeenCalledWith('2/3개 분류 변경 · 1개 실패'));
      expect(screen.getByText(/분류 저장 실패/)).toBeTruthy();expect(changed).toHaveBeenCalledOnce();
      expect(setMany()).toHaveLength(1);
    }finally{window.removeEventListener(ASSET_LIST_CHANGED_EVENT,changed);}
  });
  it('treats a failed native call as a failure of that request only and keeps reporting',async()=>{
    mocks.native.mockImplementation((op:string,p:{assetId:string;assetIds:string[]})=>op==='classificationAssignmentSetMany'?Promise.reject(new Error('연결 끊김')):Promise.resolve(state(p.assetId,'old')));
    const callbacks=props(['a','b']);render(<ClassificationBatchSheet {...callbacks}/>);
    fireEvent.click(await screen.findByRole('radio',{name:'게임'}));fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(callbacks.onComplete).toHaveBeenCalledWith('0/2개 분류 변경 · 2개 실패'));
    expect(screen.getByText(/연결 끊김/)).toBeTruthy();
  });
  it('chunks at 100 assets, shows progress per request and prevents closing during writes',async()=>{
    const ids=Array.from({length:150},(_,index)=>`asset-${index}`),resolvers:Array<()=>void>=[];
    mocks.native.mockImplementation((op:string,p:{assetId:string;assetIds:string[];classificationId:string|null})=>op==='classificationAssignmentSetMany'?new Promise(resolve=>resolvers.push(()=>resolve(many(p.assetIds)))):Promise.resolve(state(p.assetId)));
    const callbacks=props(ids);render(<ClassificationBatchSheet {...callbacks}/>);
    fireEvent.click(await screen.findByRole('radio',{name:'미분류'}));fireEvent.click(screen.getByRole('button',{name:'적용'}));
    expect(resolvers).toHaveLength(1);expect(screen.getByText('0/150개 처리')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'닫기'}));expect(callbacks.onClose).not.toHaveBeenCalled();
    await act(async()=>resolvers[0]());await waitFor(()=>expect(resolvers).toHaveLength(2));
    expect(screen.getByText('100/150개 처리')).toBeTruthy();
    await act(async()=>resolvers[1]());
    await waitFor(()=>expect(callbacks.onComplete).toHaveBeenCalledWith('150/150개 분류 변경'));
    expect(setMany().map(payload=>payload.assetIds.length)).toEqual([100,50]);
    expect(setMany().every(payload=>payload.classificationId===null)).toBe(true);
  });
  it('skips blocked, unadopted and unreadable assets and reports pending durable writes accurately',async()=>{
    mocks.native.mockImplementation((op:string,p:{assetId:string;assetIds:string[];classificationId:string|null})=>{
      if(op==='classificationAssignmentSetMany')return Promise.resolve(many(p.assetIds,{a:{pending:true}}));
      if(p.assetId==='b')return Promise.resolve(state('b','old',{blocked:true,conflictMessage:'분류 충돌'}));
      if(p.assetId==='c')return Promise.resolve(state('c','old',{adopted:false}));
      if(p.assetId==='d')return Promise.reject(new Error('읽기 실패'));
      return Promise.resolve(state(p.assetId,'old',{pending:true}));
    });
    const callbacks=props(['a','b','c','d']);render(<ClassificationBatchSheet {...callbacks}/>);
    fireEvent.click(await screen.findByRole('radio',{name:'게임'}));expect(screen.getByRole('alert').textContent).toContain('3개는 변경할 수 없습니다.');
    expect(screen.getByText(/대기 중인 분류도 바뀝니다/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'적용'}));
    await waitFor(()=>expect(callbacks.onComplete).toHaveBeenCalledWith('1/4개 분류 변경 · 3개 실패 · 1개 저장 대기'));
    expect(setMany()).toEqual([{assetIds:['a'],classificationId:'new'}]);
  });
  it('uses the viewer search and breadcrumb choices',async()=>{
    render(<ClassificationBatchSheet {...props()}/>);await screen.findByRole('radio',{name:'게임'});
    fireEvent.change(screen.getByRole('searchbox',{name:'분류 검색'}),{target:{value:'ㅇㅅ'}});
    expect(screen.getByRole('radio',{name:'원신'})).toBeTruthy();expect(screen.getByText('게임 › 원신')).toBeTruthy();expect(screen.queryByRole('radio',{name:'미분류'})).toBeNull();
  });
});
