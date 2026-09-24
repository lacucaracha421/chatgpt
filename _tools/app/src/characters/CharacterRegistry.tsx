import { useId, useState, type ReactNode } from "react";
import { PhotoIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { thumbnailUrl } from "../assets/mediaUrl";
import { ReferenceRegionChoices, AUTOMATIC_CHARACTER_REFERENCE_COUNT, currentReferenceCrop, isUsableReferenceRegion, referenceRegionStatus, useReferenceRegionInspection, usableReferenceCount, type ReferenceRegionInspection } from "./ReferenceRegionChoices";
import { draftReferenceRegions, type CharacterApi, type CharacterTarget, type ReferenceInspection, type ReferenceRegions } from "./api";

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

/** A strip tile shows the crop the character actually uses, not the whole image. */
function ReferenceThumb({ assetId, region, privacyMode }: { assetId: string; region: ReferenceInspection | undefined; privacyMode: boolean }) {
  const crop = region ? currentReferenceCrop(region) : null;
  if (!region || !crop) return <img loading="lazy" src={thumbnailUrl(assetId)} className={privacyMode ? "character-private" : undefined} alt="" />;
  const width = Math.max(crop[2] - crop[0], 1), height = Math.max(crop[3] - crop[1], 1);
  return <svg className={privacyMode ? "character-private" : undefined} viewBox={`${crop[0]} ${crop[1]} ${width} ${height}`} preserveAspectRatio="xMidYMin slice" aria-hidden="true">
    <image href={thumbnailUrl(assetId)} width={region.width} height={region.height} preserveAspectRatio="none" />
  </svg>;
}

/**
 * Character panel body. References and their crops come first; automation state is
 * one line; rarely used settings sit in one closed disclosure. Saving is the host's footer.
 */
export function CharacterRegistry({ draft, target, seriesId, privacyMode, busy, error, api, inspection, automationStatus, management, onChange, onPick, onOpenReference, onRecommendReferences }: {
  draft: CharacterEditorDraft; target: CharacterTarget | null; seriesId?: string; privacyMode: boolean; busy: boolean; error: string | null;
  api?: Pick<CharacterApi, "inspectReferenceRegions">;
  inspection?: ReferenceRegionInspection;
  /** S36 state for this character, appended to the automation line. */
  automationStatus?: string | null;
  /** Host-owned rare actions (history refresh, conversion, S36 exclusion, FAULT) shown under 관리. */
  management?: ReactNode;
  onOpenReference?: (assetId: string) => void;
  onRecommendReferences?: () => void;
  onChange: (draft: CharacterEditorDraft) => void; onPick: (kind: "thumbnail" | "references") => void;
}) {
  const inspect = api?.inspectReferenceRegions;
  // The parent shares inspection with the info indicator; standalone editors can
  // still inspect their own references, including a new character's draft.
  const inspectable = Boolean(seriesId && inspect && !target?.manualOnly && draft.enabled && draft.references.length > 0);
  const localInspection = useReferenceRegionInspection({ seriesId: seriesId ?? "", targetId: target?.id ?? null,
    assetIds: draft.references, draftRegions: draft.referenceRegions, api: inspection || !inspectable ? undefined : inspect });
  const shared = inspection ?? localInspection;
  const inspections = inspectable ? shared.inspections : null;
  const regionOf = (assetId: string) => inspections?.find(region => region.assetId === assetId);
  const changedRegions = draftReferenceRegions(draft.referenceRegions, draft.references, characterDraft(target).referenceRegions);
  const headingId = useId();
  const [focusRequest, setFocusRequest] = useState<{ assetId: string; key: number } | null>(null);
  const automatic = !target?.manualOnly && draft.enabled;
  const usable = inspections ? usableReferenceCount(inspections) : draft.references.length;
  const shortfall = automatic && usable < AUTOMATIC_CHARACTER_REFERENCE_COUNT
    ? `${inspections ? "사용 가능" : "레퍼런스"} ${usable.toLocaleString()}장 · ${AUTOMATIC_CHARACTER_REFERENCE_COUNT}장 이상 권장` : null;
  const nameField = <TextField label="캐릭터 이름" value={draft.name} onChange={e => onChange({ ...draft, name: e.target.value })} disabled={busy} />;
  return <section className="character-registry" aria-label="캐릭터 설정">
    {!target && nameField}
    {error && <p role="alert" className="character-message">{error}</p>}
    <section className="character-registry__references" aria-labelledby={headingId}>
      <h3 className="character-registry__heading" id={headingId}>레퍼런스<small>{draft.references.length}/{MAX_CHARACTER_REFERENCES}</small></h3>
      <div className="character-actions">
        <Button size="sm" disabled={busy} onClick={() => onPick("references")}>레퍼런스 추가</Button>
        {onRecommendReferences && <Button size="sm" variant="ghost" disabled={busy} onClick={onRecommendReferences}>추천으로 보강</Button>}
      </div>
      {shortfall && <p className="character-registry__hint" role="status">{shortfall}</p>}
      {draft.references.length > 0 ? <section className="character-reference-strip" aria-label="레퍼런스 목록">{draft.references.map((assetId, index) => {
        const region = regionOf(assetId);
        const croppable = Boolean(region && region.boxes.length > 0);
        const status = region ? referenceRegionStatus(region, draft.referenceRegions, changedRegions) : undefined;
        const attention = Boolean(region && !isUsableReferenceRegion(region));
        return <div className="character-reference-tile" key={assetId}>
          {croppable
            ? <button type="button" className="character-reference-tile__open" disabled={busy} aria-label={`레퍼런스 ${index + 1} 크롭 확인`} aria-description={status}
              onClick={() => setFocusRequest(old => ({ assetId, key: (old?.key ?? 0) + 1 }))}><ReferenceThumb assetId={assetId} region={region} privacyMode={privacyMode} /></button>
            : <button type="button" className="character-reference-tile__open" disabled={busy || !onOpenReference} aria-label={`레퍼런스 ${index + 1} 원본 보기`} aria-description={status}
              onClick={() => onOpenReference?.(assetId)}><ReferenceThumb assetId={assetId} region={region} privacyMode={privacyMode} /></button>}
          {attention && <span className="character-reference-tile__mark" aria-hidden="true">!</span>}
          <Button size="icon" variant="ghost" className="character-reference-tile__remove" disabled={busy} aria-label={`레퍼런스 ${index + 1} 제거`}
            onClick={() => onChange(updateCharacterReferences(draft, draft.references.filter(id => id !== assetId)))}><XMarkIcon aria-hidden="true" /></Button>
        </div>;
      })}</section> : !shortfall && <p className="character-message">레퍼런스가 없습니다.</p>}
      {inspectable && inspect && seriesId && <ReferenceRegionChoices seriesId={seriesId} targetId={target?.id ?? null} assetIds={draft.references}
        draftRegions={draft.referenceRegions} savedRegions={characterDraft(target).referenceRegions} privacyMode={privacyMode} busy={busy} api={inspect} inspection={shared}
        focusRequest={focusRequest} onOpenOriginal={onOpenReference}
        onChange={referenceRegions => onChange({ ...draft, referenceRegions })} />}
    </section>
    {target && <div className="character-registry__automation">
      <span>{target.manualOnly ? "수동 관리" : draft.enabled ? "자동 분류 켜짐" : "자동 분류 꺼짐"}{automationStatus ? ` · ${automationStatus}` : ""}</span>
      {!target.manualOnly && !draft.enabled && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onChange({ ...draft, enabled: true })}>자동 분류 다시 사용</Button>}
    </div>}
    <details className="character-registry__section" open={!target ? true : undefined}>
      <summary><span>{target ? "관리" : "설명·대표 이미지"}</span></summary>
      <div className="character-registry__section-body">
        {target && nameField}
        <label className="character-description">설명<textarea value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} disabled={busy} rows={3} /></label>
        <div className="character-portrait-editor">
          <button type="button" className="character-portrait-editor__preview" disabled={busy} aria-label="대표 이미지 선택" onClick={() => onPick("thumbnail")}>
            {draft.thumbnail ? <img className={privacyMode ? "character-private" : ""} src={thumbnailUrl(draft.thumbnail)} alt="대표 이미지" /> : <PhotoIcon aria-hidden="true" />}
          </button>
          <div><Button size="sm" disabled={busy} onClick={() => onPick("thumbnail")}>대표 이미지</Button>{draft.thumbnail && <Button size="icon" variant="ghost" aria-label="대표 이미지 해제" disabled={busy} onClick={() => onChange({ ...draft, thumbnail: null })}><XMarkIcon aria-hidden="true" /></Button>}</div>
        </div>
        {management && <div className="character-registry__management">{management}</div>}
      </div>
    </details>
  </section>;
}
