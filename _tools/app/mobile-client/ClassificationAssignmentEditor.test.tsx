import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,errorText:(e:unknown)=>e instanceof Error?e.message:String(e)}));
import {ClassificationAssignmentEditor,collapsedForAssignment,flattenAssignmentTree,searchAssignmentTree} from './ClassificationAssignmentEditor';
import type {AssignmentClassification,ClassificationAssignmentState} from './ClassificationAssignmentEditor';

/** A three-level hierarchy plus a second root, so ancestry and collapsing are observable. */
const classifications:AssignmentClassification[]=[
  {id:'game',kind:'root',name:'게임',parentId:null,iconKey:'puzzle',colorKey:'blue'},
  {id:'genshin',kind:'tag',name:'원신',parentId:'game',iconKey:null,colorKey:null},
  {id:'anime',kind:'root',name:'애니',parentId:null,iconKey:null,colorKey:null},
  {id:'nahia',kind:'tag',name:'나히아',parentId:'anime',iconKey:null,colorKey:null},
  {id:'yuri',kind:'tag',name:'백합',parentId:'anime',iconKey:null,colorKey:null},
  {id:'bochi',kind:'tag',name:'봇치 더 록',parentId:'anime',iconKey:null,colorKey:null},
  {id:'manga',kind:'root',name:'만화',parentId:null,iconKey:null,colorKey:null},
];
const state=(overrides:Partial<ClassificationAssignmentState>={}):ClassificationAssignmentState=>({
  adopted:true,assetId:'asset_1',classificationId:'yuri',pending:false,blocked:false,
  conflictCode:null,conflictMessage:'',libraryId:'a'.repeat(32),epoch:1,classifications,...overrides,
});
afterEach(()=>{cleanup();vi.useRealTimers();});
beforeEach(()=>{mocks.native.mockReset();mocks.native.mockResolvedValue(state());});

const names=()=>screen.queryAllByRole('radio').map(node=>node.getAttribute('aria-label'));
const checked=()=>screen.queryAllByRole('radio').filter(node=>(node as HTMLInputElement).getAttribute('aria-checked')==='true').map(node=>node.getAttribute('aria-label'));

