import { useAssetMask } from "../privacy/PrivacyContext";
import { AssetSvgImage } from "../privacy/AssetImage";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { UserIcon } from "@heroicons/react/24/outline";
import { commandErrorMessage } from "../library/errorMessage";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { Button } from "../shared/ui/Button";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { characterApi, type CharacterApi } from "./api";
import { thumbnailUrl } from "../assets/mediaUrl";
import { draftReferenceRegions, refusedAsWholeFrame, regionBox, takenBoxOwner, referenceRegionBinding, referenceRegionIndex, staleReferenceRegion, usableReferenceRegionStates, needsReferenceRegionChoice, type ReferenceInspection, type ReferenceRegions } from "./api";

/** Mirrors the backend rule: automatic confirmation needs six supporting references. */
export const AUTOMATIC_CHARACTER_REFERENCE_COUNT = 6;

/** An inspection supplies a reference without asking anything only in these states. */
const usableRegion = (region: ReferenceInspection) => usableReferenceRegionStates.some(state => state === region.state)
  && !refusedAsWholeFrame(region, regionBox(region, referenceRegionIndex(region)))
  && takenBoxOwner(region, referenceRegionIndex(region)) === null;

/** References the backend resolved on its own, i.e. common-person images it can use. */
export const automaticReferenceCount = (inspections: ReferenceInspection[]) =>
  inspections.filter(region => region.state === "automatic").length;

/** How many references need no choice at all, from the current inspection result. */
export const usableReferenceCount = (inspections: ReferenceInspection[]) => inspections.filter(usableRegion).length;

/** An image shared with another character cannot be saved until its person is chosen. */
const sharedNeedsChoice = (region: ReferenceInspection) => Boolean(region.otherCharacters?.length) && needsReferenceRegionChoice(region);

export const needsReferenceConfirmation = (inspections: ReferenceInspection[]) =>
  (usableReferenceCount(inspections) < AUTOMATIC_CHARACTER_REFERENCE_COUNT && inspections.some(needsReferenceRegionChoice))
  || inspections.some(sharedNeedsChoice);

/** The references whose missing person choice makes the save refuse, as 1-based slots in the draft. */
export function blockedSaveReferences(inspections: ReferenceInspection[] | null | undefined, assetIds: string[]) {
  if (!inspections) return [];
  return assetIds.flatMap((assetId, index) => {
    const region = inspections.find(row => row.assetId === assetId);
    return region && sharedNeedsChoice(region) ? [{ assetId, number: index + 1 }] : [];
  });
}

/** A person choice would make this reference usable: it has a person left that no other character owns. */
export const referenceNeedsPerson = (region: ReferenceInspection) =>
  needsReferenceRegionChoice(region) && region.boxes.length - (region.takenBoxes?.length ?? 0) > 0;

/** How many references the quiet indicators ask a person for; zero when nothing is asked. */
export const personChoiceCount = (inspections: ReferenceInspection[]) =>
  needsReferenceConfirmation(inspections) ? inspections.filter(needsReferenceRegionChoice).length : 0;

export type ReferenceRegionInspection = { inspections: ReferenceInspection[] | null; error: string | null; retry?: () => void; refresh?: () => Promise<void> };
type InspectionRequest = {
  seriesId: string; targetId: string | null; assetIds: string[]; draftRegions: ReferenceRegions;
  api?: (import("./api").CharacterApi)["inspectReferenceRegions"]; revision?: string;
  /** Identifies the open library, so a remembered result never crosses libraries. */
  libraryKey?: string;
};

/**
 * Last inspection per library, character, revision, reference set and draft choices for this
 * session (per inspection API). Reopening the editor paints that known result at once while the
 * native side answers again silently. An entry is only valid for exactly the key it was stored under.
 */
