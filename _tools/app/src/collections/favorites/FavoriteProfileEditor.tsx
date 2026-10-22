import { useState } from "react";
import { MagnifyingGlassIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { CollectionSummary, FavoriteEntry, FavoriteSet } from "../../library/types";
import { Button } from "../../shared/ui/Button";
import { TextInput } from "../../shared/ui/TextInput";
import { Menu } from "../../shared/ui/Menu";
import { BusyLabel } from "../../shared/ui/BusyLabel";
import { EmptyState } from "../../shared/ui/EmptyState";
import { matchesKoreanSearch } from "../../shared/koreanSearch";
import { FAVORITE_WORK_LIMIT, FavoriteProfileFields, useFavoriteProfileDraft } from "./FavoriteProfileFields";

export function FavoriteProfileEditor({ name, series, entry, collections, busy, onCancel, onSave }: {
  name: string; series: string; entry: FavoriteEntry; collections: CollectionSummary[]; busy: boolean;
  onCancel(): void; onSave(set: FavoriteSet): Promise<boolean>;
}) {
  const draft = useFavoriteProfileDraft(entry, name, series);
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const suggestions = draft.workIds.length || draft.extraWorks.length ? [] : collections.filter(work => work.name === series);
  const choices = collections.filter(work => !draft.workIds.includes(work.id) && matchesKoreanSearch([work.name], query));
  return <form className="favorite-editor" onKeyDown={event => {
    if (event.key === "Escape" && !picker && !busy) { event.preventDefault(); event.stopPropagation(); onCancel(); }
  }} onSubmit={event => { event.preventDefault(); if (!busy && draft.valid) void onSave(draft.set()).then(saved => { if (saved) onCancel(); }); }}>
    <FavoriteProfileFields draft={draft} workName={id => collections.find(work => work.id === id)?.name ?? "연결된 작품"} workTools={<>
      {suggestions.map(work => <Button type="button" key={work.id} variant="quiet" size="sm" onClick={() => draft.linkWork(work.id)}><PlusIcon aria-hidden="true" />{work.name} 연결 제안</Button>)}
      <Menu label="작품 연결" open={picker} onOpenChange={setPicker} trigger={<><PlusIcon aria-hidden="true" />작품 연결</>} content={<div className="favorite-work-search" onKeyDown={event => event.stopPropagation()}>
        <TextInput autoFocus icon={MagnifyingGlassIcon} type="search" placeholder="작품 제목 검색" aria-label="작품 제목 검색" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="favorite-work-search__list">{choices.map(work => <Button type="button" key={work.id} variant="quiet" disabled={draft.workIds.length >= FAVORITE_WORK_LIMIT} onClick={() => { draft.linkWork(work.id); setPicker(false); }}>{work.name}</Button>)}
          {!choices.length && <EmptyState inline title="검색 결과 없음" />}
        </div>
      </div>} />
    </>} />
    <div className="favorite-editor__foot"><Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>취소</Button><Button type="submit" variant="primary" disabled={busy || !draft.valid}><BusyLabel busy={busy} delay={400} idle="완료">저장 중</BusyLabel></Button></div>
  </form>;
}
