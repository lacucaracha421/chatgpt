import { PhotoIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { thumbnailUrl } from "../assets/mediaUrl";
import type { CharacterTarget } from "./api";

export type CharacterEditorDraft = { name: string; description: string; thumbnail: string | null; references: string[]; enabled: boolean };

export const MAX_CHARACTER_REFERENCES = 25;
export const activeCharacterReferences = (target: CharacterTarget | null) => target
  ? [...target.references, ...(target.learnedReferences ?? [])].filter(reference => reference.status === "ready" && reference.assetId)
  : [];
export function characterDraft(target: CharacterTarget | null): CharacterEditorDraft {
  return { name: target?.displayName ?? "", description: target?.description ?? "", thumbnail: target?.thumbnailAssetId ?? null,
    references: activeCharacterReferences(target).map(r => r.assetId!), enabled: target?.enabled ?? true };
}

/** Draft ownership stays with the series so gallery selection never discards typing. */
export function CharacterRegistry({ draft, target, privacyMode, busy, error, onChange, onPick, onSave, onOpenReference }: {
  draft: CharacterEditorDraft; target: CharacterTarget | null; privacyMode: boolean; busy: boolean; error: string | null;
  onOpenReference?: (assetId: string) => void;
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
    <details className="character-registry__section" open={!target || target.manualOnly || !target.ready ? true : undefined}>
      <summary><span>레퍼런스</span><small>{draft.enabled ? `${draft.references.length}장` : "자동 분류 꺼짐"}</small></summary>
      <div className="character-registry__section-body">
        <p className="series-description">직접 선택한 이미지를 모두 같은 기준으로 사용합니다. 자동 확정에는 같은 캐릭터를 지지하는 레퍼런스 6장 이상이 필요합니다.</p>
        <p className="series-description">휴지통 이미지는 제외되며 복원하면 다시 사용합니다. 과거 이미지는 자동으로 다시 분석하지 않습니다.</p>
        <div className="character-registry__label"><small>{draft.references.length}/{MAX_CHARACTER_REFERENCES}</small><Button size="sm" disabled={busy} onClick={() => onPick("references")}>선택</Button></div>
        <section className="character-learned-references" aria-label="레퍼런스 목록">{draft.references.map((assetId, index) => <div key={assetId}>
          <button type="button" disabled={busy || !onOpenReference} aria-label={`레퍼런스 ${index + 1} 원본 보기`} onClick={() => onOpenReference?.(assetId)}><img loading="lazy" src={thumbnailUrl(assetId)} className={privacyMode ? "character-private" : ""} alt={`레퍼런스 ${index + 1}`} /></button>
          <Button size="sm" variant="ghost" disabled={busy} aria-label={`레퍼런스 ${index + 1} 제거`} onClick={() => onChange({ ...draft, references: draft.references.filter(id => id !== assetId) })}>제거</Button>
        </div>)}</section>
        {target && !target.manualOnly && !draft.enabled && <div className="character-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={() => onChange({ ...draft, enabled: true })}>자동 분류 다시 사용</Button><small>예전에 꺼 둔 캐릭터입니다.</small></div>}
      </div>
    </details>
    {error && <p role="alert">{error}</p>}
    <Button disabled={busy || !draft.name.trim()} onClick={onSave}>{target ? "저장" : "캐릭터 만들기"}</Button>
  </section>;
}
