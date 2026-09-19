import {ASSET_LIST_CHANGED_EVENT} from './listGeneration';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ChevronDownIcon,ChevronRightIcon,FolderIcon,MagnifyingGlassIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {Dialog,DialogDescription,IconButton} from './ui';
import {errorText,native} from './transport';
import {treeBreadcrumb} from './homeModel';
import {ClassificationIcon,classificationColor} from '../src/classification/classificationAppearance';

/**
 * One live Classification from the native replica.
 *
 * `kind` is constrained to the contract's three kinds, because the replica parser refuses
 * anything else: a value outside this set could not have reached the client.
 */
export interface AssignmentClassification {
  id:string;
  kind:'root'|'work'|'tag';
  name:string;
  parentId:string|null;
  iconKey:string|null;
  colorKey:string|null;
}
export interface ClassificationAssignmentState {
  adopted:boolean;
  assetId?:string;
  classificationId?:string|null;
  pending?:boolean;
  blocked?:boolean;
  conflictCode?:string|null;
  conflictMessage?:string;
  libraryId?:string|null;
  epoch?:number|null;
  classifications:AssignmentClassification[];
}
export interface FlatAssignmentRow {classification:AssignmentClassification;depth:number;hasChildren:boolean}

/**
 * The Classification hierarchy ordered parent-first, with each node's depth.
 *
 * Only real Classification nodes are projected. The Library navigation tree additionally
 * carries Character series, groups, characters and synthetic `character-group:*` ids, and
 * those are deliberately absent here: none of them is an assignable Classification, so
 * reusing that projection would offer targets the authority cannot accept.
 *
 * A node whose parent the replica does not hold is shown at the top level rather than
 * dropped, and `seen` bounds the walk so a malformed parent chain renders partially
 * instead of looping.
 */
export function flattenAssignmentTree(rows:AssignmentClassification[],collapsed:Set<string>):FlatAssignmentRow[] {
  const known=new Set(rows.map(row=>row.id));
  const byParent=new Map<string|null,AssignmentClassification[]>();
  for(const row of rows){
    const parent=row.parentId&&known.has(row.parentId)?row.parentId:null;
    const list=byParent.get(parent)??[];
    list.push(row);
    byParent.set(parent,list);
  }
  const sort=(list:AssignmentClassification[])=>list.sort((a,b)=>a.name.localeCompare(b.name,'ko')||a.id.localeCompare(b.id));
  for(const list of byParent.values())sort(list);
  // A node belongs to the projected forest iff its parent chain reaches a node with no
  // parent *present in the list*. Only a parent cycle fails that test — a node merely hidden
  // by a collapsed ancestor still has a legitimate place, so recovering it here would
  // resurrect exactly the rows the caller asked to collapse.
  const byId=new Map<string,AssignmentClassification>(rows.map(row=>[row.id,row] as const));
  const inCycle=(row:AssignmentClassification):boolean=>{
    const seen=new Set<string>();
    let current:AssignmentClassification|undefined=row;
    while(current){
      if(seen.has(current.id))return true;
      seen.add(current.id);
      const parent:AssignmentClassification|undefined=current.parentId?byId.get(current.parentId):undefined;
      if(!parent)return false;
      current=parent;
    }
    return false;
  };
  const result:FlatAssignmentRow[]=[],seen=new Set<string>();
  const visit=(row:AssignmentClassification,depth:number)=>{
    if(seen.has(row.id))return;
    seen.add(row.id);
    const children=byParent.get(row.id)??[];
    result.push({classification:row,depth,hasChildren:children.length>0});
    if(!collapsed.has(row.id))for(const child of children)visit(child,depth+1);
  };
  for(const row of byParent.get(null)??[])visit(row,0);
  for(const row of sort([...rows]))if(!seen.has(row.id)&&inCycle(row))visit(row,0);
  return result;
}

/**
 * Flat search results over the replicated tree, each with the ancestry that disambiguates it.
 *
 * Search is a pure filter over local replica state, so it works with no network at all. The
 * breadcrumb is included per row because Classification names repeat across branches and a
 * bare name would not say which one a result is.
 */
