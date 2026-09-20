import { PhotoIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { thumbnailUrl } from "../assets/mediaUrl";
import { ReferenceRegionChoices, AUTOMATIC_CHARACTER_REFERENCE_COUNT, type ReferenceRegionInspection } from "./ReferenceRegionChoices";
import type { CharacterApi, CharacterTarget, ReferenceRegions } from "./api";

export type CharacterEditorDraft = { name: string; description: string; thumbnail: string | null; references: string[]; referenceRegions: ReferenceRegions; enabled: boolean };

export const MAX_CHARACTER_REFERENCES = 25;
export const activeCharacterReferences = (target: CharacterTarget | null) => target
  ? [...target.references, ...(target.learnedReferences ?? [])].filter(reference => reference.status === "ready" && reference.assetId)
  : [];
/**
 * Draft overrides start from the saved regions of the current references and
 * carry only what the user chose here; nothing is inferred or persisted for them.
 * Only regions of references that are still active are carried over.
 */
export function characterDraft(target: CharacterTarget | null): CharacterEditorDraft {
  const references = activeCharacterReferences(target).map(reference => reference.assetId!);
  const active = new Set(references);
  return { name: target?.displayName ?? "", description: target?.description ?? "", thumbnail: target?.thumbnailAssetId ?? null,
    references,
    referenceRegions: Object.fromEntries(activeCharacterReferences(target).flatMap(reference =>
      reference.assetId && reference.region && active.has(reference.assetId) ? [[reference.assetId, reference.region] as const] : [])),
    enabled: target?.enabled ?? true };
}

/**
 * Region decisions stay with the references they belong to: removing a
 * reference drops its override, and a later re-add starts from the saved region again.
 */
export function updateCharacterReferences(draft: CharacterEditorDraft, references: string[]): CharacterEditorDraft {
  const allowed = new Set(references);
  return { ...draft, references, referenceRegions: Object.fromEntries(Object.entries(draft.referenceRegions).filter(([id]) => allowed.has(id))) };
}

/** Draft ownership stays with the series so gallery selection never discards typing. */
export function CharacterRegistry({ draft, target, seriesId, privacyMode, busy, error, api, inspection, onChange, onPick, onSave, onOpenReference, onRecommendReferences }: {
  draft: CharacterEditorDraft; target: CharacterTarget | null; seriesId?: string; privacyMode: boolean; busy: boolean; error: string | null;
  api?: Pick<CharacterApi, "inspectReferenceRegions">;
  inspection?: ReferenceRegionInspection;
  onOpenReference?: (assetId: string) => void;
  onRecommendReferences?: () => void;
  onChange: (draft: CharacterEditorDraft) => void; onPick: (kind: "thumbnail" | "references") => void; onSave: () => void;
}) {
  const inspect = api?.inspectReferenceRegions;
  // The parent shares inspection with the info indicator; standalone editors can
  // still inspect their own references, including a new character's draft.
  const inspectable = Boolean(seriesId && inspect && !target?.manualOnly && draft.enabled && draft.references.length > 0);
  return <section className="character-registry" aria-label="캐릭터 설정">
    <div className="character-registry__primary">
      <TextField label="캐릭터 이름" value={draft.name} onChange={e => onChange({ ...draft, name: e.target.value })} disabled={busy} />
      <Button disabled={busy || !draft.name.trim()} onClick={onSave}>{target ? "저장" : "캐릭터 만들기"}</Button>
    </div>
    {error && <p role="alert" className="character-message">{error}</p>}
    {inspectable && inspect && seriesId && <ReferenceRegionChoices seriesId={seriesId} targetId={target?.id ?? null} assetIds={draft.references}
      draftRegions={draft.referenceRegions} savedRegions={characterDraft(target).referenceRegions} privacyMode={privacyMode} busy={busy} api={inspect} inspection={inspection}
      onChange={referenceRegions => onChange({ ...draft, referenceRegions })} />}
    {target && !target.manualOnly && !draft.enabled && <div className="character-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={() => onChange({ ...draft, enabled: true })}>자동 분류 다시 사용</Button><small>예전에 꺼 둔 캐릭터입니다.</small></div>}
    <div className="character-registry__label"><small>{draft.references.length}/{MAX_CHARACTER_REFERENCES}</small><div className="character-actions"><Button size="sm" disabled={busy} onClick={() => onPick("references")}>선택</Button>{onRecommendReferences && <Button size="sm" variant="ghost" disabled={busy} onClick={onRecommendReferences}>추천으로 보강</Button>}</div></div>
    <details className="character-registry__section">
      <summary><span>레퍼런스</span><small>{draft.enabled ? `${draft.references.length}장` : "자동 분류 꺼짐"}</small></summary>
      <div className="character-registry__section-body">
        <section className="character-learned-references" aria-label="레퍼런스 목록">{draft.references.map((assetId, index) => <div key={assetId}>
          <button type="button" disabled={busy || !onOpenReference} aria-label={`레퍼런스 ${index + 1} 원본 보기`} onClick={() => onOpenReference?.(assetId)}><img loading="lazy" src={thumbnailUrl(assetId)} className={privacyMode ? "character-private" : ""} alt={`레퍼런스 ${index + 1}`} /></button>
          <Button size="sm" variant="ghost" disabled={busy} aria-label={`레퍼런스 ${index + 1} 제거`} onClick={() => onChange(updateCharacterReferences(draft, draft.references.filter(id => id !== assetId)))}>제거</Button>
        </div>)}</section>
        {!draft.references.length && <p className="character-message">선택한 레퍼런스가 없습니다.</p>}
      </div>
    </details>
    <details className="character-registry__section" open={!target ? true : undefined}>
      <summary><span>설명·대표 이미지</span></summary>
      <div className="character-registry__section-body">
        <label className="character-description">설명<textarea value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} disabled={busy} rows={3} /></label>
        <div className="character-portrait-editor">
          <button type="button" className="character-portrait-editor__preview" disabled={busy} aria-label="대표 이미지 선택" onClick={() => onPick("thumbnail")}>
            {draft.thumbnail ? <img className={privacyMode ? "character-private" : ""} src={thumbnailUrl(draft.thumbnail)} alt="대표 이미지" /> : <PhotoIcon aria-hidden="true" />}
          </button>
          <div><Button size="sm" disabled={busy} onClick={() => onPick("thumbnail")}>대표 이미지</Button>{draft.thumbnail && <Button size="icon" variant="ghost" aria-label="대표 이미지 해제" disabled={busy} onClick={() => onChange({ ...draft, thumbnail: null })}><XMarkIcon aria-hidden="true" /></Button>}</div>
        </div>
      </div>
    </details>
    <details className="character-registry__section">
      <summary><span>분류 안내</span></summary>
      <div className="character-registry__section-body">
        <p className="series-description">직접 선택한 이미지를 모두 같은 기준으로 사용합니다. 자동 확정에는 같은 캐릭터를 지지하는 레퍼런스 {AUTOMATIC_CHARACTER_REFERENCE_COUNT}장 이상이 필요합니다.</p>
        <p className="series-description">여러 인물이 있어도 공통 인물을 찾으면 자동으로 사용합니다. 인물 영역이 불확실한 레퍼런스는 비교에서 제외하며, 필요한 경우에만 직접 선택할 수 있습니다.</p>
        <p className="series-description">휴지통 이미지는 제외되며 복원하면 다시 사용합니다. 과거 이미지는 자동으로 다시 분석하지 않습니다.</p>
      </div>
    </details>
  </section>;
}
