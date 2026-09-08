import { PhotoIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { thumbnailUrl } from "../assets/mediaUrl";
import type { CharacterTarget } from "./api";

export type CharacterEditorDraft = { name: string; description: string; thumbnail: string | null; references: string[]; enabled: boolean };
export function characterDraft(target: CharacterTarget | null): CharacterEditorDraft {
  return { name: target?.displayName ?? "", description: target?.description ?? "", thumbnail: target?.thumbnailAssetId ?? null,
    references: target?.references.flatMap(r => r.assetId ? [r.assetId] : []) ?? [], enabled: target?.enabled ?? true };
}

/** Draft ownership stays with the series so gallery selection never discards typing. */
export function CharacterRegistry({ draft, target, privacyMode, busy, error, onChange, onPick, onSave }: {
  draft: CharacterEditorDraft; target: CharacterTarget | null; privacyMode: boolean; busy: boolean; error: string | null;
  onChange: (draft: CharacterEditorDraft) => void; onPick: (kind: "thumbnail" | "references") => void; onSave: () => void;
}) {
  return <section className="character-registry" aria-label="캐릭터 설정">
    <TextField label="캐릭터 이름" value={draft.name} onChange={e => onChange({ ...draft, name: e.target.value })} disabled={busy} />
    <label className="character-description">설명<textarea value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} disabled={busy} rows={3} /></label>
    <div className="character-portrait-editor">
      <button type="button" className="character-portrait-editor__preview" disabled={busy} aria-label="대표 이미지 선택" onClick={() => onPick("thumbnail")}>
        {draft.thumbnail ? <img className={privacyMode ? "character-private" : ""} src={thumbnailUrl(draft.thumbnail)} alt="대표 이미지" /> : <PhotoIcon aria-hidden="true" />}
      </button>
      <div><Button size="sm" disabled={busy} onClick={() => onPick("thumbnail")}>대표 이미지</Button>{draft.thumbnail && <Button size="icon" variant="ghost" aria-label="대표 이미지 해제" disabled={busy} onClick={() => onChange({ ...draft, thumbnail: null })}><XMarkIcon aria-hidden="true" /></Button>}</div>
    </div>
    <div className="character-registry__label"><span>기준 이미지</span><small>{draft.references.length}/5</small><Button size="sm" disabled={busy} onClick={() => onPick("references")}>선택</Button></div>
    <div className="character-refs" aria-label="기준 이미지">{Array.from({ length: 5 }, (_, i) => <button type="button" key={i} aria-label={`기준 이미지 ${i + 1} 선택`} disabled={busy} onClick={() => onPick("references")}>
      {draft.references[i] ? <img className={privacyMode ? "character-private" : ""} src={thumbnailUrl(draft.references[i]!)} alt={`기준 ${i + 1}`} /> : <span>{i + 1}</span>}
    </button>)}</div>
    {Boolean(target?.learnedReferences?.length) && <small>승인한 단독 이미지 {target!.learnedReferences!.length}장도 비교에 활용 중</small>}
    <label className="character-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={e => onChange({ ...draft, enabled: e.target.checked })} />분석에 사용</label>
    {error && <p role="alert">{error}</p>}
    <Button disabled={busy || !draft.name.trim()} onClick={onSave}>{target ? "저장" : "캐릭터 만들기"}</Button>
  </section>;
}
