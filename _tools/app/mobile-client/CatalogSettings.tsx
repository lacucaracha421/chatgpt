import { BusyLabel } from "../src/shared/ui/BusyLabel";
import {useEffect,useState,type ReactNode} from 'react';
import {XMarkIcon,PlusIcon,TrashIcon} from '@heroicons/react/24/outline';
import {Button,Dialog,DialogDescription,IconButton} from './ui';
import {catalogCategories} from '../src/manga/catalogCategories';
import {EXCLUDED_TAG_MAX,catalogPreferencesFit,parseExcludedTagInput,validExcludedTag,type CatalogPreferences} from './catalogPreferences';

const ALL_CATEGORY_IDS:number[]=catalogCategories.map(category=>category.id);

// Keep edits local until Apply, avoiding a server search for every checkbox tap.
export function CatalogSettings({open,preferences,revealBlocked,capability,onClose,onApply,onReset,tools,index}:{
  open:boolean;
  preferences:CatalogPreferences;
  revealBlocked:boolean;
  capability:'checking'|'supported'|'unsupported'|'failed';
  onClose():void;
  onApply(next:CatalogPreferences,revealBlocked:boolean):void;

  onReset():void;
  /** Catalog tools that are not filters (the duplicate-edition review entry). */
  tools?:ReactNode;
  index?:ReactNode;
}){
  const supported=capability==='supported';
  const [categories,setCategories]=useState<number[]|null>(preferences.categories);
  const [excluded,setExcluded]=useState(preferences.excludedTags);
  const [entry,setEntry]=useState('');
  const [message,setMessage]=useState('');
  const [blocked,setBlocked]=useState(revealBlocked);
  // Reopening starts from the committed setting, not an abandoned draft.
  useEffect(()=>{
    if(!open)return;
    setCategories(preferences.categories);
    setExcluded(preferences.excludedTags);
    setBlocked(revealBlocked);
    setEntry('');setMessage('');
  },[open,preferences,revealBlocked]);

  const selected=new Set(categories??[]);
  function toggle(id:number){
    // A null selection means every category, so unchecking one starts from all of
    // them minus that id rather than from an empty list.
    const current=new Set(categories??ALL_CATEGORY_IDS);
    if(current.has(id))current.delete(id);else current.add(id);
    // Removing the last one is an explicit "no categories" selection, not "all".
    setCategories(current.size===ALL_CATEGORY_IDS.length?null:[...current].sort((a,b)=>a-b));
  }
  function addTag(){
    const parsed=parseExcludedTagInput(entry);
    if(!parsed){setMessage('female:scat 형식으로 입력 필요');return;}
    if(!validExcludedTag(parsed)){setMessage('네임스페이스 소문자 시작 · 값 200자 이내');return;}
    if(excluded.some(tag=>tag.namespace===parsed.namespace&&tag.value===parsed.value)){setMessage('이미 숨긴 태그');return;}
    if(excluded.length>=EXCLUDED_TAG_MAX){setMessage(`숨긴 태그 최대 ${EXCLUDED_TAG_MAX}개`);return;}
    const next=[...excluded,parsed];
    if(!catalogPreferencesFit({categories,excludedTags:next})){setMessage('숨긴 태그 저장 한도 초과 · 일부 삭제 필요');return;}
    setExcluded(next);setEntry('');setMessage('');
  }

  const fits=catalogPreferencesFit({categories,excludedTags:excluded});
  // A null selection means every category is included, which is what an all-checked
  // list shows. Unchecking one therefore starts a concrete selection from all.
  const allChecked=categories===null||ALL_CATEGORY_IDS.every(id=>selected.has(id));

  return <Dialog open={open} title="필터" onClose={onClose}><div className="library-sheet catalog-filter-sheet">
    {index}
    <header className="catalog-settings-heading"><DialogDescription className="hint">이 기기 전용 · PC 설정 유지</DialogDescription><IconButton label="필터 닫기" icon={XMarkIcon} onClick={onClose}/></header>
    {capability==='unsupported'&&<p className="catalog-settings-warning" role="alert">서버 업데이트 후 사용 가능</p>}
    <BusyLabel busy={!!(capability==='checking')}><p role="status">서버 지원 여부 확인 중…</p></BusyLabel>
    {capability==='failed'&&<p role="alert">서버 상태 확인 실패 · 창을 닫고 재시도</p>}
    <section className="catalog-settings-section" aria-label="포함할 분류">
      <div className="catalog-settings-head"><h3>포함할 분류</h3><div className="catalog-settings-actions"><Button size="sm" variant="ghost" disabled={!supported||allChecked} onClick={()=>setCategories(null)}>모두 포함</Button><Button size="sm" variant="ghost" disabled={!supported||categories?.length===0} onClick={()=>setCategories([])}>모두 해제</Button></div></div>
      <div className="catalog-settings-categories">{catalogCategories.map(category=><label key={category.id} className="catalog-settings-category"><input type="checkbox" disabled={!supported} checked={allChecked||selected.has(category.id)} onChange={()=>toggle(category.id)}/>{category.label}</label>)}</div>

    </section>
    <section className="catalog-settings-section" aria-label="숨길 태그">
      <div className="catalog-settings-head"><h3>숨긴 태그</h3><span className="muted">{excluded.length}개</span></div>
      <form className="catalog-settings-form" onSubmit={event=>{event.preventDefault();addTag();}}>
        <label className="field">태그 입력<input value={entry} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={!supported} placeholder="female:scat" aria-label="숨긴 태그" onChange={event=>setEntry(event.target.value)}/></label>
        <Button size="sm" variant="ghost" type="submit" disabled={!supported}><PlusIcon/>추가</Button>
      </form>
      <p className="hint">입력한 태그 포함 작품 숨김</p>
      {excluded.length>0&&<ul className="catalog-settings-tags">{excluded.map(tag=><li key={`${tag.namespace}:${tag.value}`}><code>{tag.namespace}:{tag.value}</code><IconButton label={`${tag.namespace}:${tag.value} 숨김 해제`} icon={TrashIcon} onClick={()=>{setExcluded(excluded.filter(item=>item!==tag));setMessage('');}}/></li>)}</ul>}
    </section>
    <section className="catalog-settings-section" aria-label="차단 항목">
      <div className="catalog-settings-head"><h3>차단 항목</h3></div>
      <button className="catalog-settings-switch" role="switch" aria-checked={blocked} onClick={()=>setBlocked(value=>!value)}><span>PC 공통 차단 항목 표시<small>기본 숨김</small></span><span className="catalog-switch" aria-hidden="true"/></button>
    </section>
    {tools&&<section className="catalog-settings-section" aria-label="카탈로그 도구"><div className="catalog-settings-head"><h3>도구</h3></div>{tools}</section>}
    {message&&<p className="catalog-settings-message" role="alert">{message}</p>}
    <div className="dialog-actions catalog-settings-footer">
      <Button variant="ghost" onClick={onClose}>취소</Button>
      {supported
        ?<Button variant="ghost" disabled={preferences.categories===null&&!preferences.excludedTags.length} onClick={onReset}>설정 지우기</Button>
        :<Button variant="ghost" onClick={onReset}>설정 지우고 계속</Button>}
      <Button variant="primary" disabled={supported?!fits:blocked===revealBlocked} onClick={()=>onApply({categories,excludedTags:excluded},blocked)}>적용</Button>
    </div>
  </div></Dialog>;
}
