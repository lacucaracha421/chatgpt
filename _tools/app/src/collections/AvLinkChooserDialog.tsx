import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowTopRightOnSquareIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import type { CollectionSummary } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { displayTime } from "../shared/displayDate";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Skeleton } from "../shared/ui/Skeleton";
import { TextInput } from "../shared/ui/TextInput";
import { useMotionSurface } from "../shared/ui/useMotionSurface";
import { avGateway } from "./avClient";
import { displayAvGenres, hiddenAvGenreCount } from "./avGenreNames";
import { performerName } from "./av/performerName";
import type { AvGateway, AvPerson } from "./avTypes";
import { avLinkClient, type AvLinkApplyRequest, type AvLinkCandidate, type AvLinkFields, type AvLinkPersonChoice, type AvLinkPersonMatch, type AvLinkSurfaceChoice } from "./avLinkClient";
import { AvCoverStage, AvSurfaceOptionFace, Crop, type SurfaceControl } from "./avReview/AvCoverStage";
import { AvDestination, AvPickList, NEW_DESTINATION, type DestinationRow } from "./avReview/AvDestination";
import { AvInfoSection, INFO_KEYS, type AvInfoModel, type InfoKey } from "./avReview/AvInfoSection";
import { coversChanged, initialSplit, resolveChoices, surfaceBounds, type Split, type Surface } from "./avReview/avReviewModel";
import "./avReview/avReview.css";

type PersonDraft = { action: "skip" | "link" | "new"; personId?: string; displayName: string; nameSource?: AvPerson };
type AvLinkApi = Omit<typeof avLinkClient, "jacketPreview"> & Partial<Pick<typeof avLinkClient, "jacketPreview">>;
type PeopleApi = Pick<AvGateway, "searchPeople" | "getPerformer" | "getDetails">;
const SURFACE_KEYS: readonly Surface[] = ["front", "spine", "back"];
type FieldChecks = Record<InfoKey, boolean>;