const MAX_REMEMBERED_INSPECTIONS = 48;
const rememberedInspections = new WeakMap<object, Map<string, ReferenceInspection[]>>();
const rememberedFor = (api: object) => {
  let entries = rememberedInspections.get(api);
  if (!entries) rememberedInspections.set(api, entries = new Map());
  return entries;
};
function rememberInspections(api: object, key: string, rows: ReferenceInspection[]) {
  const entries = rememberedFor(api);
  entries.delete(key);
  entries.set(key, rows);
  while (entries.size > MAX_REMEMBERED_INSPECTIONS) entries.delete(entries.keys().next().value as string);
}

/**
 * A person the user just chose counts at once, before the native reinspection returns: the
 * same row the inspection will report for a binding that names one of the image's boxes.
 * A binding that no longer matches the image or detector leaves the row as inspected, and so
 * does a whole-frame choice on an image another character owns: the save refuses it.
 */
export function withDraftChoices(inspections: ReferenceInspection[], draftRegions: ReferenceRegions): ReferenceInspection[] {
  return inspections.map(row => {
    const draft = draftRegions[row.assetId];
    if (!draft || draft.contentHash !== row.contentHash || draft.baselineFingerprint !== row.baselineFingerprint) return row;
    if (refusedAsWholeFrame(row, draft.bounds)) return row;
    const index = row.boxes.findIndex(box => box.every((value, side) => value === draft.bounds[side]));
    // A person another character is registered on is no choice: the save refuses it.
    return index < 0 || takenBoxOwner(row, index) !== null ? row : { ...row, state: "selected", selectedIndex: index, automaticIndex: null };
  });
}

/**
 * One inspection owner can feed both the unopened info indicator and the editor.
 *
 * Choosing a person changes only the draft regions, so the reinspection it triggers keeps
 * showing the last result for the same references (with the choice applied) instead of
 * dropping to nothing: the "!" marks, the usable count and the chooser must not blink while
 * the native side answers. Any other change (series, character, reference list, revision,
 * retry) still starts from nothing, unless this session already inspected exactly that state.
 */
export function useReferenceRegionInspection({ seriesId, targetId, assetIds, draftRegions, api, revision, libraryKey = "" }: InspectionRequest): ReferenceRegionInspection {
  const [attempt, setAttempt] = useState(0);
  const cacheKey = JSON.stringify([libraryKey, seriesId, targetId, [...assetIds].sort(), revision, draftRegions]);
  const key = JSON.stringify([seriesId, targetId, assetIds, draftRegions, revision, attempt]);
  const scope = JSON.stringify([seriesId, targetId, [...assetIds].sort(), revision, attempt]);
  const request = useRef(0);
  const latest = useRef({ key, api });
  latest.current = { key, api };
  const [result, setResult] = useState<(ReferenceRegionInspection & { key: string; scope: string; api: InspectionRequest["api"] }) | null>(null);
  useEffect(() => {
    if (!api || !seriesId || !assetIds.length) return;
    let active = true;
    const generation = ++request.current;
    api(seriesId, targetId, assetIds, draftRegions)
      .then(inspections => {
        if (!active || generation !== request.current) return;
        rememberInspections(api, cacheKey, inspections);
        setResult({ key, scope, api, inspections, error: null });
      })
      .catch(reason => {
        if (active && generation === request.current) setResult({ key, scope, api, inspections: null, error: commandErrorMessage(reason, "인물 영역을 확인하지 못했습니다.") });
      });
    return () => { active = false; ++request.current; };
  }, [key, api]);
  const none = { inspections: null, error: null };
  const known = api && assetIds.length ? rememberedFor(api).get(cacheKey) : undefined;
  const current = !api ? none
    : result && result.key === key && result.api === api ? result
    : known ? { inspections: known, error: null }
    : result && result.scope === scope && result.inspections ? { inspections: withDraftChoices(result.inspections, draftRegions), error: null }
    : none;
  // Refresh ownership in place: preserve the last result until its replacement arrives.
  const refresh = async () => {
    if (!api) return;
    const generation = ++request.current;
    const inspections = await api(seriesId, targetId, assetIds, draftRegions);
    if (generation === request.current && latest.current.key === key && latest.current.api === api) {
      rememberInspections(api, cacheKey, inspections);
      setResult({ key, scope, api, inspections, error: null });
    }
  };
  return { ...current, retry: () => setAttempt(value => value + 1), refresh };
}

