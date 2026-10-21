import { useState } from "react";
import { MagnifyingGlassIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { CollectionSummary, FavoriteEntry, FavoriteProfile, FavoriteSet } from "../../library/types";
import { Button } from "../../shared/ui/Button";
import { Field, TextInput } from "../../shared/ui/TextInput";
import { Menu } from "../../shared/ui/Menu";
import { BusyLabel } from "../../shared/ui/BusyLabel";
import { EmptyState } from "../../shared/ui/EmptyState";
import { matchesKoreanSearch } from "../../shared/koreanSearch";

export function FavoriteProfileEditor({ name, series, entry, collections, busy, onCancel, onSave }: {
  name: string; series: string; entry: FavoriteEntry; collections: CollectionSummary[]; busy: boolean;
  onCancel(): void; onSave(set: FavoriteSet): Promise<boolean>;
}) {
  const [profile, setProfile] = useState<FavoriteProfile>({ ...entry.profile });
  const [workIds, setWorkIds] = useState(entry.workIds);
  const [extraWorks, setExtraWorks] = useState(entry.extraWorks);
  const [freeName, setFreeName] = useState("");
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const suggestions = workIds.length || extraWorks.length ? [] : collections.filter(work => work.name === series);
  const patch = (set: Partial<FavoriteProfile>) => setProfile(current => ({ ...current, ...set }));
  const textField = (label: string, key: "originalName" | "voiceActor" | "affiliation") => <Field label={label}>
    <TextInput autoFocus={key === "originalName"} maxLength={120} value={profile[key] ?? ""} onChange={event => patch({ [key]: event.target.value || null })} />
  </Field>;
  const addFreeWork = () => {
    const name = freeName.trim();
    if (name && !extraWorks.includes(name) && extraWorks.length < 30) setExtraWorks(names => [...names, name]);
    setFreeName("");
  };
  const birthdayValid = (!profile.birthMonth && !profile.birthDay) || (profile.birthMonth && profile.birthDay
    && new Date(2000, profile.birthMonth - 1, profile.birthDay).getMonth() === profile.birthMonth - 1);
  return <form className="favorite-editor" onKeyDown={event => {
    if (event.key === "Escape" && !picker && !busy) { event.preventDefault(); event.stopPropagation(); onCancel(); }
  }} onSubmit={event => { event.preventDefault(); if (!busy && birthdayValid) void onSave({ profile, workIds, extraWorks }).then(saved => { if (saved) onCancel(); }); }}>
    <Field label="이름"><TextInput readOnly value={name} /></Field>
    {textField("원래 이름", "originalName")}
    <div className="favorite-editor__two">
      <Field label="생일 · 월"><TextInput type="number" min={1} max={12} value={profile.birthMonth ?? ""} onChange={event => patch({ birthMonth: event.target.value ? Number(event.target.value) : null })} /></Field>
      <Field label="일"><TextInput type="number" min={1} max={31} value={profile.birthDay ?? ""} onChange={event => patch({ birthDay: event.target.value ? Number(event.target.value) : null })} /></Field>
    </div>
    {!birthdayValid && <p className="favorite-error" role="alert">생일의 월과 일을 확인하세요.</p>}
    <Field label="키 · cm"><TextInput type="number" min={30} max={300} step="any" value={profile.heightCm ?? ""} onChange={event => patch({ heightCm: event.target.value ? Number(event.target.value) : null })} /></Field>
    {textField("성우", "voiceActor")}{textField("소속", "affiliation")}
    <Field label="메모"><textarea className="ui-text-input" rows={3} maxLength={2000} value={profile.memo ?? ""} onChange={event => patch({ memo: event.target.value || null })} /></Field>
    <div className="favorite-editor__works"><span className="favorite-meta">등장 작품</span>
      <div className="favorite-chips">
        {workIds.map(id => <span className="favorite-chip" key={id}>{collections.find(work => work.id === id)?.name ?? "연결된 작품"}<Button type="button" variant="quiet" size="sm" aria-label="작품 연결 제거" onClick={() => setWorkIds(ids => ids.filter(value => value !== id))}><XMarkIcon aria-hidden="true" /></Button></span>)}
        {extraWorks.map(name => <span className="favorite-chip" key={name}>{name}<Button type="button" variant="quiet" size="sm" aria-label={`${name} 빼기`} onClick={() => setExtraWorks(names => names.filter(value => value !== name))}><XMarkIcon aria-hidden="true" /></Button></span>)}
      </div>
      {suggestions.map(work => <Button type="button" key={work.id} variant="quiet" size="sm" onClick={() => setWorkIds(ids => [...ids, work.id])}><PlusIcon aria-hidden="true" />{work.name} 연결 제안</Button>)}
      <Menu label="작품 연결" open={picker} onOpenChange={setPicker} trigger={<><PlusIcon aria-hidden="true" />작품 연결</>} content={<div className="favorite-work-search" onKeyDown={event => event.stopPropagation()}>
        <TextInput autoFocus icon={MagnifyingGlassIcon} type="search" placeholder="작품 제목 검색" aria-label="작품 제목 검색" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="favorite-work-search__list">{collections.filter(work => !workIds.includes(work.id) && matchesKoreanSearch([work.name], query)).map(work => <Button type="button" key={work.id} variant="quiet" disabled={workIds.length >= 30} onClick={() => { setWorkIds(ids => [...ids, work.id]); setPicker(false); }}>{work.name}</Button>)}
          {!collections.some(work => !workIds.includes(work.id) && matchesKoreanSearch([work.name], query)) && <EmptyState inline title="검색 결과 없음" />}
        </div>
      </div>} />
      <div className="favorite-editor__free"><TextInput aria-label="컬렉션에 없는 작품 이름" placeholder="컬렉션에 없는 작품 이름" maxLength={120} value={freeName} onChange={event => setFreeName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addFreeWork(); } }} /><Button type="button" variant="quiet" disabled={!freeName.trim() || extraWorks.length >= 30} onClick={addFreeWork}>추가</Button></div>
    </div>
    <div className="favorite-editor__foot"><Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>취소</Button><Button type="submit" variant="primary" disabled={busy || !birthdayValid}><BusyLabel busy={busy} delay={400} idle="완료">저장 중</BusyLabel></Button></div>
  </form>;
}
