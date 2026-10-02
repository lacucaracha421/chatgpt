import {useMemo,useRef,useState} from 'react';
import {FolderIcon,PhotoIcon,UserIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {assetSearchKey,groupAssetSuggestions,rememberAssetSearch,type AssetSearchIdentity} from '../src/assets/assetSearch';
import {TopBarSearch} from './TopBar';
import {Button,IconButton,SectionLabel,TextInput} from './ui';
import {Cover} from './CoverGroup';
import {useNoteEditor} from './noteCaret';
import {usePrivacyMode} from './privacyMode';
import {readAssetSearchRecents,writeAssetSearchRecents,type AssetSuggestion} from './assetSearchModel';
import './assetSearch.css';

function Suggestion({item,privateMode,paused,onChoose}:{item:AssetSuggestion;privateMode:boolean;paused:boolean;onChoose(item:AssetSuggestion):void}) {
  const Icon=item.kind==='folder'?FolderIcon:item.kind==='album'?PhotoIcon:UserIcon;
  return <button type="button" className="asset-search-result" onClick={()=>onChoose(item)}>
    {!privateMode&&(item.cover?<span className="asset-search-cover"><Cover asset={item.cover} paused={paused}/></span>:<Icon aria-hidden="true"/>)}
    <span className="asset-search-name">{item.name}</span>{!privateMode&&item.count!==undefined&&<span className="numeric muted">{item.count.toLocaleString('ko-KR')}장</span>}
  </button>;
}
export function AssetSearch({items,endpoint,paused,loading=false,onClose,onChoose,error,onRetry}:{items:AssetSuggestion[];endpoint:string;paused:boolean;loading?:boolean;onClose():void;onChoose(item:AssetSuggestion):void;error?:string;onRetry?():void}) {
  const [query,setQuery]=useState(''),[expanded,setExpanded]=useState<string[]>([]),[recents,setRecents]=useState<AssetSearchIdentity[]>(()=>readAssetSearchRecents(endpoint));
  const [privateMode]=usePrivacyMode(),editor=useNoteEditor(),host=useRef<HTMLDivElement>(null);
  const {ref:unusedRef,...binding}=editor.bind(query,value=>{setQuery(value);setExpanded([]);});
  const groups=useMemo(()=>groupAssetSuggestions(items,query),[items,query]);
  const recentItems=recents.flatMap(recent=>{const item=items.find(item=>assetSearchKey(item)===assetSearchKey(recent));return item?[item]:[];});
  const choose=(item:AssetSuggestion)=>{const next=rememberAssetSearch(recents,item);setRecents(next);writeAssetSearchRecents(endpoint,next);onChoose(item);};
  const clear=()=>{const input=host.current?.querySelector('input');if(input){if(editor.isComposing(input))return;input.value='';input.focus();}setQuery('');setExpanded([]);};
  return <div className="asset-search" ref={host}>
    <TopBarSearch title="에셋" loading={loading&&'검색 목록 불러오는 중'} onClose={onClose}><TextInput type="search" autoFocus aria-label="에셋 찾기" placeholder="에셋 찾기" defaultValue="" {...binding} onKeyDown={event=>{if(editor.isComposing(event.currentTarget)||event.nativeEvent.isComposing||event.keyCode===229)return;if(event.key==='Enter')event.preventDefault();}}/>{query&&<IconButton label="검색어 지우기" icon={XMarkIcon} onClick={clear}/>}</TopBarSearch>
    <div className="asset-search-results" aria-label="에셋 검색 제안">
      {query.trim()?groups.filter(group=>group.items.length>0).map(group=><section key={group.kind} aria-label={group.label}><SectionLabel as="h2" title={group.label}/>{group.items.slice(0,expanded.includes(group.kind)?group.items.length:5).map(item=><Suggestion key={assetSearchKey(item)} item={item} privateMode={privateMode} paused={paused} onChoose={choose}/>)}{group.items.length>5&&!expanded.includes(group.kind)&&<Button type="button" variant="quiet" aria-label={`${group.label} 더 보기`} onClick={()=>setExpanded(old=>[...old,group.kind])}>더 보기</Button>}</section>):!privateMode&&recentItems.length>0&&<section aria-label="최근 검색"><SectionLabel as="h2" title="최근 검색"/>{recentItems.map(item=><Suggestion key={assetSearchKey(item)} item={item} privateMode={privateMode} paused={paused} onChoose={choose}/>)}</section>}
      {query.trim()&&!groups.some(group=>group.items.length)&&!error&&!loading&&<p className="hint">검색 결과가 없습니다.</p>}
      {error&&<div className="inline-error" role="alert"><span>{error}</span>{onRetry&&<Button type="button" variant="ghost" onClick={onRetry}>다시 시도</Button>}</div>}
    </div>
  </div>;
}
