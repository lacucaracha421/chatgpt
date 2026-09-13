import type {CharacterIndex} from './characterModel';
import {useMemo, type Dispatch, type SetStateAction} from 'react';
import {ChevronDownIcon, ChevronRightIcon, ClockIcon, FolderIcon} from '@heroicons/react/24/outline';
import {ClassificationIcon, classificationColor} from '../src/classification/classificationAppearance';
import {Button} from './ui';
import type {Classification, View} from './types';
export function ClassificationIndex({items, view, onSelect, collapsed, setCollapsed,characters}: {characters?:CharacterIndex;items: Classification[]; view: View; onSelect(view: View): void; collapsed: Set<string>; setCollapsed: Dispatch<SetStateAction<Set<string>>>}) {
  const visible = useMemo(() => {
    type Entry=Classification&{characterNode?:string};
    const nodes=characters?.ready?characters.nodes:[];
    const series=new Map(nodes.filter(n=>n.kind==='series').map(n=>[n.sourceId,n]));
    const merged:Entry[]=items.map(item=>({...item,characterNode:series.get(item.id)?.id,asset_count:series.has(item.id)?characters?.scopes.find(scope=>scope.nodeId===series.get(item.id)?.id&&scope.filter==='all')?.totalCount??item.asset_count:item.asset_count}));
    for(const node of nodes){
      if(node.kind==='series'&&!merged.some(item=>item.id===node.sourceId))merged.push({id:node.sourceId,name:node.name,parent_id:null,asset_count:characters?.scopes.find(scope=>scope.nodeId===node.id&&scope.filter==='all')?.totalCount??0,characterNode:node.id});
      if(node.kind==='group'||node.kind==='character'){
        const id=node.kind==='group'?`character-group:${node.sourceId}`:node.id;
        const parent=node.parentId?.startsWith('group:')?`character-group:${node.parentId.slice(6)}`:node.seriesId;
        merged.push({id,name:node.name,parent_id:parent,asset_count:characters?.scopes.find(s=>s.nodeId===node.id&&s.filter==='all')?.totalCount??0,characterNode:node.id});
      }
    }
    const order=new Map((characters?.navigationOrder??[]).map((id,i)=>[id,i]));
    merged.sort((a,b)=>(order.get(a.id)??Number.MAX_SAFE_INTEGER)-(order.get(b.id)??Number.MAX_SAFE_INTEGER)||a.name.localeCompare(b.name,'ko'));

    const byParent = new Map<string | null, Entry[]>();
    const ids = new Set(merged.map(item => item.id));
    for (const item of merged) { const parent = ids.has(item.parent_id ?? '') ? item.parent_id : null; byParent.set(parent, [...(byParent.get(parent) ?? []), item]); }
    const result: {item: Entry; depth: number; children: boolean}[] = [], visited = new Set<string>();
    const visit = (parent: string | null, depth: number) => {
      for (const item of byParent.get(parent) ?? []) {
        if (visited.has(item.id)) continue; visited.add(item.id);
        result.push({item, depth, children:byParent.has(item.id)});
        if (!collapsed.has(item.id)) visit(item.id, Math.min(depth + 1, 12));
      }
    };
    visit(null, 0); return result;
  }, [items, characters, collapsed]);
  return <div className="classification-index">
    <Button className={`index-recent ${!view.characters && !view.classification && !view.revisit && view.title!=='전체' ? 'selected' : ''}`} variant="ghost" onClick={() => onSelect({tab:'library', title:'최근 저장'})}><ClockIcon/>최근 저장</Button>
    {!characters?.ready&&<Button variant="ghost" aria-pressed={!!view.characters} onClick={()=>onSelect({tab:'library',title:'시리즈·캐릭터',characters:true})}>시리즈·캐릭터</Button>}
    <div className="index-heading"><span>분류</span><span className="numeric">{items.length}</span></div>
    <nav className="classification-tree" aria-label="분류">
      <div className={`tree-row ${view.title==='전체'&&!view.classification&&!view.characters?'selected':''}`}><span className="tree-leaf"/><button className="tree-select" aria-current={view.title==='전체'&&!view.classification&&!view.characters?'page':undefined} onClick={()=>onSelect({tab:'library',title:'전체'})}><FolderIcon/><span>전체</span></button></div>
      {visible.map(({item, depth, children}) => <div className={`tree-row ${(item.characterNode?view.characterNode===item.characterNode:view.classification===item.id) ? 'selected' : ''}`} style={{paddingLeft:depth * 16}} key={item.id}>
        {children ? <button className="tree-expander" aria-label={`${item.name} ${collapsed.has(item.id) ? '펼치기' : '접기'}`} aria-expanded={!collapsed.has(item.id)} onClick={() => setCollapsed(old => {const next = new Set(old); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next;})}>{collapsed.has(item.id) ? <ChevronRightIcon/> : <ChevronDownIcon/>}</button> : <span className="tree-leaf"/>}
        <button className="tree-select" aria-current={(item.characterNode?view.characterNode===item.characterNode:view.classification===item.id) ? 'page' : undefined} onClick={() => onSelect(item.characterNode?{tab:'library',characters:true,characterNode:item.characterNode,title:item.name}:{tab:'library', classification:item.id, title:item.name})}><ClassificationIcon kind="tag" iconKey={item.icon_key ?? null} style={{color:(item.characterNode?view.characterNode===item.characterNode:view.classification===item.id) ? 'currentColor' : classificationColor(item.color_key ?? null)}}/><span>{item.name}</span><span className="numeric">{item.asset_count}</span></button>
      </div>)}
      {!visible.length && <p className="hint">아직 게시된 분류가 없습니다.</p>}
    </nav>
  </div>;
}
