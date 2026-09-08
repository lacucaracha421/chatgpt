import {useEffect,useRef,useState,type MutableRefObject} from 'react';
import {ArrowLeftIcon,ArrowPathIcon,BookmarkIcon,BookOpenIcon,MagnifyingGlassIcon} from '@heroicons/react/24/outline';
import {Button,IconButton} from './ui';
import {api,errorText} from './transport';
import {DEFAULT_CATALOG_QUERY,catalogPath,catalogDetailPath,catalogEditionsPath,catalogTagQuery,catalogError,type CatalogQuery,type CatalogItem,type CatalogPage,type CatalogDetail,type CatalogEditions} from './catalogModel';
import './Catalog.css';

export function Catalog({active,paused,backRef}:{active:boolean;paused:boolean;backRef:MutableRefObject<(()=>boolean)|null>}){
  const [query,setQuery]=useState<CatalogQuery>(DEFAULT_CATALOG_QUERY),[draft,setDraft]=useState('');
  const [cursor,setCursor]=useState<string|null>(null),[previous,setPrevious]=useState<(string|null)[]>([]);
  const [page,setPage]=useState<CatalogPage|null>(null),[refresh,setRefresh]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[countError,setCountError]=useState('');
  const [countRetry,setCountRetry]=useState(0);
  const [selected,setSelected]=useState<CatalogItem|null>(null),[detail,setDetail]=useState<CatalogDetail|null>(null);
  const [detailError,setDetailError]=useState(''),[detailRefresh,setDetailRefresh]=useState(0);
  const [editions,setEditions]=useState<CatalogEditions|null>(null),[editionCursor,setEditionCursor]=useState<string|null>(null),[editionError,setEditionError]=useState('');
  const committed=useRef(''),list=useRef<HTMLDivElement>(null),scroll=useRef(0);
  const key=`${catalogPath(query,cursor)}:${refresh}`;
  useEffect(()=>{
    if(!active||paused||committed.current===key)return;
    const controller=new AbortController();setBusy(true);setError('');setCountError('');
    void api<CatalogPage>(catalogPath(query,cursor),controller.signal).then(result=>{
      if(controller.signal.aborted)return;
      committed.current=key;setPage(result);setBusy(false);
      if(list.current)list.current.scrollTop=0;
    }).catch(reason=>{if(!controller.signal.aborted){setError(catalogError(reason)||errorText(reason));setBusy(false);}});
    return()=>controller.abort();
  },[active,paused,key,query,cursor]);
  useEffect(()=>{
    if(!active||paused||!page?.countToken||page.countStatus==='ready')return;
    const controller=new AbortController(),countToken=page.countToken;
    setCountError('');
    void api<{publicationRevision:string;totalCount:number}>(`/v1/mobile-catalog/count?${new URLSearchParams({token:countToken})}`,controller.signal).then(count=>{
      if(!controller.signal.aborted)setPage(current=>current?.countToken===countToken&&current.publicationRevision===count.publicationRevision?{...current,totalCount:count.totalCount,countStatus:'ready'}:current);
    }).catch(reason=>{if(!controller.signal.aborted){setCountError(catalogError(reason)||errorText(reason));setPage(current=>current?.countToken===countToken?{...current,countStatus:'unavailable'}:current);}});
    return()=>controller.abort();
  },[active,paused,page?.countToken,countRetry]);
  useEffect(()=>{
    backRef.current=()=>{if(selected){setSelected(null);return true;}return false;};
    return()=>{backRef.current=null;};
  },[selected,backRef]);
  useEffect(()=>{if(!selected&&list.current)list.current.scrollTop=scroll.current;},[selected]);
  useEffect(()=>{
    if(!selected||!page?.context||!active||paused)return;
    const controller=new AbortController();setDetail(null);setDetailError('');
    void api<{publicationRevision:string;item:CatalogDetail}>(catalogDetailPath(selected,page.context),controller.signal).then(result=>{
      if(!controller.signal.aborted&&result.publicationRevision===page.publicationRevision)setDetail(result.item);
    }).catch(reason=>{if(!controller.signal.aborted)setDetailError(catalogError(reason)||errorText(reason));});
    return()=>controller.abort();
  },[selected,page?.context,page?.publicationRevision,active,paused,detailRefresh]);
  useEffect(()=>{
    if(!selected||!page?.context||!active||paused)return;
    const controller=new AbortController();setEditionError('');
    void api<CatalogEditions>(catalogEditionsPath(selected.groupId,page.context,editionCursor),controller.signal).then(result=>{
      if(!controller.signal.aborted&&result.publicationRevision===page.publicationRevision)setEditions(result);
    }).catch(reason=>{if(!controller.signal.aborted)setEditionError(catalogError(reason)||errorText(reason));});
    return()=>controller.abort();
  },[selected?.groupId,page?.context,page?.publicationRevision,editionCursor,active,paused,detailRefresh]);
  function change(next:Partial<CatalogQuery>){setQuery(current=>({...current,...next}));setCursor(null);setPrevious([]);setSelected(null);scroll.current=0;setRefresh(n=>n+1);}
  function open(item:CatalogItem){scroll.current=list.current?.scrollTop??0;setSelected(item);setEditionCursor(null);setEditions(null);}
  function reload(){setCursor(null);setPrevious([]);setSelected(null);setRefresh(n=>n+1);}
  return <section className="mobile-catalog" style={{display:active?'flex':'none'}} aria-label="만화 카탈로그">
    <div className="catalog-content" style={{display:selected?'none':undefined}}>
      <div className="catalog-heading"><div><h1>만화 카탈로그</h1><span className="muted" aria-live="polite">{page?.countStatus==='ready'?`${page.totalCount?.toLocaleString()}개`:page?.countStatus==='pending'?'개수 확인 중':''}</span></div><IconButton label="카탈로그 새로고침" icon={ArrowPathIcon} disabled={busy} onClick={reload}/></div>
      {page?.publishedAt&&<p className="catalog-published">PC 게시 · {new Date(page.publishedAt).toLocaleString()}</p>}
      <form className="catalog-search" onSubmit={event=>{event.preventDefault();change({text:draft});}}><MagnifyingGlassIcon aria-hidden="true"/><input aria-label="카탈로그 검색" value={draft} onChange={event=>setDraft(event.target.value)} placeholder="제목, 작가, 태그…"/><Button type="submit" variant="ghost">검색</Button></form>
      <div className="catalog-filters"><select aria-label="카탈로그 언어" value={query.language} onChange={event=>change({language:event.target.value as CatalogQuery['language']})}><option value="korean">한국어</option><option value="japanese">일본어</option><option value="all">전체 언어</option></select><select aria-label="카탈로그 정렬" value={query.sort} onChange={event=>change({sort:event.target.value as CatalogQuery['sort']})}><option value="latest">최신순</option><option value="views">조회순</option><option value="hotDay">오늘 인기</option><option value="hotWeek">이번 주 인기</option><option value="hotMonth">이번 달 인기</option></select><Button variant="ghost" aria-pressed={query.scope==='bookmarked'} onClick={()=>change({scope:query.scope==='all'?'bookmarked':'all'})}><BookmarkIcon/>북마크</Button><label><input type="checkbox" checked={query.revealBlocked} onChange={event=>change({revealBlocked:event.target.checked})}/>차단 항목 보기</label></div>
      {busy&&<div className="loading-line" role="status" aria-label="카탈로그 불러오는 중"/>}
      {error&&<div className="inline-error" role="alert">{error}<Button onClick={()=>setRefresh(n=>n+1)}>다시 시도</Button></div>}
      {countError&&<div className="catalog-count-error">개수를 확인하지 못했습니다.<Button size="sm" variant="ghost" onClick={()=>setCountRetry(n=>n+1)}>다시 시도</Button></div>}
      <div ref={list} className="catalog-scroll" onScroll={event=>{scroll.current=event.currentTarget.scrollTop;}}>
        {page?.ready===false?<div className="empty-state"><BookOpenIcon/><h2>카탈로그가 아직 공유되지 않았습니다</h2><p>PC 설정의 온라인 카탈로그에서 모바일에 게시해 주세요.</p></div>:page?.ready&&<>{page.items.length?<div className="catalog-grid">{page.items.map(item=><button className="catalog-card" disabled={busy||committed.current!==key} key={`${item.provider}:${item.groupId}`} onClick={()=>open(item)}><div className="catalog-cover">{item.thumbnailUrl&&<img src={item.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event=>{event.currentTarget.hidden=true;}}/>}<span className="catalog-cover-pages">{item.fileCount}p</span>{item.hasBookmarkedVersion&&<BookmarkIcon className="catalog-saved" aria-label="북마크됨"/>}</div><strong>{item.title}</strong><span>{item.artists.join(' · ')||'작가 미상'}</span>{item.versionCount>1&&<span>{item.versionCount}개 판본</span>}</button>)}</div>:<div className="empty-state"><h2>검색 결과가 없습니다</h2><p>검색어나 언어 조건을 바꿔 보세요.</p></div>}<footer className="page-footer"><Button disabled={!previous.length||busy} onClick={()=>{setCursor(previous[previous.length-1]??null);setPrevious(value=>value.slice(0,-1));}}>이전</Button><span>{previous.length+1}</span><Button disabled={!page.nextCursor||busy} onClick={()=>{setPrevious(value=>[...value,cursor]);setCursor(page.nextCursor);}}>다음</Button></footer></>}
      </div>
    </div>
    {selected&&<div className="catalog-detail"><div className="catalog-heading"><IconButton label="카탈로그 목록으로" icon={ArrowLeftIcon} onClick={()=>setSelected(null)}/><span>상세 정보</span></div>{detailError?<div role="alert" className="inline-error">{detailError}<Button onClick={()=>setDetailRefresh(n=>n+1)}>다시 시도</Button></div>:!detail?<p role="status">상세 정보를 불러오는 중…</p>:<><div className="catalog-detail-intro"><div className="catalog-detail-cover">{detail.thumbnailUrl&&<img src={detail.thumbnailUrl} alt="" referrerPolicy="no-referrer"/>}</div><div><h2>{detail.title}</h2>{detail.titleJpn&&detail.titleJpn!==detail.title&&<p className="muted">{detail.titleJpn}</p>}<p>{detail.fileCount}페이지 · 조회 {detail.views.toLocaleString()}</p>{detail.bookmarked&&<p className="catalog-bookmark-label"><BookmarkIcon/>북마크됨</p>}</div></div><div className="catalog-tags">{detail.tagGroups.map(group=><div key={group.namespace}><h3>{group.namespace}</h3><div>{group.values.map(value=><Button key={value} size="sm" variant="ghost" onClick={()=>{const text=catalogTagQuery(group.namespace,value);setDraft(text);change({text});}}>{group.labels?.[value]??value}</Button>)}</div></div>)}</div></>}
      <section className="catalog-editions" aria-label="카탈로그 판본"><h3>판본{editions?` · ${editions.totalCount}`:''}</h3>{editionError?<div role="alert">{editionError}<Button onClick={()=>setDetailRefresh(n=>n+1)}>다시 시도</Button></div>:editions?.items.map(item=><button key={item.providerWorkId} className="catalog-edition" aria-current={detail?.providerWorkId===item.providerWorkId?'true':undefined} onClick={()=>setSelected(current=>current?{...current,...item}:current)}><span>{item.title}</span><small>{item.fileCount}p{item.bookmarked?' · 북마크':''}</small></button>)}{editionCursor&&<Button variant="ghost" onClick={()=>setEditionCursor(null)}>처음 판본</Button>}{editions?.nextCursor&&<Button variant="ghost" onClick={()=>setEditionCursor(editions.nextCursor)}>다음 판본</Button>}</section>
    </div>}
  </section>;
}