export function searchAssignmentTree(rows:AssignmentClassification[],query:string):{classification:AssignmentClassification;breadcrumb:string}[] {
  const needle=query.trim().toLocaleLowerCase('ko');
  if(!needle)return [];
  return rows
    .filter(row=>row.name.toLocaleLowerCase('ko').includes(needle))
    .map(row=>({classification:row,breadcrumb:treeBreadcrumb(row,rows)}))
    .sort((a,b)=>a.classification.name.localeCompare(b.classification.name,'ko')
      ||a.breadcrumb.localeCompare(b.breadcrumb,'ko')||a.classification.id.localeCompare(b.classification.id));
}

/**
 * The ids left collapsed when the picker opens for a given assignment.
 *
 * Everything starts collapsed and only the selected Classification's ancestor path is
 * opened, so unrelated branches stay closed instead of presenting the whole library. This is
 * local to the picker: the Library drawer keeps its own expansion state, so opening the
 * editor cannot rearrange navigation and navigating cannot rearrange the editor.
 */
export function collapsedForAssignment(rows:AssignmentClassification[],classificationId:string|null):Set<string> {
  const collapsed=new Set(rows.map(row=>row.id));
  if(!classificationId)return collapsed;
  const byId=new Map(rows.map(row=>[row.id,row]));
  const seen=new Set<string>();
  let current=byId.get(classificationId);
  while(current&&!seen.has(current.id)){
    seen.add(current.id);
    collapsed.delete(current.id);
    current=current.parentId?byId.get(current.parentId):undefined;
  }
  return collapsed;
}

/**
 * Single-Asset Classification assignment picker.
 *
 * It reuses the mobile Library's Classification tree idiom — the same `.classification-index`
 * container, `.tree-row`/`.tree-expander`/`.tree-leaf`/`.tree-select` rows and
 * `.classification-search` field — so it reads as the surface the application already has
 * rather than a new one. Carrying `.classification-index` is also what gives it the existing
 * portrait left-side full-height drawer treatment, which `mobile.css` keys on.
 *
 * Assignment is single-valued, so the rows are a radio group with one `미분류` choice for the
 * canonical unassigned state. There is no confirm button: a tap is the whole operation, and
 * the picker closes as soon as the native layer has durably recorded the intent.
 */
