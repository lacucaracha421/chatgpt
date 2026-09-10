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
export function CharacterRegistry({ draft, target, privacyMode, busy, error, onChange, onPick, onSave, onExcludeReference, onOpenReference }: {
  draft: CharacterEditorDraft; target: CharacterTarget | null; privacyMode: boolean; busy: boolean; error: string | null;
  onExcludeReference?: (assetId: string) => void; onOpenReference?: (assetId: string) => void;
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
    {target?.manualOnly && <p className="series-description">수동 관리 캐릭터입니다. 기준 이미지 5장을 지정해 저장하면 같은 캐릭터를 자동 분류 대상으로 전환합니다.</p>}
    <div className="character-registry__label"><span>기준 이미지</span><small>{draft.references.length}/5</small><Button size="sm" disabled={busy} onClick={() => onPick("references")}>선택</Button></div>
    <div className="character-refs" aria-label="기준 이미지">{Array.from({ length: 5 }, (_, i) => <button type="button" key={i} aria-label={`기준 이미지 ${i + 1} ${draft.references[i] && onOpenReference ? "원본 보기" : "선택"}`} disabled={busy} onClick={() => draft.references[i] && onOpenReference ? onOpenReference(draft.references[i]!) : onPick("references")}>
      {draft.references[i] ? <img className={privacyMode ? "character-private" : ""} src={thumbnailUrl(draft.references[i]!)} alt={`기준 ${i + 1}`} /> : <span>{i + 1}</span>}
    </button>)}</div>
    {target && <section aria-label="추가 참조"><div className="character-registry__label">추가 참조 <small>{target.learnedReferences?.length ?? 0}장</small></div>
      <p className="series-description">직접 학습에 추가한 이미지입니다. 일반 승인·거절과 독립적으로 유지됩니다.</p>
      <div className="character-learned-references">{target.learnedReferences?.map(reference => reference.assetId && <div key={reference.assetId}>
        <button disabled={busy || !onOpenReference} aria-label={`추가 참조 ${reference.slot + 1} 원본 보기`} onClick={() => onOpenReference?.(reference.assetId!)}><img src={thumbnailUrl(reference.assetId)} className={privacyMode ? "character-private" : ""} alt={`추가 참조 ${reference.slot + 1}`} /></button>
        <Button size="sm" variant="ghost" disabled={busy || !onExcludeReference} onClick={() => onExcludeReference?.(reference.assetId!)}>학습에서 제거</Button>
      </div>)}</div>
    </section>}
    {!target?.manualOnly && <label className="character-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={e => onChange({ ...draft, enabled: e.target.checked })} />분석에 사용</label>}
    {error && <p role="alert">{error}</p>}
    <Button disabled={busy || !draft.name.trim()} onClick={onSave}>{target ? "저장" : "캐릭터 만들기"}</Button>
  </section>;
}