export function AvLinkChooserDialog({ inboxId, collections, api = avLinkClient, peopleApi = avGateway, onClose, onApplied, onDismissed }: {
  inboxId: string;
  collections: CollectionSummary[];
  api?: AvLinkApi;
  peopleApi?: PeopleApi;
  onClose(): void;
  onApplied(collectionId: string): void | Promise<void>;
  onDismissed(): void | Promise<void>;
}) {
  const { privacyMode } = usePrivacy();
  const [candidate, setCandidate] = useState<AvLinkCandidate | null>(null);
  /** A collection id, `new`, or null while several collections match and none was chosen. */
  const [destination, setDestination] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherQuery, setOtherQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [split, setSplit] = useState<Split>({ x1: 1, x2: 2 });
  const [surfaces, setSurfaces] = useState<Record<Surface, AvLinkSurfaceChoice>>({ front: "candidate", spine: "candidate", back: "candidate" });
  const [fieldChecks, setFieldChecks] = useState<FieldChecks>({ title_ja: false, release_date: false, maker: false, label: false, series: false });
  const [genres, setGenres] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [performers, setPerformers] = useState<Record<string, PersonDraft>>({});
  const [details, setDetails] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [jacketsOpen, setJacketsOpen] = useState(false);
  const [jacketImages, setJacketImages] = useState<Record<string, string>>({});
  const [pendingJacket, setPendingJacket] = useState<AvLinkCandidate | null>(null);
  const [switchingJacket, setSwitchingJacket] = useState(false);
  const [jacketError, setJacketError] = useState<string | null>(null);
  const alternativesRef = useMotionSurface("menu");
  const jacketPreview = api.jacketPreview ?? avLinkClient.jacketPreview;
  const live = useRef({ candidate, split, surfaces, fieldChecks, newName });
  live.current = { candidate, split, surfaces, fieldChecks, newName };

  const resetChoices = useCallback((next: AvLinkCandidate, current: AvLinkCandidate["current"], keep?: typeof live.current) => {
    const isNew = !current;
    const sameJacket = keep?.candidate && keep.candidate.jacketWidth === next.jacketWidth && keep.candidate.jacketHeight === next.jacketHeight;
    setSplit(sameJacket && keep ? keep.split : initialSplit(next.defaultSplit, next.jacketWidth));
    setNewName(isNew ? keep?.newName || next.inbox.normalizedCode || next.inbox.productCode : "");
    const fresh = Object.fromEntries(SURFACE_KEYS.map(key => {
      const currentId = current?.covers[`${key}Id`];
      if (!next.defaultSplit.isWrap && key !== "front") return [key, currentId ? "keep" : "clear"];
      if (key === "spine" && !next.defaultSplit.useSpine) return [key, currentId ? "keep" : "clear"];
      return [key, isNew || !currentId ? "candidate" : "keep"];
    })) as Record<Surface, AvLinkSurfaceChoice>;
    // A reload keeps what the user chose where the destination's image did not change.
    for (const key of SURFACE_KEYS) {
      const before = keep?.candidate?.current?.covers[`${key}Id`] ?? null;
      if (keep && sameJacket && before === (current?.covers[`${key}Id`] ?? null) && (keep.surfaces[key] !== "keep" || before)) fresh[key] = keep.surfaces[key];
    }
    setSurfaces(fresh);
    const checks = Object.fromEntries(INFO_KEYS.map(key => {
      const value = hasValue(next.fields[key]) && (isNew || !hasValue(current?.fields[key]));
      const unchanged = keep?.candidate && keep.candidate.fields[key] === next.fields[key] && (keep.candidate.current?.fields[key] ?? null) === (current?.fields[key] ?? null);
      return [key, unchanged && keep ? keep.fieldChecks[key] : value];
    })) as FieldChecks;
    setFieldChecks(checks);
    const visible = displayAvGenres(next.fields.genres).map(genre => genre.original);
    setGenres(new Set(isNew || !current?.fields.genres?.length ? visible : []));
    const people = isNew ? next.performers.map(person => ({ ...person, alreadyLinked: false })) : next.performers;
    setPerformers(personDrafts(people));
    setSelected(Object.fromEntries(people.map(person => [person.name_ja, !person.alreadyLinked])));
  }, []);

  const load = useCallback(async (target?: string, keep?: typeof live.current) => {
    setReloading(true); setLoadError(null);
    try {
      const raw = await api.getCandidate(inboxId, target && target !== NEW_DESTINATION ? target : undefined);
      const eligibleMatches = async (people: AvLinkPersonMatch[]) => Promise.all(people.map(async person => {
        if (!person.personId) return person;
        const page = await peopleApi.getPerformer(person.personId).catch(reason => { if (person.alreadyLinked) return null; throw reason; });
        if (!page) return person;
        const enriched = { ...person, ...page.person };
        return person.alreadyLinked || await hasPerformerCredit(peopleApi, person.personId, page) ? enriched : { ...person, personId: null, displayName: null, matchBy: null };
      }));
      const performers = await eligibleMatches(raw.performers);
      const current = raw.current ? { ...raw.current, people: await Promise.all(raw.current.people.map(async person => ({ ...person, ...(await peopleApi.getPerformer(person.id).catch(() => null))?.person }))) } : null;
      let next = { ...raw, current, performers };
      const previousKey = keep?.candidate?.jacketKey;
      const previousJacket = next.jackets?.find(j => j.key === previousKey);
      if (previousJacket && keep?.candidate) next = {...next, jacketKey: previousKey, jacketUrl: keep.candidate.jacketUrl,
        jacketWidth: previousJacket.width, jacketHeight: previousJacket.height, defaultSplit: previousJacket.defaultSplit,
        spineSource: keep.candidate.spineSource};
      const chosen = target === NEW_DESTINATION ? NEW_DESTINATION : next.current?.collectionId ?? ((next.matches?.length ?? 0) > 1 ? null : NEW_DESTINATION);
      setCandidate(next);
      setDestination(chosen);
      setOtherOpen(false);
      resetChoices(next, chosen === NEW_DESTINATION ? null : next.current, keep);
    } catch (reason) {
      setLoadError(errorMessage(reason, "후보를 불러오지 못했습니다."));
    } finally { setReloading(false); }
  }, [api, inboxId, peopleApi, resetChoices]);
  useEffect(() => { void load(); }, [load]);

  const isNew = destination === NEW_DESTINATION;
  const current = candidate && !isNew && destination !== null ? candidate.current : null;
  const needsPick = destination === null;
  const code = candidate ? candidate.inbox.normalizedCode || candidate.inbox.productCode : "";
  const mismatch = Boolean(current?.productCode?.trim()) && candidate !== null && canonicalCode(current!.productCode!) !== canonicalCode(code);

  function chooseDestination(id: string) {
    if (!candidate || reloading || busy) return;
    setStale(false); setApplyError(null);
    if (id === NEW_DESTINATION) {
      setDestination(NEW_DESTINATION);
      resetChoices(candidate, null, live.current);
      return;
    }
    if (id === destination) return;
    void load(id, live.current);
  }

  async function apply() {
    if (!candidate || needsPick) return;
    setBusy(true); setApplyError(null);
    const fields: AvLinkFields = {};
    for (const key of INFO_KEYS) if (fieldChecks[key]) fields[key] = candidate.fields[key] ?? null;
    const chosenGenres = [...genres];
    // Existing genres (hidden sale tags included) stay; the chosen ones are added.
    if (chosenGenres.length) fields.genres = isNew ? chosenGenres : [...(current?.fields.genres ?? []), ...chosenGenres.filter(genre => !current?.fields.genres?.includes(genre))];
    const people = isNew ? candidate.performers.map(person => ({ ...person, alreadyLinked: false })) : candidate.performers;
    const requestBase = {
      ...(candidate.jacketKey ? {jacketKey: candidate.jacketKey} : {}), split, surfaces: resolved, fields,
      performers: peopleRequest(people.filter(person => selected[person.name_ja]), performers),
      directors: [],
    };
    const request: AvLinkApplyRequest = current
      ? { ...requestBase, collectionId: current.collectionId, expectedRevision: current.covers.revision }
      : { ...requestBase, newCollectionName: newName.trim() || candidate.inbox.normalizedCode || candidate.inbox.productCode };
    try {
      const result = await api.apply(inboxId, request);
      await onApplied(result.collectionId);
    } catch (reason) {
      if (isStale(reason)) {
        await load(destination ?? undefined, live.current);
        setStale(true);
      } else setApplyError(errorMessage(reason, "후보를 적용하지 못했습니다."));
    } finally { setBusy(false); }
  }
  async function dismiss() {
    setRejecting(false);
    setBusy(true); setApplyError(null);
    try { await api.dismiss(inboxId); await onDismissed(); }
    catch (reason) { setApplyError(errorMessage(reason, "후보를 거절하지 못했습니다.")); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!jacketsOpen || privacyMode || !candidate?.jackets?.length) return;
    let live = true;
    void (async () => {
      for (const jacket of candidate.jackets!) {
        if (!live) return;
        const url = await jacketPreview(inboxId, jacket.key);
        if (live) setJacketImages(images => ({...images, [jacket.key]: url}));
      }
    })().catch(reason => {if (live) setJacketError(errorMessage(reason, "표지를 불러오지 못했습니다."));});
    return () => {live = false;};
  }, [jacketsOpen, privacyMode, candidate?.jackets, inboxId, jacketPreview]);

  async function chooseJacket(key: string) {
    const jacket = candidate?.jackets?.find(j => j.key === key);
    if (!candidate || !jacket || locked || key === (candidate.jacketKey ?? candidate.jackets?.find(j => j.chosen)?.key)) return;
    setSwitchingJacket(true); setJacketError(null);
    try {
      const url = jacketImages[key] ?? await jacketPreview(inboxId, key);
      const spineSource = jacket.spineSource ? {...jacket.spineSource, url: await jacketPreview(inboxId, key, true)} : null;
      const next = {...candidate, jacketKey: key, jacketUrl: url, jacketWidth: jacket.width, jacketHeight: jacket.height,
        defaultSplit: jacket.defaultSplit, spineSource};
      if (privacyMode) finishJacket(next); else setPendingJacket(next);
    } catch (reason) {setSwitchingJacket(false); setJacketError(errorMessage(reason, "표지를 불러오지 못했습니다."));}
  }
  useEffect(() => {if (privacyMode && pendingJacket) finishJacket(pendingJacket);}, [privacyMode, pendingJacket]);

  function finishJacket(next: AvLinkCandidate) {
    setCandidate(next); setSplit(initialSplit(next.defaultSplit, next.jacketWidth));
    setPendingJacket(null); setSwitchingJacket(false);
  }
  async function retry() {
    if (locked) return;
    setBusy(true); setJacketError(null);
    try {await api.retry(inboxId); await onDismissed();}
    catch (reason) {setJacketError(errorMessage(reason, "다시 찾지 못했습니다."));}
    finally {setBusy(false);}
  }
  const locked = busy || reloading || switchingJacket;
  const hasCurrent: Record<Surface, boolean> = { front: Boolean(current?.covers.frontId), spine: Boolean(current?.covers.spineId), back: Boolean(current?.covers.backId) };
  const currentImages = Object.fromEntries(SURFACE_KEYS.map(key => {
    const id = current?.covers[`${key}Id`];
    return [key, id ? workArtworkThumbnailUrl(id) : null];
  })) as Record<Surface, string | null>;
  const resolved = candidate ? resolveChoices(surfaces, candidate.defaultSplit, split, candidate.jacketWidth, hasCurrent) : surfaces;
  const coverCount = coversChanged(resolved, hasCurrent);

  const people = useMemo(() => candidate ? (isNew ? candidate.performers.map(person => ({ ...person, alreadyLinked: false })) : candidate.performers) : [], [candidate, isNew]);
  const infoModel: AvInfoModel | null = candidate && !needsPick ? {
    isNew: !current,
    fields: INFO_KEYS.map(key => ({ key, candidate: candidate.fields[key] ?? null, current: current?.fields[key] ?? null, checked: fieldChecks[key] })),
    people: people.map(person => {
      const names = personNames(person);
      const draft = performers[person.name_ja] ?? defaultPersonDraft(person);
      return { id: person.name_ja, nameJa: person.name_ja, primary: names.primary, secondary: names.secondary, linked: person.alreadyLinked, newPerson: draft.action === "new", selected: Boolean(selected[person.name_ja]) };
    }),
    genres: displayAvGenres(candidate.fields.genres).map(genre => ({ original: genre.original, name: genre.name, selected: genres.has(genre.original) })),
    currentGenres: displayAvGenres(current?.fields.genres).map(genre => genre.name),
    hiddenGenres: hiddenAvGenreCount(candidate.fields.genres),
  } : null;
  const infoCount = infoModel ? infoModel.fields.filter(field => field.checked).length + infoModel.people.filter(person => !person.linked && person.selected).length + (genres.size ? 1 : 0) : 0;
  const summary = needsPick ? "넣을 곳을 고르세요" : `표지 ${coverCount}면 · 정보 ${infoCount}개`;
  const primaryDisabled = busy || reloading || switchingJacket || !candidate || needsPick || (isNew && !newName.trim()) || mismatch;

  const rows: DestinationRow[] = candidate ? destinationRows(candidate, collections, destination, mismatch) : [];
  const otherMatches = useMemo(() => {
    const needle = otherQuery.trim().toLowerCase();
    return collections.filter(collection => !needle || collection.name.toLowerCase().includes(needle)).slice(0, 50)
      .map(collection => ({ id: collection.id, primary: collection.name, secondary: null, thumbUrl: collection.selectedWorkArtworkId ? workArtworkThumbnailUrl(collection.selectedWorkArtworkId) : null }));
  }, [collections, otherQuery]);

  const front = candidate ? surfaceBounds("front", split, candidate.jacketWidth, candidate.defaultSplit.isWrap) : null;
  return <Dialog open title={`AV 후보 ${code}`.trim()} variant="workspace" onClose={() => { if (!busy) onClose(); }}>
    <div className="av-review">
      <header className="av-review__head">
        {candidate && <>
          <span className="av-review__code">{code}</span>
          <span className="av-review__source">LibreDMM · <span className="numeric">{clockTime(candidate.inbox.fetchedAt || candidate.inbox.receivedAt)}</span></span>
          {candidate.inbox.sourceUrl && <Button size="icon" variant="quiet" aria-label="LibreDMM 원본 페이지 열기" onClick={() => void openUrl(candidate.inbox.sourceUrl!)}><ArrowTopRightOnSquareIcon aria-hidden="true" /></Button>}
        </>}
      </header>
      {candidate ? <div className="av-review__body" inert={reloading || undefined}>
        <div className="av-review__stage">
          <div style={{position: "relative", width: "100%"}}>
            {[candidate, ...(pendingJacket ? [pendingJacket] : [])].map(image => {
              const pending = image === pendingJacket;
              const imageSplit = pending ? initialSplit(image.defaultSplit, image.jacketWidth) : split;
              return <div key={image.jacketKey ?? image.jackets?.find(j => j.chosen)?.key ?? "default"}
                style={pending ? {position: "absolute", inset: 0, visibility: "hidden", pointerEvents: "none"} : undefined}
                inert={pending || switchingJacket || undefined} aria-hidden={pending || undefined}
                onLoadCapture={event => {if (pending && event.target instanceof HTMLImageElement && event.target.alt === `${code} 펼친 재킷`) {
                  const element = event.target;
                  void (element.decode?.() ?? Promise.resolve()).then(() => finishJacket(image), () => finishJacket(image));
                }}}
                onErrorCapture={() => {if (pending) {setPendingJacket(null); setSwitchingJacket(false); setJacketError("표지를 불러오지 못했습니다.");}}}>
                <AvCoverStage code={code} jacketUrl={image.jacketUrl} jacketWidth={image.jacketWidth} jacketHeight={image.jacketHeight}
                  privacy={privacyMode} isWrap={image.defaultSplit.isWrap} auto={image.defaultSplit} split={imageSplit} onSplit={setSplit}
                  choices={resolveChoices(surfaces, image.defaultSplit, imageSplit, image.jacketWidth, hasCurrent)}
                  currentImages={currentImages} hasCurrent={hasCurrent} spineSource={image.spineSource} disabled={locked || pending}
                  control={props => <SurfaceMenu {...props} disabled={locked || pending} onChoose={(surface, value) => setSurfaces(choices => ({...choices, [surface]: value}))} />} />
              </div>;
            })}
            {(candidate.jackets?.length ?? 0) >= 2 && <div>
              <Button size="sm" variant="quiet" aria-expanded={jacketsOpen} disabled={locked} onClick={() => setJacketsOpen(value => !value)}>다른 표지<ChevronDownIcon aria-hidden="true" /></Button>
              {jacketsOpen && <div ref={alternativesRef} className="av-other" role="group" aria-label="다른 표지" style={{display: "flex", gap: "var(--space-2)", flexWrap: "wrap"}}>
                {candidate.jackets!.map((jacket, index) => <button key={jacket.key} type="button"
                  className={`av-cap-menu__item${(candidate.jacketKey === jacket.key || !candidate.jacketKey && jacket.chosen) ? " is-current" : ""}`}
                  style={{width: "auto"}} aria-label={`표지 ${index + 1}`} aria-pressed={candidate.jacketKey === jacket.key || !candidate.jacketKey && jacket.chosen}
                  disabled={locked} onClick={() => void chooseJacket(jacket.key)}>
                  <span className="av-menu-thumb av-menu-thumb--image">{!privacyMode && jacketImages[jacket.key] && <img src={jacketImages[jacket.key]} alt="" />}</span>
                </button>)}
              </div>}
            </div>}
          </div>
        </div>
        <div className="av-review__side">
          <AvDestination
            rows={rows} value={destination} onChange={chooseDestination} newName={newName} onNewName={setNewName} privacy={privacyMode} disabled={locked}
            otherOpen={otherOpen} onOther={() => setOtherOpen(value => !value)}
            otherPanel={<OtherPanel open={otherOpen} onClose={() => setOtherOpen(false)}>
              <AvPickList label="다른 컬렉션" query={otherQuery} onQuery={setOtherQuery} items={otherMatches} privacy={privacyMode} onPick={id => { setOtherOpen(false); chooseDestination(id); }} />
            </OtherPanel>}
          />
          {infoModel && <AvInfoSection
            model={infoModel} open={details} onToggle={() => setDetails(value => !value)} disabled={locked}
            onField={(key, checked) => setFieldChecks(checks => ({ ...checks, [key]: checked }))}
            onPerson={(id, value) => setSelected(state => ({ ...state, [id]: value }))}
            onGenre={original => setGenres(state => { const next = new Set(state); if (next.has(original)) next.delete(original); else next.add(original); return next; })}
            personControls={person => {
              const source = people.find(item => item.name_ja === person.id)!;
              const draft = performers[person.id] ?? defaultPersonDraft(source);
              return {
                name: draft.action === "new"
                  ? <TextInput aria-label={`${person.nameJa} 한국어 이름`} maxLength={120} value={draft.displayName} disabled={locked} onChange={event => setPerformers(state => ({ ...state, [person.id]: { ...draft, displayName: event.target.value } }))} />
                  : <span>{draft.nameSource ? performerName(draft.nameSource).primary : person.primary}</span>,
                link: <PersonLink person={source} draft={draft} peopleApi={peopleApi} disabled={locked} onChange={value => setPerformers(state => ({ ...state, [person.id]: value }))} />,
              };
            }}
          />}
        </div>
      </div> : <div className="av-review__body">
        {loadError
          ? <div className="av-review__stage"><div className="av-review__error"><span>{loadError}</span><Button size="sm" onClick={() => void load()}>다시 시도</Button></div></div>
          : <><div className="av-review__stage"><Skeleton className="av-review__skeleton-stage" label="후보를 불러오는 중" /></div>
            <div className="av-review__side"><Skeleton className="av-review__skeleton-line" label={null} /><Skeleton className="av-review__skeleton-line" label={null} /><Skeleton className="av-review__skeleton-line" label={null} /></div></>}
      </div>}
      {candidate && loadError && <p className="av-review__error" role="alert"><span>{loadError}</span><Button size="sm" onClick={() => void load(destination ?? undefined, live.current)}>다시 시도</Button></p>}
      {jacketError && <p className="av-review__error" role="alert">{jacketError}</p>}
      {applyError && <p className="av-review__error" role="alert"><span>{applyError}</span>{!busy && candidate && <Button size="sm" onClick={() => void apply()}>다시 시도</Button>}</p>}
      <footer className="av-review__foot">
        <Button variant="danger" disabled={busy || !candidate} onClick={() => setRejecting(true)}>거절</Button>
        <Button variant="quiet" disabled={locked || candidate?.inbox.status !== "found" || !!candidate?.inbox.applyState} onClick={() => void retry()}>다시 찾기</Button>
        <span className="av-review__spacer" />
        {stale && <span className="av-review__summary" role="status">다른 곳에서 바뀌어 다시 읽었어요</span>}
        {candidate && <span className="av-review__summary">{summary}</span>}
        <Button disabled={busy} onClick={onClose}>나중에</Button>
        <Button variant="primary" disabled={primaryDisabled} onClick={() => void apply()}><BusyLabel busy={busy} idle={isNew ? "만들기" : "적용"} delay={400}>{isNew ? "만드는 중" : "적용하는 중"}</BusyLabel></Button>
      </footer>
    </div>
    {rejecting && candidate && <Dialog open title="후보를 거절할까요?" onClose={() => setRejecting(false)}
      heading={<span className="av-reject__title"><span className="av-reject__thumb" aria-hidden="true">{!privacyMode && front && <Crop src={candidate.jacketUrl} sourceWidth={candidate.jacketWidth} x={front.x} width={front.width} height={candidate.jacketHeight} />}</span>후보를 거절할까요?</span>}>
      <p className="av-reject__note">가져온 후보만 지워져요. 같은 품번을 다시 보내면 다시 찾아요.</p>
      <div className="ui-dialog__actions"><Button variant="ghost" onClick={() => setRejecting(false)}>취소</Button><Button variant="danger" onClick={() => void dismiss()}>거절</Button></div>
    </Dialog>}
  </Dialog>;
}