/** Short state label shared by the reference strip and the correction list. */
export function referenceRegionStatus(region: ReferenceInspection, draftRegions: ReferenceRegions, changedRegions: ReferenceRegions) {
  if (staleReferenceRegion(region)) return draftRegions[region.assetId] ? "직접 지정 · 재확인 필요" : "인물 재확인 필요";
  if (region.state === "selected") return changedRegions[region.assetId] ? "직접 지정 · 저장 전" : "직접 지정 · 저장됨";
  if (region.state === "automatic") return "자동 확인";
  if (region.state === "single") return "한 명 감지 · 자동 사용";
  if (region.boxes.length > 0 && region.takenBoxes?.length === region.boxes.length) return `이미지의 인물이 모두 다른 캐릭터(${[...new Set(region.takenBoxes.map(taken => taken.character))].join(", ")})로 등록돼 있어 사용할 수 없음`;
  if (region.otherCharacters?.length && region.boxes.length === 0) return `다른 캐릭터(${region.otherCharacters.join(", ")}) 이미지 · 인물을 찾지 못해 사용할 수 없음`;
  if (region.otherCharacters?.length) return `다른 캐릭터(${region.otherCharacters.join(", ")}) 이미지 · 인물 지정 필요`;
  return "인물 확인 필요 · 미사용";
}

/** The crop an inspection currently uses, or null when the reference has none. */
export const currentReferenceCrop = (region: ReferenceInspection) => usableRegion(region) ? regionBox(region, referenceRegionIndex(region)) : null;
export const isUsableReferenceRegion = usableRegion;

/** Cropped region preview. Inspection reports upright image dimensions. */
function RegionImage({ assetId, box, width, height, label, selectionLabel, takenBy, privacyMode, disabled, onSelect }: {
  assetId: string; box: [number, number, number, number]; width: number; height: number; label: string;
  selectionLabel?: string; takenBy?: string; privacyMode: boolean; disabled: boolean; onSelect: () => void;
}) {
  const masked=useAssetMask(assetId,privacyMode);
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
    backgroundImage: masked ? undefined : `url("${thumbnailUrl(assetId)}")`,
    backgroundPositionX: `${position(box[0], width, cropWidth)}%`,
    backgroundPositionY: `${position(box[1], height, cropHeight)}%`,
    backgroundSize: `${(width / cropWidth) * 100}% ${(height / cropHeight) * 100}%`,
  };
  // A person another character is registered on is shown dimmed with that name and cannot be chosen.
  return <button type="button" className={`character-region-frame${takenBy ? " character-region-frame--taken" : ""}${masked ? " character-private" : ""}`} style={style}
    disabled={disabled || Boolean(takenBy)} aria-label={label} aria-pressed={takenBy ? undefined : Boolean(selectionLabel)} aria-description={selectionLabel} onClick={onSelect}>
    {takenBy ? <span className="character-region-frame__selection">{takenBy} 인물</span>
      : selectionLabel && <span className="character-region-frame__selection">{selectionLabel}</span>}
  </button>;
}

/**
 * What the user may place or change. An unresolved reference is one the user must still place;
 * a stored binding is not trusted on its own: when the native side reports it stale, the user
 * re-chooses rather than having the region silently swapped for them.
 */
function splitReferences(inspections: ReferenceInspection[], draftRegions: ReferenceRegions) {
  const unresolved = inspections.filter(region => needsReferenceRegionChoice(region));
  // References the user already decided and that the inspection still honours. Their region
  // can be replaced, but they are never part of the required prompt.
  const adjustable = inspections.filter(region => draftRegions[region.assetId] && !needsReferenceRegionChoice(region));
  // References the worker resolved on its own. Correction stays reachable even when
  // nothing is required, because an inferred crop is not a user decision.
  const resolved = inspections.filter(region => !draftRegions[region.assetId] && usableRegion(region));
  // Anything the user may correct: the unresolved images, their own honoured choices, and
  // the crops the worker inferred. `no_region` is excluded because there is no crop.
  const correctable = [...unresolved, ...adjustable, ...resolved].filter(region => region.boxes.length > 0);
  const choosable = correctable.filter((region, index) => correctable.findIndex(row => row.assetId === region.assetId) === index);
  return { unresolved, choosable };
}

