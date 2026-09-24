import {useVisibleInterval} from './useVisibleInterval';
import {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowUpRightIcon} from '@heroicons/react/24/outline';
import {ClassificationIcon, classificationColor} from '../src/classification/classificationAppearance';
import {Button} from './ui';
import {api} from './transport';
import {dateLabel, mapBounded, normalizePage} from './model';
import {dayNumber, discoveryFolders, folderBreadcrumb} from './homeModel';
import type {Asset, Classification, Page, Revisit, View} from './types';
import './home.css';

import {Cover,CoverGroup} from './CoverGroup';
function folderPath(folder:Classification,classifications:Classification[]) {const path = folderBreadcrumb(folder,classifications); return path === folder.name ? '' : path;}
export interface HomeProps {
  items:Asset[]; classifications:Classification[]; recentFolders:string[]; revisit:Revisit; captures:Asset[];
  busy:boolean; paused:boolean; secondaryError:string; revision:number;
  onSelect(view:View):void; onOpen(index:number):void; onPending():void;
}
export function Home({items,classifications,revisit,captures,busy,paused,secondaryError,revision,onSelect,onOpen,onPending}:HomeProps) {
  const [day,setDay] = useState(dayNumber);
  useVisibleInterval(()=>setDay(dayNumber()),paused?null:60_000);
  const folders = useMemo(() => discoveryFolders(classifications,day),[classifications,day]);
  const [covers,setCovers] = useState<Record<string,Asset[]>>({});
  const [failed,setFailed] = useState(false);
  const coverKey = JSON.stringify([revision,folders.map(folder => folder.id)]);
  const completed = useRef({key:'',ids:new Set<string>()});
  useEffect(() => {
    if (paused || !revision) return;
    if (completed.current.key !== coverKey) completed.current = {key:coverKey,ids:new Set()};
    const pending = folders.filter(folder => !completed.current.ids.has(folder.id));
    if (!pending.length) return;
    const controller = new AbortController(); setFailed(false);
    // Keep committed covers during a refresh; resume only unfinished work after a pause.
    void mapBounded(pending,2,async folder => {
      try {
        const params = new URLSearchParams({classification_id:folder.id,limit:'3'});
        const page = normalizePage(await api<Page>(`/v1/library/assets?${params}`,controller.signal));
        if (!controller.signal.aborted) {
          completed.current.ids.add(folder.id);
          setCovers(current => Object.fromEntries(folders.map(item => [item.id,item.id === folder.id ? page.items.slice(0,3) : current[item.id] ?? []])));
        }
      } catch {if (!controller.signal.aborted) setFailed(true);}
    },controller.signal).catch(() => {});
    return () => controller.abort();
  },[coverKey,paused,revision]);
  const groups = revisit.bundles.flatMap(bundle => bundle.kind === 'date' && bundle.items?.length ? [{key:'date',title:bundle.title,items:bundle.items,label:'날짜별 다시보기'}] : (bundle.groups ?? []).filter(group => group.items?.length).map(group => ({key:group.creator_key,title:group.creator_name || group.creator_handle,items:group.items,label:'작가별 다시보기'}))).slice(0,4);
  const openFolder = (folder:Classification) => onSelect({tab:'library',classification:folder.id,title:folder.name});
  return <div className="home-scroll" aria-label="홈 탐색">
    <section aria-label="최근 저장">
      {items.length ? <div className="home-recent-strip">{items.slice(0,12).map((asset,index) => <button className="home-asset" key={asset.id} onClick={() => onOpen(index)} aria-label={`${asset.creator_name || asset.creator_handle || (asset.kind === 'video' ? '영상' : '이미지')}, ${dateLabel(asset)}`} data-asset-id={asset.id}><Cover asset={asset} paused={paused}/><span className="tile-caption">{(asset.creator_name || asset.creator_handle) && <span>{asset.creator_name || asset.creator_handle}</span>}<time>{dateLabel(asset)}</time></span></button>)}</div> : <p className="home-empty">{busy ? '최근 저장을 불러오는 중…' : '아직 동기화된 자산이 없습니다.'}</p>}
      <Button variant="ghost" className="home-more" onClick={() => onSelect({tab:'library',title:'최근 저장'})}>전체 보기<ArrowUpRightIcon/></Button>
    </section>
    {!!folders.length && <section aria-label="분류 둘러보기"><div className="home-section-heading"><h3>분류 둘러보기</h3></div><div className="home-folder-grid">{folders.map(folder => {const path = folderPath(folder,classifications); return <button className="home-folder" key={folder.id} aria-label={`${folderBreadcrumb(folder,classifications)}, ${folder.asset_count}개`} onClick={() => openFolder(folder)}><CoverGroup items={covers[folder.id] ?? []} paused={paused}/><span className="home-folder-caption"><ClassificationIcon kind="tag" iconKey={folder.icon_key ?? null} style={{color:classificationColor(folder.color_key ?? null)}}/><span><strong>{folder.name}</strong>{path && <small>{path}</small>}</span><span className="numeric">{folder.asset_count.toLocaleString()}개</span></span></button>;})}</div>{failed && <p className="hint" role="status">일부 분류 표지를 불러오지 못했습니다. 분류는 열 수 있습니다.</p>}</section>}
    {!!groups.length && <section aria-label="다시보기"><div className="home-section-heading"><h3>다시보기</h3></div><div className="home-revisit-grid">{groups.map(group => <button className="home-folder" key={group.key} aria-label={`${group.label} ${group.title}`} onClick={() => onSelect({tab:'library',revisit:group.key,title:group.title})}><CoverGroup items={group.items} paused={paused}/><span className="home-revisit-caption"><strong>{group.title}</strong><ArrowUpRightIcon/></span></button>)}</div></section>}
    {!!captures.length && <Button variant="ghost" onClick={onPending}>처리 대기 <span className="numeric">{captures.length}{captures.length === 40 ? '+' : ''}</span><ArrowUpRightIcon/></Button>}
    {secondaryError && <p className="hint" role="status">{secondaryError}</p>}
  </div>;
}