/** A panel opened in place; Esc closes it before the dialog. */
function OtherPanel({ open, onClose, children }: { open: boolean; onClose(): void; children: ReactNode }) {
  useBackHandler(() => { onClose(); }, 110, open);
  return <div className="av-other" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>{children}</div>;
}

function SurfaceMenu({ surface, value, face, ariaLabel, options, disabled, onChoose }: SurfaceControl & { disabled: boolean; onChoose(surface: Surface, value: AvLinkSurfaceChoice): void }) {
  const surfaceRef = useMotionSurface("menu");
  return <DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger asChild><button type="button" className="av-cap" aria-label={ariaLabel} disabled={disabled}>{face}</button></DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content ref={surfaceRef} className={`ui-menu av-cap-menu${surface === "spine" ? " av-cap-menu--spine" : ""}`} aria-label={ariaLabel.split(":")[0]} align="center" sideOffset={4} collisionPadding={12}>
        <DropdownMenu.RadioGroup value={value} onValueChange={next => onChoose(surface, next as AvLinkSurfaceChoice)}>
          {options.map(option => <DropdownMenu.RadioItem key={option.value} value={option.value} className="av-cap-menu__item"><AvSurfaceOptionFace option={option} /></DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

/** The one quiet link button of a person who is not yet credited: new person, or an existing one. */
function PersonLink({ person, draft, peopleApi, disabled, onChange }: {
  person: AvLinkPersonMatch; draft: PersonDraft; peopleApi: PeopleApi; disabled: boolean; onChange(value: PersonDraft): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AvPerson[]>([]);
  useBackHandler(() => { setOpen(false); }, 110, open);
  useEffect(() => {
    if (!open || !query.trim()) { setResults([]); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      void peopleApi.searchPeople(query.trim()).then(async value => {
        const eligible = await Promise.all(value.map(async found => await hasPerformerCredit(peopleApi, found.id) ? found : null));
        if (live) setResults(eligible.filter((found): found is AvPerson => found !== null));
      }).catch(() => { if (live) setResults([]); });
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [peopleApi, query, open]);
  const name = personNames(person).primary;
  return <>
    <Button size="sm" variant="quiet" aria-expanded={open} aria-label={`${name} 연결`} disabled={disabled} onClick={() => { setOpen(value => !value); setQuery(person.name_ko || person.name_ja); }}>
      {draft.action === "link" ? "기존 인물" : "새 인물"}<ChevronDownIcon aria-hidden="true" />
    </Button>
    {open && <div className="av-person__panel" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
      <AvPickList label={`${name} 기존 인물`} query={query} onQuery={setQuery}
        items={results.map(result => ({ id: result.id, primary: performerName(result).primary, secondary: performerName(result).secondary }))}
        onPick={id => {
          const found = results.find(result => result.id === id);
          if (found) onChange({ action: "link", personId: found.id, displayName: found.displayName, nameSource: found });
          setOpen(false);
        }}
        footer={<Button size="sm" variant="quiet" onClick={() => { onChange({ action: "new", displayName: person.name_ko || person.name_ja }); setOpen(false); }}>새 인물로</Button>} />
    </div>}
  </>;
}

function destinationRows(candidate: AvLinkCandidate, collections: CollectionSummary[], destination: string | null, mismatch: boolean): DestinationRow[] {
  const known = new Map<string, string>();
  for (const match of candidate.matches ?? []) known.set(match.collectionId, match.name);
  if (candidate.current) known.set(candidate.current.collectionId, candidate.current.name);
  return [...known].map(([id, name]) => {
    const summary = collections.find(collection => collection.id === id);
    const isCurrent = candidate.current?.collectionId === id;
    const covers = isCurrent ? [candidate.current!.covers.frontId, candidate.current!.covers.spineId, candidate.current!.covers.backId].filter(Boolean).length : null;
    const year = (isCurrent ? candidate.current!.fields.release_date : summary?.releaseDate)?.slice(0, 4) || (summary?.year != null ? String(summary.year) : "");
    const artwork = isCurrent ? candidate.current!.covers.frontId ?? summary?.selectedWorkArtworkId : summary?.selectedWorkArtworkId;
    return {
      id, name: name || summary?.name || "이름 없는 AV 컬렉션",
      meta: [year, covers != null ? `표지 ${covers}면` : ""].filter(Boolean).join(" · ") || null,
      thumbUrl: artwork ? workArtworkThumbnailUrl(artwork) : null,
      warning: mismatch && destination === id ? "품번이 다른 컬렉션" : null,
    };
  });
}

function canonicalCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^([A-Z]+)0+(?=\d)/, "$1");
}

function personDrafts(people: AvLinkPersonMatch[]) {
  return Object.fromEntries(people.map(person => [person.name_ja, defaultPersonDraft(person)]));
}

function defaultPersonDraft(person: AvLinkPersonMatch): PersonDraft {
  if (person.alreadyLinked) return { action: "skip", personId: person.personId ?? undefined, displayName: person.displayName || person.name_ko || person.name_ja };
  if (person.personId) return { action: "link", personId: person.personId, displayName: person.displayName || person.name_ko || person.name_ja };
  return { action: "new", displayName: person.name_ko || person.name_ja };
}

function peopleRequest(people: AvLinkPersonMatch[], drafts: Record<string, PersonDraft>): AvLinkPersonChoice[] {
  return people.flatMap<AvLinkPersonChoice>(person => {
    const draft = drafts[person.name_ja] ?? defaultPersonDraft(person);
    if (person.alreadyLinked || draft.action === "skip") return [];
    if (draft.action === "link" && draft.personId) return [{ name_ja: person.name_ja, action: "link" as const, personId: draft.personId }];
    const displayName = draft.displayName.trim();
    return displayName ? [{ name_ja: person.name_ja, action: "new" as const, displayName }] : [];
  });
}

function personNames(person: AvLinkPersonMatch) {
  return performerName({ ...person, displayName: person.displayName || person.name_ko || person.name_ja, nameJa: person.nameJa || person.name_ja });
}

function hasValue(value: unknown) {
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
}

function isStale(reason: unknown) {
  return typeof reason === "object" && reason !== null && "code" in reason && reason.code === "av_stale";
}

function clockTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return displayTime(date);
}

function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error) return reason.message.trim() || fallback;
  if (typeof reason === "object" && reason && "message" in reason && typeof reason.message === "string") return reason.message.trim() || fallback;
  return typeof reason === "string" && reason.trim() ? reason.trim() : fallback;
}

async function hasPerformerCredit(api: Pick<AvGateway, "getPerformer">, personId: string, known?: Awaited<ReturnType<AvGateway["getPerformer"]>>) {
  const page = known ?? await api.getPerformer(personId);
  return page.works.some(work => work.role === "performer");
}