/**
 * Correcting an inferred, chosen, or stale crop is always possible, but never requested.
 * A stale binding must stay recoverable even when the image holds a single person, and a
 * choice the user made stays theirs to change.
 */
function referenceCorrections(inspections: ReferenceInspection[], draftRegions: ReferenceRegions, assetIds: string[]) {
  return splitReferences(inspections, draftRegions).choosable
    .filter(region => region.boxes.length > 1 || Boolean(draftRegions[region.assetId]) || staleReferenceRegion(region))
    .sort((a, b) => assetIds.indexOf(a.assetId) - assetIds.indexOf(b.assetId));
}

export type ReferenceRequest = { kind: "required" | "correction" | "close"; key: number };
export type ReferenceWorkflow = "required" | "correction" | "focus" | null;

/**
 * The status slot at the right of the reference heading. It is always rendered at the compact
 * control height, so nothing below it moves: empty at first, a delayed "checking" note, then
 * the person count to choose, the usable count with the optional crop adjustment, or a retry.
 */
export function ReferenceCheckSlot({ inspection, active, assetIds, draftRegions, busy, expanded = null, onRequest }: {
  inspection: ReferenceRegionInspection; active: boolean; assetIds: string[]; draftRegions: ReferenceRegions; busy: boolean;
  /** The workflow the chooser section is showing; the buttons that open one toggle it closed again. */
  expanded?: ReferenceWorkflow;
  onRequest: (kind: ReferenceRequest["kind"]) => void;
}) {
  const { inspections, error, retry } = inspection;
  const showChecking = useDelayedBusy(active && !error && inspections === null, { delay: 400, minVisible: 600 });
  let state = "idle";
  let content: ReactNode = null;
  if (active && error) {
    state = "error";
    content = <Button size="sm" variant="quiet" disabled={busy || !retry} aria-description={error} onClick={retry}>확인 실패 · 다시 시도</Button>;
  } else if (active && inspections) {
    const needed = personChoiceCount(inspections);
    if (needed > 0) {
      state = "needed";
      content = <Button size="sm" variant="quiet" className="character-reference-slot__needed" disabled={busy} aria-expanded={expanded === "required"} onClick={() => onRequest(expanded === "required" ? "close" : "required")}>
        <UserIcon aria-hidden="true" />인물 선택 <span className="character-reference-slot__count">{needed.toLocaleString()}</span></Button>;
    } else {
      state = "usable";
      content = <>
        <span>사용 <span className="character-reference-slot__count">{usableReferenceCount(inspections).toLocaleString()}</span></span>
        {referenceCorrections(inspections, draftRegions, assetIds).length > 0
          && <Button size="sm" variant="quiet" disabled={busy} aria-expanded={expanded === "correction"} onClick={() => onRequest(expanded === "correction" ? "close" : "correction")}>인물 영역</Button>}
      </>;
    }
  } else if (active && showChecking) {
    state = "checking";
    content = <span>인물 확인 중</span>;
  }
  return <div className="character-reference-slot">{content && <div className="character-reference-slot__content" key={state}>{content}</div>}</div>;
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
export function ReferenceRegionChoices({ assetIds, draftRegions, savedRegions = {}, privacyMode, busy: parentBusy, decisionApi = characterApi, inspection, focusRequest, request, onModeChange, onOpenOriginal, onChange }: {
  assetIds: string[]; draftRegions: ReferenceRegions; savedRegions?: ReferenceRegions;
  privacyMode: boolean; busy: boolean;
  /** The one inspection owner shared with the status slot and the series indicator. */
  inspection: ReferenceRegionInspection;
  decisionApi?: Pick<CharacterApi, "targets" | "decide">;
  /** Opens one reference's crop directly (e.g. from a tapped strip tile); `key` repeats the same request. */
  focusRequest?: { assetId: string; key: number } | null;
  /** Opens the shortfall workflow or the crop list from the status slot; `key` repeats the same request. */
  request?: ReferenceRequest | null;
  /** Reports which workflow is open, so the status slot can show and toggle it. */
  onModeChange?: (mode: ReferenceWorkflow) => void;
  onOpenOriginal?: (assetId: string) => void;
  /** Receives only manual draft overrides; nothing is written to the database. */
  onChange: (regions: ReferenceRegions) => void;
}) {
  // "required" is the shortfall workflow the user explicitly opened; it ends by itself
  // once the threshold is met. "correction" is an optional adjustment that stays open.
  // "focus" checks one reference the user tapped and closes after a choice.
  const [mode, setMode] = useState<ReferenceWorkflow>(null);
  const reportedMode = useRef(onModeChange);
  reportedMode.current = onModeChange;
  useEffect(() => { reportedMode.current?.(mode); }, [mode]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const rejectingRef = useRef(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const busy = parentBusy || rejecting !== null;
  const sectionRef = useRef<HTMLElement>(null);
  const { inspections: current, refresh } = inspection;
  const inspections = current ?? [];
  const changedRegions = draftReferenceRegions(draftRegions, assetIds, savedRegions);
  const regionStatus = (region: ReferenceInspection) => referenceRegionStatus(region, draftRegions, changedRegions);
  const { unresolved, choosable } = splitReferences(inspections, draftRegions);
  const usable = usableReferenceCount(inspections);
  const enough = usable >= AUTOMATIC_CHARACTER_REFERENCE_COUNT;
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

  // A request made before the inspection lands is kept until its reference can be chosen.
  const handledFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest.key || !choosable.some(region => region.assetId === focusRequest.assetId)) return;
    handledFocus.current = focusRequest.key;
    setMode("focus"); setChosen(focusRequest.assetId);
  }, [focusRequest?.key, choosable.length > 0]);

  // The status slot asks for a workflow; it waits for the first inspection result.
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!request || handledRequest.current === request.key || !current) return;
    handledRequest.current = request.key;
    setMode(request.kind === "close" ? null : request.kind);
    setChosen(request.kind === "required" ? unresolved[0]?.assetId ?? null : null);
  }, [request?.key, Boolean(current)]);

  // A tapped or refused reference may sit below the fold: bring its chooser into view.
  useEffect(() => {
    if (mode === "focus" && chosen) sectionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [mode, chosen]);

  // The shortfall workflow ends only when the threshold is genuinely met and no image shared
  // with another character still waits for its person. A pick
  // briefly leaves nothing unresolved until the reinspection lands, so an empty
  // list alone must not close it.
  const sharedPending = inspections.some(sharedNeedsChoice);
  useEffect(() => {
    if (mode === "required" && enough && !sharedPending) setMode(null);
  }, [mode, enough, sharedPending]);

  if (!assetIds.length) return null;

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

  async function rejectHolder(region: ReferenceInspection, holder: NonNullable<ReferenceInspection["takenBoxes"]>[number]) {
    if (busy || rejectingRef.current || holder.source !== "accepted" || !refresh) return;
    rejectingRef.current = true;
    setRejecting(holder.targetId);
    setDecisionError(null);
    try {
      const target = (await decisionApi.targets()).find(target => target.id === holder.targetId);
      if (!target) throw new Error("캐릭터 정보를 찾지 못했습니다. 다시 확인해 주세요.");
      await decisionApi.decide({ targetId: target.id, expectedFingerprint: target.fingerprint, assetIds: [region.assetId],
        decision: "rejected", baselineFingerprint: null, scanId: null });
      await refresh();
    } catch (reason) {
      setDecisionError(commandErrorMessage(reason, "캐릭터에서 빼지 못했습니다."));
    } finally {
      rejectingRef.current = false;
      setRejecting(null);
    }
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
    && takenBoxOwner(open.region, open.region.suggestedIndex) === null ? open.region.suggestedIndex : null;
  const corrections = referenceCorrections(inspections, draftRegions, assetIds);
  const canCorrect = Boolean(current) && corrections.length > 0;
  // The status slot owns the quiet default; this section exists only while a workflow is open.
  const showSection = Boolean(decisionError) || Boolean(open) || (mode === "correction" && corrections.length > 0) || (mode === "required" && canCorrect);
  if (!showSection) return null;
  // Progress counts the references still needing a decision. A correction may target a
  // reference that is not in that list, so it reports its position in the draft instead.
  const position = open ? unresolved.findIndex(region => region.assetId === open.region.assetId) : -1;
  const progress = open
    ? position >= 0 ? { current: position + 1, total: unresolved.length }
      : { current: assetIds.indexOf(open.region.assetId) + 1, total: assetIds.length }
    : null;
  return <section ref={sectionRef} className="character-reference-regions" aria-label="인물 영역 확인">
    {decisionError && <p role="alert">{decisionError}</p>}
    {/* A required workflow that no longer needs anything becomes an optional adjustment. */}
    {mode === "required" && !open && canCorrect && <div className="character-actions">
      <Button size="sm" variant="ghost" disabled={busy} onClick={openCorrection}>인물 영역 조정</Button>
    </div>}
    {/* The correction list belongs to an open correction, so the quiet default shows nothing. */}
    {mode === "correction" && !open && corrections.length > 0 && <div className="character-region-summary" role="region" aria-label="인물 영역 목록">{corrections.map(region => {
      const number = assetIds.indexOf(region.assetId) + 1;
      const status = regionStatus(region);
      const bounds = usableRegion(region) ? regionBox(region, referenceRegionIndex(region)) : null;
      return <div key={region.assetId} role="group" aria-label={`레퍼런스 ${number} · ${status}`}>
        <div className="character-region-summary__preview">
          <svg className={privacyMode ? "character-private" : undefined} viewBox={`0 0 ${region.width} ${region.height}`} role="img" aria-label={`레퍼런스 ${number}${bounds ? " 사용 중인 인물 영역" : " 인물 미지정"}`}>
            <AssetSvgImage href={thumbnailUrl(region.assetId)} width={region.width} height={region.height} />
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
      <div className="character-region-options">{open.region.boxes.map((box, index) => {
        const holder = open.region.takenBoxes?.find(taken => taken.index === index);
        return <div className="character-region-option" key={`${open.region.assetId}-${index}`}>
          <RegionImage assetId={open.region.assetId} box={box} width={open.region.width} height={open.region.height}
            label={holder ? `인물 영역 ${index + 1} · ${holder.character} 인물` : `인물 영역 ${index + 1} 선택`}
            takenBy={holder?.character}
            selectionLabel={usableRegion(open.region) && referenceRegionIndex(open.region) === index ? open.region.state === "selected" ? "직접 지정한 인물" : "자동 선택된 인물" : undefined}
            privacyMode={privacyMode} disabled={busy}
            onSelect={() => pick(index)} />
          {holder?.source === "accepted" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void rejectHolder(open.region, holder)}>
            <BusyLabel busy={rejecting === holder.targetId} idle={`${holder.character} 아님`}>빼는 중</BusyLabel>
          </Button>}
        </div>;
      })}</div>
      <div className="character-actions">
        {open.mode === "required" && unresolved.length > 1 && <Button size="sm" variant="ghost" disabled={busy} onClick={skip}>다음 이미지</Button>}
        {suggested !== null && <Button size="sm" disabled={busy} onClick={() => pick(suggested)}>추천 영역 사용</Button>}
        {/* An optional adjustment stays reachable while the shortfall workflow is running. */}
        {open.mode === "required" && canCorrect && <Button size="sm" variant="ghost" disabled={busy} onClick={openCorrection}>인물 영역 조정</Button>}
        {open.mode === "focus" && onOpenOriginal && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onOpenOriginal(open.region.assetId)}>원본 보기</Button>}
        {/* The status slot toggles the shortfall workflow and the crop list; only a tapped tile has no other way out. */}
        {open.mode === "focus" && <Button size="sm" variant="ghost" disabled={busy} onClick={close}>닫기</Button>}
      </div>
    </>}
  </section>;
}