export function ClassificationAssignmentEditor({assetId,open,onClose}:{assetId:string;open:boolean;onClose():void}) {
  const [state,setState]=useState<ClassificationAssignmentState|null>(null);
  const [collapsed,setCollapsed]=useState<Set<string>>(new Set());
  const [query,setQuery]=useState('');
  const [error,setError]=useState('');
  const [saving,setSaving]=useState(false);
  const alive=useRef(0);
  const load=useCallback(async(signal?:AbortSignal)=>{
    const generation=alive.current;
    try{
      const next=await native<ClassificationAssignmentState>('classificationAssignmentState',{assetId},signal);
      if(generation!==alive.current||signal?.aborted)return;
      setState(next);
      setError('');
      // Expansion is seeded from what the replica reports, so a reopened picker already shows
      // the current branch without waiting for a second read.
      setCollapsed(collapsedForAssignment(next.classifications,next.classificationId??null));
    }catch(reason){if(generation===alive.current&&!signal?.aborted)setError(errorText(reason));}
  },[assetId]);
  useEffect(()=>{
    if(!open)return;
    alive.current++;
    // A reopened picker must not show the previous Asset's tree or selection while the new
    // read is in flight — including its expansion, which is derived from that Asset.
    setState(null);
    setCollapsed(new Set());
    setQuery('');
    const controller=new AbortController();
    void load(controller.signal);
    // The replica converges on its own cadence, so re-reading while open is what turns a
    // still-pending choice into a confirmed one.
    const timer=window.setInterval(()=>void load(),5000);
    return()=>{alive.current++;controller.abort();window.clearInterval(timer);};
  },[open,assetId,load]);
  const select=async(classificationId:string|null)=>{
    if(saving||!state?.adopted||state.blocked)return;
    setSaving(true);setError('');
    try{
      // The write returns the durably-queued state. Closing only after it resolves is what
      // keeps the picker from ever showing a selection the native layer has not recorded.
      const next=await native<ClassificationAssignmentState>('classificationAssignmentSet',{assetId,classificationId});
      window.dispatchEvent(new Event(ASSET_LIST_CHANGED_EVENT));
      setState(next);
      onClose();
    }catch(reason){setError(errorText(reason));}
    finally{setSaving(false);}
  };
  const results=useMemo(()=>searchAssignmentTree(state?.classifications??[],query),[state,query]);
  const rows=useMemo(()=>flattenAssignmentTree(state?.classifications??[],collapsed),[state,collapsed]);
  const toggle=(id:string)=>setCollapsed(current=>{const next=new Set(current);next.has(id)?next.delete(id):next.add(id);return next;});
  const selectedId=state?.classificationId??null;
  // The native layer validates the destination against the same replica this tree renders
  // from, so a row can only ever name a live Classification.
  const row=(classification:AssignmentClassification,depth:number,hasChildren:boolean,label?:string)=><div key={classification.id} className={`tree-row${selectedId===classification.id?' is-current':''}`} style={depth?{paddingLeft:depth*16}:undefined}>
    {hasChildren?<button type="button" className="tree-expander" aria-label={`${classification.name} ${collapsed.has(classification.id)?'펼치기':'접기'}`} aria-expanded={!collapsed.has(classification.id)} onClick={()=>toggle(classification.id)}>{collapsed.has(classification.id)?<ChevronRightIcon/>:<ChevronDownIcon/>}</button>:<span className="tree-leaf"/>}
    <button type="button" className="tree-select" role="radio" aria-checked={selectedId===classification.id} aria-label={classification.name} disabled={saving||state?.blocked===true} onClick={()=>void select(classification.id)}>
      <span className="classification-assignment-mark" aria-hidden="true">{selectedId===classification.id?'●':'○'}</span>
      <ClassificationIcon kind={classification.kind} iconKey={classification.iconKey} style={{color:classificationColor(classification.colorKey)}}/>
      <span className="classification-assignment-name">{classification.name}</span>
      {label?<span className="classification-assignment-breadcrumb">{label}</span>:null}
    </button>
  </div>;
  return <Dialog open={open} title="분류" onClose={onClose}>
    <DialogDescription className="sr-only">현재 자산의 분류를 하나 선택하거나 미분류로 둡니다. 선택하면 즉시 적용되고, 오프라인 변경은 저장 대기 상태로 유지됩니다.</DialogDescription>
    <div className="classification-index classification-assignment-editor">
      <div className="dialog-header"><span>분류 변경</span><IconButton label="분류 선택 닫기" icon={XMarkIcon} onClick={onClose}/></div>
      <label className="classification-search"><MagnifyingGlassIcon/><input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="분류 검색" aria-label="분류 검색"/></label>
      {!state&&!error&&<div className="loading-line" role="status" aria-label="분류 상태를 불러오는 중"/>}
      {error&&<p className="error-message" role="alert">{error}</p>}
      {state&&!state.adopted&&<p className="hint">분류 동기화가 준비된 뒤 편집할 수 있습니다.</p>}
      {state?.adopted&&<div className="classification-tree" role="radiogroup" aria-label="분류 선택">
        {query.trim()
          ? (results.length
            ? <div className="classification-assignment-search-results">{results.map(({classification,breadcrumb})=>row(classification,0,false,breadcrumb))}</div>
            : <p className="hint">일치하는 분류가 없습니다.</p>)
          : <>
            <div className={`tree-row${selectedId===null?' is-current':''}`}>
              <span className="tree-leaf"/>
              <button type="button" className="tree-select" role="radio" aria-checked={selectedId===null} aria-label="미분류" disabled={saving||state.blocked} onClick={()=>void select(null)}>
                <span className="classification-assignment-mark" aria-hidden="true">{selectedId===null?'●':'○'}</span>
                <FolderIcon/>
                <span className="classification-assignment-name">미분류</span>
              </button>
            </div>
            {rows.map(({classification,depth,hasChildren})=>row(classification,depth,hasChildren))}
            {!rows.length&&<p className="hint">아직 분류가 없습니다.</p>}
          </>}
      </div>}
      {state?.blocked&&<p className="classification-assignment-status is-blocked" role="status">{state.conflictMessage||'분류 변경을 적용할 수 없습니다.'}</p>}
      {state?.pending&&!state.blocked&&<p className="classification-assignment-status" role="status">저장 대기</p>}
    </div>
  </Dialog>;
}
