import { useState, type ReactNode } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { FavoriteEntry, FavoriteProfile, FavoriteSet } from "../../library/types";
import { Button } from "../../shared/ui/Button";
import { Field, TextInput } from "../../shared/ui/TextInput";
import { isManualFavorite } from "./model";
import "./favoriteProfileEditor.css";

/** At most this many linked and free-text works per character (the server's limit). */
export const FAVORITE_WORK_LIMIT = 30;

/** A real calendar day (February 29 allowed), or no birthday at all. */
export function favoriteBirthdayValid(profile: Pick<FavoriteProfile, "birthMonth" | "birthDay">): boolean {
  if (!profile.birthMonth && !profile.birthDay) return true;
  return !!(profile.birthMonth && profile.birthDay && new Date(2000, profile.birthMonth - 1, profile.birthDay).getMonth() === profile.birthMonth - 1);
}

/**
 * One favourite character's profile being edited (PC detail and tablet sheet): the facts, the linked and free-text
 * works and, for a character added by name only, its name and work name. `set()` is the `update` command's `set`;
 * an Asset character never sends a name, so its identity stays the character folder's.
 */
export function useFavoriteProfileDraft(entry: FavoriteEntry, name: string, series: string) {
  const manual = isManualFavorite(entry.characterId);
  const [profile, setProfile] = useState<FavoriteProfile>({ ...entry.profile });
  const [editedName, setEditedName] = useState(name);
  const [seriesName, setSeriesName] = useState(series);
  const [workIds, setWorkIds] = useState(entry.workIds);
  const [extraWorks, setExtraWorks] = useState(entry.extraWorks);
  const patch = (set: Partial<FavoriteProfile>) => setProfile(current => ({ ...current, ...set }));
  const birthdayValid = favoriteBirthdayValid(profile);
  return {
    manual, profile, patch, editedName, setEditedName, seriesName, setSeriesName, workIds, extraWorks, birthdayValid,
    valid: birthdayValid && (!manual || !!editedName.trim()),
    linkWork: (id: string) => setWorkIds(ids => ids.includes(id) || ids.length >= FAVORITE_WORK_LIMIT ? ids : [...ids, id]),
    unlinkWork: (id: string) => setWorkIds(ids => ids.filter(value => value !== id)),
    addExtraWork: (value: string) => { const text = value.trim(); if (text) setExtraWorks(names => names.includes(text) || names.length >= FAVORITE_WORK_LIMIT ? names : [...names, text]); },
    removeExtraWork: (value: string) => setExtraWorks(names => names.filter(item => item !== value)),
    set: (): FavoriteSet => ({ profile, workIds, extraWorks, ...(manual ? { name: editedName.trim(), seriesName: seriesName.trim() } : {}) }),
  };
}
export type FavoriteProfileDraft = ReturnType<typeof useFavoriteProfileDraft>;

/**
 * The profile form's fields in their shared order (PC and tablet). Each client adds its own way of finding a work to
 * link (`workTools`: the PC menu, the tablet sheet) and the form's buttons.
 */
export function FavoriteProfileFields({ draft, workName, workTools, focusFirst = true }: {
  draft: FavoriteProfileDraft; workName(id: string): string; workTools: ReactNode;
  /** The PC focuses 원래 이름 when the form opens; the tablet does not raise the keyboard by itself. */
  focusFirst?: boolean;
}) {
  const { profile, patch, manual } = draft;
  const [freeName, setFreeName] = useState("");
  const addFreeWork = () => { draft.addExtraWork(freeName); setFreeName(""); };
  const textField = (label: string, key: "originalName" | "voiceActor" | "affiliation") => <Field label={label}>
    <TextInput autoFocus={focusFirst && key === "originalName"} maxLength={120} value={profile[key] ?? ""} onChange={event => patch({ [key]: event.target.value || null })} />
  </Field>;
  return <>
    <Field label="이름"><TextInput readOnly={!manual} required={manual} maxLength={120} value={draft.editedName} onChange={event => draft.setEditedName(event.target.value)} /></Field>
    {manual && <Field label="작품 이름"><TextInput maxLength={120} value={draft.seriesName} onChange={event => draft.setSeriesName(event.target.value)} /></Field>}
    {textField("원래 이름", "originalName")}
    <div className="favorite-editor__two">
      <Field label="생일 · 월"><TextInput type="number" min={1} max={12} value={profile.birthMonth ?? ""} onChange={event => patch({ birthMonth: event.target.value ? Number(event.target.value) : null })} /></Field>
      <Field label="일"><TextInput type="number" min={1} max={31} value={profile.birthDay ?? ""} onChange={event => patch({ birthDay: event.target.value ? Number(event.target.value) : null })} /></Field>
    </div>
    {!draft.birthdayValid && <p className="favorite-error" role="alert">생일의 월과 일을 확인하세요.</p>}
    <Field label="키 · cm"><TextInput type="number" min={30} max={300} step="any" value={profile.heightCm ?? ""} onChange={event => patch({ heightCm: event.target.value ? Number(event.target.value) : null })} /></Field>
    {textField("성우", "voiceActor")}{textField("소속", "affiliation")}
    <Field label="메모"><textarea className="ui-text-input" rows={3} maxLength={2000} value={profile.memo ?? ""} onChange={event => patch({ memo: event.target.value || null })} /></Field>
    <div className="favorite-editor__works"><span className="favorite-meta">등장 작품</span>
      <div className="favorite-chips">
        {draft.workIds.map(id => <span className="favorite-chip" key={id}>{workName(id)}<Button type="button" variant="quiet" size="sm" aria-label="작품 연결 제거" onClick={() => draft.unlinkWork(id)}><XMarkIcon aria-hidden="true" /></Button></span>)}
        {draft.extraWorks.map(name => <span className="favorite-chip" key={name}>{name}<Button type="button" variant="quiet" size="sm" aria-label={`${name} 빼기`} onClick={() => draft.removeExtraWork(name)}><XMarkIcon aria-hidden="true" /></Button></span>)}
      </div>
      {workTools}
      <div className="favorite-editor__free"><TextInput aria-label="컬렉션에 없는 작품 이름" placeholder="컬렉션에 없는 작품 이름" maxLength={120} value={freeName} onChange={event => setFreeName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addFreeWork(); } }} /><Button type="button" variant="quiet" disabled={!freeName.trim() || draft.extraWorks.length >= FAVORITE_WORK_LIMIT} onClick={addFreeWork}>추가</Button></div>
    </div>
  </>;
}