describe('Classification assignment picker',()=>{
  it('flattens only real Classification nodes, parent-first',()=>{
    const flat=flattenAssignmentTree(classifications,new Set());
    const at=new Map(flat.map((row,index)=>[row.classification.id,index]));
    expect(new Set(flat.map(row=>row.classification.id))).toEqual(new Set(classifications.map(row=>row.id)));
    expect(Object.fromEntries(flat.map(row=>[row.classification.id,row.depth])))
      .toEqual({game:0,genshin:1,anime:0,nahia:1,yuri:1,bochi:1,manga:0});
    // The ordering invariant a parent-first flatten must hold: a parent always precedes its
    // children. Asserting it directly rather than comparing one collation's exact sequence.
    for(const row of flat){
      if(row.classification.parentId)expect(at.get(row.classification.parentId)!).toBeLessThan(at.get(row.classification.id)!);
    }
    // Every node knows whether it can be expanded, which is what decides expander vs leaf.
    expect(Object.fromEntries(flat.map(row=>[row.classification.id,row.hasChildren])))
      .toEqual({game:true,genshin:false,anime:true,nahia:false,yuri:false,bochi:false,manga:false});
  });

  it('hides a collapsed branch and keeps its siblings',()=>{
    const collapsed=flattenAssignmentTree(classifications,new Set(['anime'])).map(row=>row.classification.id);
    expect(collapsed).toContain('anime');
    // The collapsed branch's children are gone; the branch itself and every unrelated node stay.
    for(const hidden of ['nahia','yuri','bochi'])expect(collapsed).not.toContain(hidden);
    for(const kept of ['game','genshin','manga'])expect(collapsed).toContain(kept);
  });

  it('shows a node whose parent is missing at the top level instead of dropping it',()=>{
    const orphaned=[...classifications,{id:'orphan',kind:'tag' as const,name:'고아',parentId:'absent',iconKey:null,colorKey:null}];
    const flat=flattenAssignmentTree(orphaned,new Set());
    expect(flat.find(row=>row.classification.id==='orphan')?.depth).toBe(0);
  });

  it('terminates on a malformed parent cycle instead of looping',()=>{
    const cyclic:AssignmentClassification[]=[
      {id:'a',kind:'tag',name:'A',parentId:'b',iconKey:null,colorKey:null},
      {id:'b',kind:'tag',name:'B',parentId:'a',iconKey:null,colorKey:null},
    ];
    expect(new Set(flattenAssignmentTree(cyclic,new Set()).map(row=>row.classification.id))).toEqual(new Set(['a','b']));
  });

  it('expands exactly the current Classification ancestor path',()=>{
    // Only the current Classification's ancestor path is open; every other node is collapsed.
    const open=new Set(classifications.map(row=>row.id));
    for(const id of collapsedForAssignment(classifications,'yuri'))open.delete(id);
    expect([...open].sort()).toEqual(['anime','yuri']);
    // 미분류 and an unknown id expand nothing at all.
    expect(collapsedForAssignment(classifications,null).size).toBe(classifications.length);
    expect(collapsedForAssignment(classifications,'missing').size).toBe(classifications.length);
  });

  const byId=(id:string)=>classifications.find(row=>row.id===id)!;

  it('searches the local tree and reports each match with its ancestry',()=>{
    expect(searchAssignmentTree(classifications,'백합')).toEqual([
      {classification:byId('yuri'),breadcrumb:'애니 / 백합'},
    ]);
    // A substring several names share returns every match, each with its ancestry.
    expect(new Map(searchAssignmentTree(classifications,'아').map(row=>[row.classification.id,row.breadcrumb])))
      .toEqual(new Map([['nahia','애니 / 나히아']]));
    expect(new Map(searchAssignmentTree(classifications,'록').map(row=>[row.classification.id,row.breadcrumb])))
      .toEqual(new Map([['bochi','애니 / 봇치 더 록']]));
    // Searching a descendant's name does not drag in its ancestors.
    expect(searchAssignmentTree(classifications,'애니').map(row=>row.classification.id)).toEqual(['anime']);
    expect(searchAssignmentTree(classifications,'  ')).toEqual([]);
    expect(searchAssignmentTree(classifications,'없는분류')).toEqual([]);
  });

  it('loads the whole tree from the native assignment-state bridge',async()=>{
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByRole('radio',{name:'미분류'});
    expect(mocks.native).toHaveBeenCalledWith('classificationAssignmentState',{assetId:'asset_1'},expect.any(AbortSignal));
    // Nothing here reads the published Classification list: the replica is the only source.
    expect(mocks.native.mock.calls.every(([operation])=>operation.startsWith('classificationAssignment'))).toBe(true);
  });

  it('renders the hierarchy with the current branch open and unrelated branches closed',async()=>{
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByRole('radio',{name:'미분류'});
    // 애니 is open because it holds the current Classification, so its children render.
    for(const shown of ['미분류','애니','나히아','백합','봇치 더 록','게임','만화'])expect(names()).toContain(shown);
    // 게임 sits on another root and stays collapsed, so its child is hidden while the branch
    // itself renders with an expander.
    expect(names()).not.toContain('원신');
    expect(screen.getByRole('button',{name:'게임 펼치기'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'애니 펼치기'})).toBeNull();
    expect(screen.getByRole('button',{name:'애니 접기'})).toBeTruthy();
  });

  it('selects exactly one Classification and offers 미분류 as its own choice',async()=>{
    mocks.native.mockImplementation((operation:string)=>
      operation==='classificationAssignmentSet'
        ? Promise.resolve(state({classificationId:null,pending:true}))
        : Promise.resolve(state()));
    // A click is the whole operation, so the picker closes on the durable enqueue. The
    // selection the write returned is what a reopened picker shows, which is asserted below.
    const {rerender}=render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByRole('radio',{name:'미분류'});
    expect(checked()).toEqual(['백합']);
    fireEvent.click(screen.getByRole('radio',{name:'미분류'}));
    await waitFor(()=>expect(mocks.native).toHaveBeenLastCalledWith('classificationAssignmentSet',{assetId:'asset_1',classificationId:null}));
    // Reopening reflects the native durable state: 미분류 is now the single selection.
    mocks.native.mockResolvedValue(state({classificationId:null,pending:true}));
    rerender(<ClassificationAssignmentEditor assetId="asset_1" open={false} onClose={()=>{}}/>);
    rerender(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await waitFor(()=>expect(checked()).toEqual(['미분류']));
  });

  it('expands and collapses a branch without changing the selection',async()=>{
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByRole('radio',{name:'미분류'});
    fireEvent.click(screen.getByRole('button',{name:'게임 펼치기'}));
    expect(names()).toContain('게임');
    expect(screen.getByRole('button',{name:'게임 접기'})).toBeTruthy();
    expect(checked()).toEqual(['백합']);
  });

  it('filters to flat results with a breadcrumb when searching',async()=>{
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByRole('radio',{name:'미분류'});
    fireEvent.change(screen.getByRole('searchbox',{name:'분류 검색'}),{target:{value:'백합'}});
    // A flat result list, so the hierarchy rows are gone and 미분류 is not offered as a match.
    expect(names()).toEqual(['백합']);
    expect(screen.getByText('애니 / 백합')).toBeTruthy();
    // The result carries its ancestry, and a bare name alone would be ambiguous.
    expect(screen.queryByRole('radio',{name:'미분류'})).toBeNull();
    expect(screen.getByRole('radio',{name:'백합'}).getAttribute('aria-checked')).toBe('true');
  });

  it('reports no matches for a query that names no Classification',async()=>{
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByRole('radio',{name:'미분류'});
    fireEvent.change(screen.getByRole('searchbox',{name:'분류 검색'}),{target:{value:'없는분류'}});
    expect(screen.getByText('일치하는 분류가 없습니다.')).toBeTruthy();
    expect(names()).toEqual([]);
  });

  it('sends only the Asset and desired Classification, then closes on a durable enqueue',async()=>{
    const onClose=vi.fn();
    mocks.native.mockImplementation((operation:string)=>
      operation==='classificationAssignmentSet'
        ? Promise.resolve(state({classificationId:'game',pending:true}))
        : Promise.resolve(state()));
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={onClose}/>);
    await screen.findByRole('radio',{name:'미분류'});
    fireEvent.click(screen.getByRole('button',{name:'게임 펼치기'}));
    fireEvent.click(screen.getByRole('radio',{name:'게임'}));
    await waitFor(()=>expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.native).toHaveBeenLastCalledWith('classificationAssignmentSet',{assetId:'asset_1',classificationId:'game'});
  });

  it('sends a null Classification for 미분류 and closes',async()=>{
    const onClose=vi.fn();
    mocks.native.mockImplementation((operation:string)=>
      operation==='classificationAssignmentSet'
        ? Promise.resolve(state({classificationId:null,pending:true}))
        : Promise.resolve(state()));
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={onClose}/>);
    await screen.findByRole('radio',{name:'미분류'});
    fireEvent.click(screen.getByRole('radio',{name:'미분류'}));
    await waitFor(()=>expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.native).toHaveBeenLastCalledWith('classificationAssignmentSet',{assetId:'asset_1',classificationId:null});
  });

  it('keeps the picker open and reports an error when the durable enqueue fails',async()=>{
    const onClose=vi.fn();
    mocks.native.mockImplementation((operation:string)=>
      operation==='classificationAssignmentSet'
        ? Promise.reject(new Error('분류 복제본을 열 수 없습니다.'))
        : Promise.resolve(state()));
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={onClose}/>);
    await screen.findByRole('radio',{name:'미분류'});
    fireEvent.click(screen.getByRole('button',{name:'게임 펼치기'}));
    fireEvent.click(screen.getByRole('radio',{name:'게임'}));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe('분류 복제본을 열 수 없습니다.');
    expect(onClose).not.toHaveBeenCalled();
    // The previous selection is still the current one: nothing was optimistically applied.
    expect(checked()).toEqual(['백합']);
  });

  it('shows 저장 대기 for a pending assignment and clears it on the next confirmed read',async()=>{
    vi.useFakeTimers();
    mocks.native.mockResolvedValueOnce(state({classificationId:'game',pending:true}))
      .mockResolvedValueOnce(state({classificationId:'game',pending:false}));
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await vi.waitFor(()=>expect(mocks.native).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(()=>expect(screen.getByText('저장 대기')).toBeTruthy());
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(()=>expect(mocks.native).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(()=>expect(screen.queryByText('저장 대기')).toBeNull());
  });

  it('shows a blocked conflict and refuses another selection',async()=>{
    mocks.native.mockResolvedValue(state({classificationId:'game',blocked:true,conflictCode:'classificationNotFound',conflictMessage:'분류 변경을 적용할 수 없습니다. 분류가 삭제되었는지 확인해 주세요.'}));
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByText('분류 변경을 적용할 수 없습니다. 분류가 삭제되었는지 확인해 주세요.');
    expect((screen.getByRole('radio',{name:'게임'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('radio',{name:'미분류'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio',{name:'게임'}));
    expect(mocks.native).toHaveBeenCalledTimes(1);
  });

  it('reports an unadopted replica instead of offering any choice',async()=>{
    mocks.native.mockResolvedValue({adopted:false,classifications:[]});
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByText('분류 동기화가 준비된 뒤 편집할 수 있습니다.');
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('renders an authoritative unassigned Asset with 미분류 current and no branch expanded',async()=>{
    mocks.native.mockResolvedValue(state({classificationId:null}));
    render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByRole('radio',{name:'미분류'});
    expect(checked()).toEqual(['미분류']);
    // Nothing is open, so only the roots render and no child is offered.
    expect(new Set(names())).toEqual(new Set(['미분류','애니','게임','만화']));
  });

  it('discards the previous Asset tree, selection and expansion when reopened for another Asset',async()=>{
    mocks.native.mockResolvedValue(state({assetId:'asset_1',classificationId:'yuri'}));
    const {rerender}=render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByRole('radio',{name:'백합'});
    // The next Asset's read never resolves, so anything left over would be visibly stale.
    mocks.native.mockImplementation(()=>new Promise(()=>{}));
    rerender(<ClassificationAssignmentEditor assetId="asset_2" open onClose={()=>{}}/>);
    await waitFor(()=>expect(screen.queryByRole('radio')).toBeNull());
    expect(mocks.native).toHaveBeenLastCalledWith('classificationAssignmentState',{assetId:'asset_2'},expect.any(AbortSignal));
  });

  it('stops polling once the picker closes',async()=>{
    const {rerender}=render(<ClassificationAssignmentEditor assetId="asset_1" open onClose={()=>{}}/>);
    await screen.findByRole('radio',{name:'미분류'});
    expect(mocks.native).toHaveBeenCalledTimes(1);
    rerender(<ClassificationAssignmentEditor assetId="asset_1" open={false} onClose={()=>{}}/>);
    await waitFor(()=>expect(screen.queryByRole('radio')).toBeNull());
    expect(mocks.native).toHaveBeenCalledTimes(1);
  });
});
