import { useEffect, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { thumbnailUrl } from "../assets/mediaUrl";
import { draftReferenceRegions, regionBox, referenceRegionBinding, referenceRegionIndex, staleReferenceRegion, usableReferenceRegionStates, needsReferenceRegionChoice, type ReferenceInspection, type ReferenceRegions } from "./api";

/** Mirrors the backend rule: automatic confirmation needs six supporting references. */
export const AUTOMATIC_CHARACTER_REFERENCE_COUNT = 6;

/** An inspection supplies a reference without asking anything only in these states. */
const usableRegion = (region: ReferenceInspection) => usableReferenceRegionStates.some(state => state === region.state);

/** References the backend resolved on its own, i.e. common-person images it can use. */
export const automaticReferenceCount = (inspections: ReferenceInspection[]) =>
  inspections.filter(region => region.state === "automatic").length;

/** How many references need no choice at all, from the current inspection result. */
export const usableReferenceCount = (inspections: ReferenceInspection[]) => inspections.filter(usableRegion).length;

export const needsReferenceConfirmation = (inspections: ReferenceInspection[]) =>
  usableReferenceCount(inspections) < AUTOMATIC_CHARACTER_REFERENCE_COUNT && inspections.some(needsReferenceRegionChoice);

export type ReferenceRegionInspection = { inspections: ReferenceInspection[] | null; error: string | null; retry?: () => void };
type InspectionRequest = {
  seriesId: string; targetId: string | null; assetIds: string[]; draftRegions: ReferenceRegions;
  api?: (import("./api").CharacterApi)["inspectReferenceRegions"]; revision?: string;
};

/** One inspection owner can feed both the unopened info indicator and the editor. */
export function useReferenceRegionInspection({ seriesId, targetId, assetIds, draftRegions, api, revision }: InspectionRequest): ReferenceRegionInspection {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([seriesId, targetId, assetIds, draftRegions, revision, attempt]);
  const [result, setResult] = useState<(ReferenceRegionInspection & { key: string; api: InspectionRequest["api"] }) | null>(null);
  useEffect(() => {
    if (!api || !seriesId || !assetIds.length) return;
    let active = true;
    api(seriesId, targetId, assetIds, draftRegions)
      .then(inspections => { if (active) setResult({ key, api, inspections, error: null }); })
      .catch(reason => {
        if (active) setResult({ key, api, inspections: null, error: commandErrorMessage(reason, "인물 영역을 확인하지 못했습니다.") });
      });
    return () => { active = false; };
  }, [key, api]);
  const current = api && result?.key === key && result.api === api ? result : { inspections: null, error: null };
  return { ...current, retry: () => setAttempt(value => value + 1) };
}

/** Short state label shared by the reference strip and the correction list. */
export function referenceRegionStatus(region: ReferenceInspection, draftRegions: ReferenceRegions, changedRegions: ReferenceRegions) {
  if (staleReferenceRegion(region)) return draftRegions[region.assetId] ? "직접 지정 · 재확인 필요" : "인물 재확인 필요";
  if (region.state === "selected") return changedRegions[region.assetId] ? "직접 지정 · 저장 전" : "직접 지정 · 저장됨";
  if (region.state === "automatic") return "자동 확인";
  if (region.state === "single") return "한 명 감지 · 자동 사용";
  return "인물 확인 필요 · 미사용";
}

/** The crop an inspection currently uses, or null when the reference has none. */
export const currentReferenceCrop = (region: ReferenceInspection) => usableRegion(region) ? regionBox(region, referenceRegionIndex(region)) : null;
export const isUsableReferenceRegion = usableRegion;

/** Cropped region preview. Inspection reports upright image dimensions. */
function RegionImage({ assetId, box, width, height, label, selectionLabel, privacyMode, disabled, onSelect }: {
  assetId: string; box: [number, number, number, number]; width: number; height: number; label: string;
  selectionLabel?: string; privacyMode: boolean; disabled: boolean; onSelect: () => void;
}) {
  const cropWidth = Math.max(box[2] - box[0], 1);
  const cropHeight = Math.max(box[3] - box[1], 1);
  // A background position percentage is the frame's share of the overflow, so a
  // crop that fills its dimension has nothing to offset.
  const position = (offset: number, image: number, crop: number) => {
    const overflow = image - crop;
    return overflow > 0 ? (offset / overflow) * 100 : 0;
  };
  const style = {
    aspectRatio: `${cropWidth} / ${cropHeight}`,
    backgroundImage: `url("${thumbnailUrl(assetId)}")`,
    backgroundPositionX: `${position(box[0], width, cropWidth)}%`,
    backgroundPositionY: `${position(box[1], height, cropHeight)}%`,
    backgroundSize: `${(width / cropWidth) * 100}% ${(height / cropHeight) * 100}%`,
  };
  return <button type="button" className={`character-region-frame${privacyMode ? " character-private" : ""}`} style={style}
    disabled={disabled} aria-label={label} aria-pressed={Boolean(selectionLabel)} aria-description={selectionLabel} onClick={onSelect}>
    {selectionLabel && <span className="character-region-frame__selection">{selectionLabel}</span>}
  </button>;
}

/**
 * Region correction for the references of one character.
 *
 * The backend decides on its own which references it can use. This section only
 * surfaces the images it could not resolve, and only when the character is short
 * of the references automatic confirmation needs. Every step is optional: with
 * enough usable references there is no prompt at all, and the chooser opens on
 * request rather than on render.
 */
export function ReferenceRegionChoices({ seriesId, targetId, assetIds, draftRegions, savedRegions = {}, privacyMode, busy, api, inspection, focusRequest, onOpenOriginal, onChange }: {
  seriesId: string; targetId: string | null; assetIds: string[]; draftRegions: ReferenceRegions; savedRegions?: ReferenceRegions;
  privacyMode: boolean; busy: boolean; api: NonNullable<(import("./api").CharacterApi)["inspectReferenceRegions"]>;
  inspection?: ReferenceRegionInspection;
  /** Opens one reference's crop directly (e.g. from a tapped strip tile); `key` repeats the same request. */
  focusRequest?: { assetId: string; key: number } | null;
  onOpenOriginal?: (assetId: string) => void;
  /** Receives only manual draft overrides; nothing is written to the database. */
  onChange: (regions: ReferenceRegions) => void;
}) {
  const localInspection = useReferenceRegionInspection({ seriesId, targetId, assetIds, draftRegions, api: inspection ? undefined : api });
  // "required" is the shortfall workflow the user explicitly opened; it ends by itself
  // once the threshold is met. "correction" is an optional adjustment that stays open.
  // "focus" checks one reference the user tapped and closes after a choice.
  const [mode, setMode] = useState<"required" | "correction" | "focus" | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const { inspections: current, error, retry } = inspection ?? localInspection;
  const inspections = current ?? [];
  const changedRegions = draftReferenceRegions(draftRegions, assetIds, savedRegions);
  const regionStatus = (region: ReferenceInspection) => referenceRegionStatus(region, draftRegions, changedRegions);
  // An unresolved reference is one the user must still place. A stored binding is not
  // trusted on its own: when the native side reports it stale, the user re-chooses rather
  // than having the region silently swapped for them.
  const unresolved = inspections.filter(region => needsReferenceRegionChoice(region));
  // References the user already decided and that the inspection still honours. Their region
  // can be replaced, but they are never part of the required prompt.
  const adjustable = inspections.filter(region => draftRegions[region.assetId] && !needsReferenceRegionChoice(region));
  // References the worker resolved on its own. Correction stays reachable even when
  // nothing is required, because an inferred crop is not a user decision.
  const resolved = inspections.filter(region => !draftRegions[region.assetId] && usableRegion(region));
  const usable = usableReferenceCount(inspections);
  const enough = usable >= AUTOMATIC_CHARACTER_REFERENCE_COUNT;
  // Anything the user may correct: the unresolved images, their own honoured choices, and
  // the crops the worker inferred. `no_region` is excluded because there is no crop.
  const correctable = [...unresolved, ...adjustable, ...resolved].filter(region => region.boxes.length > 0);
  const choosable = correctable.filter((region, index) => correctable.findIndex(row => row.assetId === region.assetId) === index);
  // In the required workflow the next unresolved reference is the default target, so a
  // settled reference never leaves the chooser pointing at nothing.
  const fallback = mode === "required" ? unresolved[0]?.assetId ?? null : null;
  const active = choosable.find(region => region.assetId === (chosen ?? fallback)) ?? null;

  useEffect(() => {
    if (chosen && !choosable.some(region => region.assetId === chosen)) {
      setChosen(null);
      if (mode === "focus") setMode(null);
    }
  }, [chosen, choosable]);

  useEffect(() => {
    if (!focusRequest || !choosable.some(region => region.assetId === focusRequest.assetId)) return;
    setMode("focus"); setChosen(focusRequest.assetId);
  }, [focusRequest?.key]);

  // The shortfall workflow ends only when the threshold is genuinely met. A pick
  // briefly leaves nothing unresolved until the reinspection lands, so an empty
  // list alone must not close it.
  useEffect(() => {
    if (mode === "required" && enough) setMode(null);
  }, [mode, enough]);

  if (!assetIds.length) return null;

  const openRequired = () => { setMode("required"); setChosen(unresolved[0]?.assetId ?? null); };
  // Correction opens the list first so the user picks which reference to adjust.
  const openCorrection = () => { setMode("correction"); setChosen(null); };
  const close = () => { setMode(null); setChosen(null); };

  function pick(index: number) {
    if (!active) return;
    const binding = referenceRegionBinding(active, index);
    if (!binding) return;
    onChange({ ...draftRegions, [active.assetId]: binding });
    // Only the required workflow advances to the next reference that still needs a
    // decision. A correction clears the target, so the optional list comes back.
    if (mode === "focus") { close(); return; }
    setChosen(mode === "required" ? unresolved.find(region => region.assetId !== active.assetId)?.assetId ?? null : null);
  }

  // Skip advances through every unresolved reference and wraps once, so all of N are reachable.
  function skip() {
    if (!active || unresolved.length < 2) return;
    const index = unresolved.findIndex(region => region.assetId === active.assetId);
    setChosen(unresolved[(index + 1) % unresolved.length]!.assetId);
  }

  // A chooser only renders for a selected reference in an open workflow.
  const open = mode && active ? { mode, region: active } : null;
  // A suggestion is only useful when it differs from the crop already in effect.
  const suggested = open?.region.suggestedIndex !== null && open?.region.suggestedIndex !== undefined && open.region.suggestedIndex !== referenceRegionIndex(open.region)
    ? open.region.suggestedIndex : null;
  // A shortfall with something unresolved is the only reason to interrupt the user.
  const askRequired = Boolean(current) && needsReferenceConfirmation(inspections);
  // Correcting an inferred, chosen, or stale crop is always possible, but never requested.
  // A stale binding must stay recoverable even when the image holds a single person, and a
  // choice the user made stays theirs to change.
  const corrections = correctable
    .filter(region => region.boxes.length > 1 || Boolean(draftRegions[region.assetId]) || staleReferenceRegion(region))
    .sort((a, b) => assetIds.indexOf(a.assetId) - assetIds.indexOf(b.assetId));
  const canCorrect = Boolean(current) && corrections.length > 0;
  // With enough usable references the section stays quiet unless the user opened it.
  const showSection = Boolean(error) || Boolean(open) || askRequired || mode === "correction" || canCorrect;
  if (!showSection) return null;
  // Progress counts the references still needing a decision. A correction may target a
  // reference that is not in that list, so it reports its position in the draft instead.
  const position = open ? unresolved.findIndex(region => region.assetId === open.region.assetId) : -1;
  const progress = open
    ? position >= 0 ? { current: position + 1, total: unresolved.length }
      : { current: assetIds.indexOf(open.region.assetId) + 1, total: assetIds.length }
    : null;
  return <section className="character-reference-regions" aria-label="인물 영역 확인">
    {error && <><p role="alert">{error}</p>{retry && <Button size="sm" variant="ghost" disabled={busy} onClick={retry}>인물 확인 다시 시도</Button>}</>}
    {!error && mode === null && <div className="character-actions">
      {askRequired && <Button size="sm" disabled={busy} onClick={openRequired}>필요한 인물만 확인</Button>}
      {/* A shortfall and an optional adjustment are different jobs, so both stay reachable. */}
      {canCorrect && <Button size="sm" variant="ghost" disabled={busy} onClick={openCorrection}>인물 영역 조정</Button>}
    </div>}
    {/* A required workflow that no longer needs anything becomes an optional adjustment. */}
    {!error && mode === "required" && !open && <div className="character-actions">
      {canCorrect && <Button size="sm" variant="ghost" disabled={busy} onClick={openCorrection}>인물 영역 조정</Button>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={close}>닫기</Button>
    </div>}
    {mode === "correction" && !open && <div className="character-actions">
      <Button size="sm" variant="ghost" disabled={busy} onClick={close}>닫기</Button>
    </div>}
    {/* The correction list belongs to an open correction, so the quiet default shows nothing. */}
    {mode === "correction" && !open && corrections.length > 0 && <div className="character-region-summary" role="region" aria-label="인물 영역 목록">{corrections.map(region => {
      const number = assetIds.indexOf(region.assetId) + 1;
      const status = regionStatus(region);
      const bounds = usableRegion(region) ? regionBox(region, referenceRegionIndex(region)) : null;
      return <div key={region.assetId} role="group" aria-label={`레퍼런스 ${number} · ${status}`}>
        <div className="character-region-summary__preview">
          <svg className={privacyMode ? "character-private" : undefined} viewBox={`0 0 ${region.width} ${region.height}`} role="img" aria-label={`레퍼런스 ${number}${bounds ? " 사용 중인 인물 영역" : " 인물 미지정"}`}>
            <image href={thumbnailUrl(region.assetId)} width={region.width} height={region.height} />
            {bounds && <rect x={bounds[0]} y={bounds[1]} width={bounds[2] - bounds[0]} height={bounds[3] - bounds[1]} vectorEffect="non-scaling-stroke" />}
          </svg>
        </div>
        <span className="character-region-summary__status">{status}</span>
        <Button size="sm" variant="ghost" disabled={busy}
          aria-label={`레퍼런스 ${number} 인물 영역 변경`}
          onClick={() => setChosen(region.assetId)}>{needsReferenceRegionChoice(region) ? "인물 선택" : "변경"}</Button>
      </div>;
    })}</div>}
    {open && progress && <>
      <p className="character-registry__label"><small>{progress.current}/{progress.total}</small><span>사용할 인물을 한 명 선택하세요</span></p>
      <p className="character-message">{regionStatus(open.region)}</p>
      <div className="character-region-options">{open.region.boxes.map((box, index) =>
        <RegionImage key={`${open.region.assetId}-${index}`} assetId={open.region.assetId} box={box} width={open.region.width} height={open.region.height}
          label={`인물 영역 ${index + 1} 선택`}
          selectionLabel={usableRegion(open.region) && referenceRegionIndex(open.region) === index ? open.region.state === "selected" ? "직접 지정한 인물" : "자동 선택된 인물" : undefined}
          privacyMode={privacyMode} disabled={busy}
          onSelect={() => pick(index)} />)}</div>
      <div className="character-actions">
        {open.mode === "required" && unresolved.length > 1 && <Button size="sm" variant="ghost" disabled={busy} onClick={skip}>다음 이미지</Button>}
        {suggested !== null && <Button size="sm" disabled={busy} onClick={() => pick(suggested)}>추천 영역 사용</Button>}
        {/* An optional adjustment stays reachable while the shortfall workflow is running. */}
        {open.mode === "required" && canCorrect && <Button size="sm" variant="ghost" disabled={busy} onClick={openCorrection}>인물 영역 조정</Button>}
        {open.mode === "focus" && onOpenOriginal && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onOpenOriginal(open.region.assetId)}>원본 보기</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={close}>닫기</Button>
      </div>
    </>}
  </section>;
}
