import {useMemo, useState, type Dispatch, type SetStateAction} from 'react';
import {ChevronDownIcon, ChevronRightIcon, ClockIcon, MagnifyingGlassIcon} from '@heroicons/react/24/outline';
import {ClassificationIcon, classificationColor} from '../src/classification/classificationAppearance';
import {Button} from './ui';
import type {Classification, View} from './types';
export function ClassificationIndex({items, view, onSelect, collapsed, setCollapsed}: {items: Classification[]; view: View; onSelect(view: View): void; collapsed: Set<string>; setCollapsed: Dispatch<SetStateAction<Set<string>>>}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const byParent = new Map<string | null, Classification[]>();
    const ids = new Set(items.map(item => item.id));
    for (const item of items) { const parent = ids.has(item.parent_id ?? '') ? item.parent_id : null; byParent.set(parent, [...(byParent.get(parent) ?? []), item]); }
    const result: {item: Classification; depth: number; children: boolean}[] = [], visited = new Set<string>();
    const visit = (parent: string | null, depth: number) => {
      for (const item of byParent.get(parent) ?? []) {
        if (visited.has(item.id)) continue; visited.add(item.id);
        if (!query || item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) result.push({item, depth:query ? 0 : depth, children:byParent.has(item.id)});
        if (query || !collapsed.has(item.id)) visit(item.id, Math.min(depth + 1, 12));
      }
    };
    visit(null, 0); return result;
  }, [items, query, collapsed]);
  return <div className="classification-index">
    <label className="classification-search"><MagnifyingGlassIcon/><input aria-label="분류 찾기" value={query} placeholder="분류 찾기" onChange={event => setQuery(event.target.value)}/></label>
    <Button className={`index-recent ${!view.classification && !view.revisit ? 'selected' : ''}`} variant="ghost" onClick={() => onSelect({tab:'library', title:'최근 저장'})}><ClockIcon/>최근 저장</Button>
    <div className="index-heading"><span>분류</span><span className="numeric">{items.length}</span></div>
    <nav className="classification-tree" aria-label="분류">
      {visible.map(({item, depth, children}) => <div className={`tree-row ${view.classification === item.id ? 'selected' : ''}`} style={{paddingLeft:depth * 16}} key={item.id}>
        {children ? <button className="tree-expander" aria-label={`${item.name} ${collapsed.has(item.id) ? '펼치기' : '접기'}`} aria-expanded={!collapsed.has(item.id)} onClick={() => setCollapsed(old => {const next = new Set(old); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next;})}>{collapsed.has(item.id) ? <ChevronRightIcon/> : <ChevronDownIcon/>}</button> : <span className="tree-leaf"/>}
        <button className="tree-select" aria-current={view.classification === item.id ? 'page' : undefined} onClick={() => onSelect({tab:'library', classification:item.id, title:item.name})}><ClassificationIcon kind="tag" iconKey={item.icon_key ?? null} style={{color:view.classification === item.id ? 'currentColor' : classificationColor(item.color_key ?? null)}}/><span>{item.name}</span><span className="numeric">{item.asset_count}</span></button>
      </div>)}
      {!visible.length && <p className="hint">{query ? '일치하는 분류가 없습니다.' : '아직 게시된 분류가 없습니다.'}</p>}
    </nav>
  </div>;
}
