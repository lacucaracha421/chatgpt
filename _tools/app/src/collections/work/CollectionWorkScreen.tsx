import { ArrowPathIcon, BookOpenIcon, ChevronLeftIcon, ChevronRightIcon, EllipsisHorizontalIcon, InformationCircleIcon, PencilIcon, Square2StackIcon, StarIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { CollectionSummary, WorkArtworkSummary, CollectionWorkRecord, CollectionRecordEdit, TmdbConnection } from "../../library/types";
import type { AvCoverSet, AvDetails, AvRelated } from "../avTypes";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { displayDate } from "../../shared/displayDate";
import { Button } from "../../shared/ui/Button";
import { Menu, type MenuItem } from "../../shared/ui/Menu";
import { StableImage } from "../../shared/ui/StableImage";
import { CaseInside, CollectionCase, type CaseData } from "../case/CollectionCase";
import { WorkInfo, insideFacts, insideRecord } from "./WorkInfo";
import { MangaStage, MangaBookcase, editionName, type MangaWorkData } from "./MangaBookcase";
import { defaultRecord } from "./WorkRecord";
import { volumeLabel } from "../collectionFormat";
import { fitFlatJacket, type StageBox } from "../case/fitCaseStage";
import "./collectionWork.css";

export type CollectionWorkData = { collection: CollectionSummary; record?: CollectionWorkRecord; tmdb?: TmdbConnection | null; providerBusy?: boolean; manga?: MangaWorkData; av: AvDetails | null; covers: AvCoverSet | null; related: AvRelated | null; case: CaseData; artworks: WorkArtworkSummary[]; position: number; total: number; providerConnected: boolean };
export type WorkActions = {
  onClose(): void; onStep(offset: -1 | 1): void; onEdit(collection: CollectionSummary): void; onShowcase(collection: CollectionSummary): void;
  onManage(data: CollectionWorkData): MenuItem[]; onSave(collection: CollectionSummary, edit: CollectionRecordEdit): Promise<CollectionWorkRecord>; onPickVolume?(id: string): void; onEnlargeManga?(): void;
  onOpenPerson(id: string): void; onOpenCollection?(id: string): void; onCopyCode(code: string | null): void;
};
function samePresentation(left: CollectionWorkData, right: CollectionWorkData) {
  return left.collection.id === right.collection.id && heroArtwork(left.collection) === heroArtwork(right.collection) && left.manga?.activeVolumeId === right.manga?.activeVolumeId && (["front", "spine", "back", "platform", "privacy"] as const).every(key => left.case[key] === right.case[key]);
}
function heroArtwork(collection: CollectionSummary) {
  return collection.selectedHeroArtworkId || (collection.type === "movie" ? collection.selectedBackdropArtworkId : null);
}
export function CollectionWorkScreen({ data, pending, actions }: { data: CollectionWorkData; pending: boolean; actions: WorkActions }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => { root.current?.focus(); }, []);
  const [slots, setSlots] = useState<[CollectionWorkData | null, CollectionWorkData | null]>([data, null]);
  const [active, setActive] = useState<0 | 1>(0);
  const [info, setInfo] = useState(true);
  const [reset, setReset] = useState(0);
  const requested = useRef(data); requested.current = data;
  const metadataOnly = samePresentation(slots[active]!, data);
  const visible = metadataOnly ? data : slots[active]!;
  useEffect(() => {
    if (slots[active] === data) return;
    // Metadata-only edits preserve the painted case and the record draft.
    if (metadataOnly) {
      setSlots(previous => active === 0 ? [data, previous[1]] : [previous[0], data]); return;
    }
    const other = active === 0 ? 1 : 0;
    if (slots[other] === data) return;
    setSlots(previous => other === 0 ? [data, previous[1]] : [previous[0], data]);
  }, [data, slots, active, metadataOnly]);
  const waiting = pending || visible !== data;
  const activeVolume = visible.manga?.volumes.find(volume => volume.id === visible.manga?.activeVolumeId);
  const title = visible.manga ? `${visible.collection.name}${activeVolume ? ` ${volumeLabel(activeVolume)}` : ""}` : visible.case.title;
  const privacy = data.case.privacy;
  return <article ref={root} tabIndex={-1} className={`collection-work asset-viewer${info ? " asset-viewer--docked" : ""}`} aria-label={visible.manga ? "만화 작품 화면" : visible.collection.type === "av" ? "AV 작품 화면" : visible.collection.type === "movie" ? "영화 작품 화면" : "게임 작품 화면"} aria-busy={waiting}
    onKeyDown={event => {
      if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable],.ui-menu,.work-stars,.work-record-menu"))) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); if (!waiting) actions.onStep(event.key === "ArrowLeft" ? -1 : 1); }
    }}>
    <header className="asset-viewer__topbar">
      <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label={visible.manga ? "컬렉션으로 돌아가기" : "목록으로"} onClick={actions.onClose}><ChevronLeftIcon /></Button>
      <span className="asset-viewer__position"><b>{visible.position}</b> / {visible.total}</span>
      <span className="asset-viewer__title"><strong role="heading" aria-level={1}>{title}</strong><small>{visible.manga ? editionName(visible.manga.editionIndex) : [visible.collection.type === "movie" ? visible.collection.director : visible.av?.productCode ?? visible.collection.platforms, displayDate(visible.av?.releaseDate || visible.collection.releaseDate)].filter(Boolean).join(" · ")}</small></span>
      <span className="asset-viewer__spacer" />
      <Button className="asset-viewer__vbtn asset-viewer__favorite" size="icon" variant="ghost" aria-label="쇼케이스" aria-pressed={visible.collection.showcase} disabled={waiting} onClick={() => actions.onShowcase(visible.collection)}><StarIcon /></Button>
      <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="편집" disabled={waiting} onClick={() => actions.onEdit(visible.collection)}><PencilIcon /></Button>
      <Menu label="작품 관리" disabled={waiting} trigger={<EllipsisHorizontalIcon />} items={actions.onManage(visible)} />
      <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="정면으로" onClick={() => setReset(value => value + 1)}><ArrowPathIcon /></Button>
      <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="정보" aria-pressed={info} onClick={() => setInfo(value => !value)}><InformationCircleIcon /></Button>
      <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="닫기" onClick={actions.onClose}><XMarkIcon /></Button>
    </header>
    {slots.map((slot, index) => slot && <div key={index} className={`work-surface${info ? " work-surface--info" : ""}`} style={index === active ? undefined : { visibility: "hidden", pointerEvents: "none" }} inert={index !== active || waiting} aria-hidden={index !== active}>
      <WorkSurface data={index === active ? visible : slot} privacy={privacy} info={info} reset={reset} actions={actions} onReady={() => { if (index !== active && slot === requested.current) { setActive(index as 0 | 1); root.current?.focus({ preventScroll: true }); } }} />
    </div>)}
  </article>;
}
function WorkSurface({ data, privacy, info, reset, actions, onReady }: { data: CollectionWorkData; privacy: boolean; info: boolean; reset: number; actions: WorkActions; onReady(): void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [stageBox, setStageBox] = useState<StageBox>();
  useLayoutEffect(() => {
    const node = stage.current; if (!node) return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      if (width > 0 && height > 0) setStageBox(previous => previous?.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [info, data.collection.id]);
  const caseData = { ...data.case, privacy };
  const heroId = heroArtwork(data.collection);
  const heroSrc = !privacy && heroId ? workArtworkUrl(heroId) : null;
  const presentation = JSON.stringify([data.collection.id, data.manga?.activeVolumeId, data.case.front, data.case.spine, data.case.back, heroSrc, privacy]);
  const readiness = useRef({ presentation, object: false, hero: !heroSrc });
  if (readiness.current.presentation !== presentation) readiness.current = { presentation, object: false, hero: !heroSrc };
  function ready(part: "object" | "hero") {
    if (readiness.current.presentation !== presentation) return;
    readiness.current[part] = true;
    if (readiness.current.object && readiness.current.hero) onReady();
  }
  const [mode, setMode] = useState("case");
  const [picked, setPicked] = useState("case");
  const flatReady = useRef(false);
  useEffect(() => { setMode("case"); setPicked("case"); flatReady.current = false; }, [data.collection.id]);
  const desired = useRef(picked); desired.current = picked;
  const artwork = data.artworks.find(item => item.id === picked);
  function pick(next: string) {
    setPicked(next);
    if (next === "case" || next === "open" || privacy || (next === "flat" && flatReady.current)) setMode(next);
  }
  const isObject = mode === "case" || mode === "open";
  const record = data.record ?? defaultRecord(data.collection);
  return <>
    {heroSrc && <HeroBand src={heroSrc} manga={Boolean(data.manga)} onReady={() => ready("hero")} />}
    {data.manga ? <><MangaStage manga={data.manga} privacy={privacy} title={data.collection.name} author={data.collection.author} frontReset={reset} onPick={id => actions.onPickVolume?.(id)} onReady={() => ready("object")} /><MangaBookcase manga={data.manga} privacy={privacy} onPick={id => actions.onPickVolume?.(id)} onEnlarge={actions.onEnlargeManga} /></> : <>
    <div ref={stage} className="work-stage">
      <div style={isObject ? undefined : { position: "absolute", inset: 0, visibility: "hidden", pointerEvents: "none" }} className="work-case-slot" inert={!isObject} aria-hidden={!isObject}>
        <CollectionCase data={caseData} large stageBox={stageBox} open={mode === "open"} onOpenChange={open => pick(open ? "open" : "case")} frontReset={reset}
          inside={<CaseInside record={insideRecord(data.collection, record)} facts={insideFacts(data.collection, data.av)} />}
          note={data.av?.people.length ? <><b>출연 · 감독</b><p className="work-names-note">{data.av.people.map(person => person.displayName).join(" · ")}</p></> : undefined} onReady={() => ready("object")} />
      </div>
      {data.collection.type === "av" && <div className="work-flat-slot" style={mode === "flat" ? undefined : { visibility: "hidden", pointerEvents: "none" }} aria-hidden={mode !== "flat"} inert={mode !== "flat"}><FlatJacket data={caseData} stageBox={stageBox} onReady={() => { flatReady.current = true; if (desired.current === "flat") setMode("flat"); }} /></div>}
      {artwork && <div className="work-art" style={mode === "case" || mode === "open" || mode === "flat" ? { visibility: "hidden", pointerEvents: "none" } : undefined} aria-hidden={mode === "case" || mode === "open" || mode === "flat"}>{privacy ? <span className="privacy-mask" aria-label="비공개 모드" /> : <StableImage src={workArtworkUrl(artwork.id)} alt={`${data.case.title} 아트워크`} draggable={false} onLoad={async event => {
        const image = event.currentTarget; try { await image.decode?.(); } catch { /* Settled artwork remains navigable. */ }
        if (desired.current === artwork.id) setMode(artwork.id);
      }} onError={() => { if (desired.current === artwork.id) setMode(artwork.id); }} onPreloadError={() => { pick("case"); }} />}</div>}
      {/* Wide edge targets and the strip belong to the immersive media viewer. */}
      <button className="asset-viewer__edge asset-viewer__edge--left" aria-label="이전 작품" disabled={data.position <= 1} onClick={() => actions.onStep(-1)}><ChevronLeftIcon /></button>
      <button className="asset-viewer__edge asset-viewer__edge--right" aria-label="다음 작품" disabled={data.position >= data.total} onClick={() => actions.onStep(1)}><ChevronRightIcon /></button>
    </div>
    <div className="work-strip" aria-label="작품 보기">
      {([ ["case", "케이스", Square2StackIcon], ["open", "안쪽", BookOpenIcon], ...(data.collection.type === "av" ? [["flat", "펼친 표지", BookOpenIcon]] : []) ] as const).map(([id, label, Icon]) => <button className="work-strip-tile" key={String(id)} aria-pressed={mode === id} onClick={() => pick(String(id))}><span className="work-strip-pic"><Icon /></span>{String(label)}</button>)}
      {data.artworks.length > 0 && <span className="work-strip-separator" />}
      {data.artworks.map((item, index) => <button className="work-strip-tile work-strip-art" key={item.id} aria-label={`아트워크 ${index + 1}`} aria-pressed={mode === item.id} onClick={() => pick(item.id)}><span className="work-strip-pic">{!privacy && <img src={workArtworkThumbnailUrl(item.id)} alt="" draggable={false} />}</span></button>)}
    </div>
    </>}
    <aside className="asset-viewer__dock work-dock" aria-label="작품 정보" style={info ? undefined : { visibility: "hidden", pointerEvents: "none" }} aria-hidden={!info} inert={!info}><div className="asset-viewer__dock-body">{data.manga?.ownership}<WorkInfo collection={data.collection} av={data.av} related={data.related} tmdb={data.tmdb} record={record}
      onSave={edit => actions.onSave(data.collection, edit)} onOpenPerson={actions.onOpenPerson} onOpenCollection={actions.onOpenCollection} onCopyCode={() => actions.onCopyCode(data.av?.productCode ?? null)} />{data.manga?.management}</div></aside>
  </>;
}
function HeroBand({ src, manga, onReady }: { src: string; manga: boolean; onReady(): void }) {
  const [settled, setSettled] = useState<{ generation: number; decoded: boolean } | null>(null);
  const requested = useRef({ src, generation: 0 });
  if (requested.current.src !== src) requested.current = { src, generation: requested.current.generation + 1 };
  const generation = requested.current.generation;
  useEffect(() => { if (settled?.generation === generation) onReady(); });
  return <div className={`work-hero-band${manga ? " work-hero-band--manga" : ""}`} aria-hidden="true" style={settled?.generation === generation && settled.decoded ? undefined : { visibility: "hidden" }}>
    {/* The surface's two slots retain this decoded element together with its case. */}
    <img src={src} alt="" draggable={false} onLoad={async event => {
      const image = event.currentTarget;
      try { await image.decode?.(); } catch { if (requested.current.generation === generation) setSettled({ generation, decoded: false }); return; }
      if (requested.current.generation !== generation || !image.isConnected) return;
      setSettled({ generation, decoded: true });
    }} onError={() => { if (requested.current.generation === generation) setSettled({ generation, decoded: false }); }} />
  </div>;
}
function FlatJacket({ data, stageBox, onReady }: { data: CaseData; stageBox?: StageBox; onReady(): void }) {
  const [ratio, setRatio] = useState(.71);
  const fit = stageBox ? fitFlatJacket(stageBox, ratio) : null;
  const settled = useRef(new Set<string>());
  const sources = data.privacy ? [] : [data.front, data.back, data.spine].filter((url): url is string => Boolean(url));
  useEffect(() => { if (sources.every(source => settled.current.has(source))) onReady(); });
  function settle(url: string) { settled.current.add(url); if (sources.every(source => settled.current.has(source))) onReady(); }
  return <div className="work-flat" aria-label="펼친 표지"><div className="work-flat-sheet" style={{ "--flat-ratio": ratio, ...(fit ? { "--flat-height": `${fit.height}px`, "--flat-spine": `${fit.spine}px` } : {}) } as CSSProperties}>{([ ["뒷면", data.back], ["책등", data.spine], ["앞면", data.front] ]).map(([label, url]) => <figure key={label} className={label === "책등" ? "work-flat-spine" : undefined}>
    {!data.privacy && url ? <StableImage src={url} alt={`${data.title} ${label}`} onError={() => settle(url)} onLoad={async event => { const img = event.currentTarget; if (label === "앞면" && img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight); try { await img.decode?.(); } catch { /* Failed faces settle without blocking the sheet. */ } settle(url); }} /> : <span className="privacy-mask" aria-label={data.privacy ? "비공개 모드" : "이미지 없음"} />}<figcaption>{label}</figcaption>
  </figure>)}</div></div>;
}
