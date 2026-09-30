import { ArrowPathIcon, BookOpenIcon, ChevronLeftIcon, ChevronRightIcon, EllipsisHorizontalIcon, InformationCircleIcon, PencilIcon, Square2StackIcon, StarIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import type { CollectionSummary, WorkArtworkSummary } from "../../library/types";
import type { AvCoverSet, AvDetails, AvRelated } from "../avTypes";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { displayDate } from "../../shared/displayDate";
import { Button } from "../../shared/ui/Button";
import { Menu, type MenuItem } from "../../shared/ui/Menu";
import { StableImage } from "../../shared/ui/StableImage";
import { CaseInside, CollectionCase, type CaseData } from "../case/CollectionCase";
import { WorkInfo, workFacts, workRecord } from "./WorkInfo";
import "./collectionWork.css";

export type CollectionWorkData = { collection: CollectionSummary; av: AvDetails | null; covers: AvCoverSet | null; related: AvRelated | null; case: CaseData; artworks: WorkArtworkSummary[]; position: number; total: number; providerConnected: boolean };
export type WorkActions = {
  onClose(): void; onStep(offset: -1 | 1): void; onEdit(collection: CollectionSummary): void; onShowcase(collection: CollectionSummary): void;
  onManage(data: CollectionWorkData): MenuItem[]; onSave(collection: CollectionSummary, score: number | null, memo: string | null): Promise<void>;
  onOpenPerson(id: string): void; onOpenCollection?(id: string): void; onCopyCode(code: string | null): void;
};
export function CollectionWorkScreen({ data, pending, actions }: { data: CollectionWorkData; pending: boolean; actions: WorkActions }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => { root.current?.focus(); }, []);
  const [slots, setSlots] = useState<[CollectionWorkData | null, CollectionWorkData | null]>([data, null]);
  const [active, setActive] = useState<0 | 1>(0);
  const [info, setInfo] = useState(true);
  const [reset, setReset] = useState(0);
  const requested = useRef(data); requested.current = data;
  const visible = slots[active]!;
  useEffect(() => {
    if (slots[active] === data) return;
    // Metadata-only edits preserve the painted case and the record draft.
    if (slots[active]?.collection.id === data.collection.id && ["front", "spine", "back", "platform", "privacy"].every(key => slots[active]?.case[key as keyof CaseData] === data.case[key as keyof CaseData])) {
      setSlots(previous => active === 0 ? [data, previous[1]] : [previous[0], data]); return;
    }
    const other = active === 0 ? 1 : 0;
    if (slots[other] === data) return;
    setSlots(previous => other === 0 ? [data, previous[1]] : [previous[0], data]);
  }, [data, slots, active]);
  const waiting = pending || visible !== data;
  const title = visible.case.title;
  const privacy = data.case.privacy;
  return <article ref={root} tabIndex={-1} className={`collection-work asset-viewer${info ? " asset-viewer--docked" : ""}`} aria-label={visible.collection.type === "av" ? "AV 작품 화면" : "게임 작품 화면"} aria-busy={waiting}
    onKeyDown={event => {
      if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable],.ui-menu"))) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); if (!waiting) actions.onStep(event.key === "ArrowLeft" ? -1 : 1); }
    }}>
    <header className="asset-viewer__topbar">
      <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="목록으로" onClick={actions.onClose}><ChevronLeftIcon /></Button>
      <span className="asset-viewer__position"><b>{visible.position}</b> / {visible.total}</span>
      <span className="asset-viewer__title"><strong role="heading" aria-level={1}>{title}</strong><small>{[visible.av?.productCode ?? visible.collection.platforms, displayDate(visible.av?.releaseDate || visible.collection.releaseDate)].filter(Boolean).join(" · ")}</small></span>
      <span className="asset-viewer__spacer" />
      <Button className="asset-viewer__vbtn asset-viewer__favorite" size="icon" variant="ghost" aria-label="쇼케이스" aria-pressed={visible.collection.showcase} disabled={waiting} onClick={() => actions.onShowcase(visible.collection)}><StarIcon /></Button>
      <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="편집" disabled={waiting} onClick={() => actions.onEdit(visible.collection)}><PencilIcon /></Button>
      <Menu label="작품 관리" disabled={waiting} trigger={<EllipsisHorizontalIcon />} items={actions.onManage(visible)} />
      <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="정면으로" onClick={() => setReset(value => value + 1)}><ArrowPathIcon /></Button>
      <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="정보" aria-pressed={info} onClick={() => setInfo(value => !value)}><InformationCircleIcon /></Button>
      <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="닫기" onClick={actions.onClose}><XMarkIcon /></Button>
    </header>
    {slots.map((slot, index) => slot && <div key={index} className={`work-surface${info ? " work-surface--info" : ""}`} style={index === active ? undefined : { visibility: "hidden", pointerEvents: "none" }} inert={index !== active || waiting} aria-hidden={index !== active}>
      <WorkSurface data={slot} privacy={privacy} info={info} reset={reset} actions={actions} onReady={() => { if (index !== active && slot === requested.current) { setActive(index as 0 | 1); root.current?.focus({ preventScroll: true }); } }} />
    </div>)}
  </article>;
}
function WorkSurface({ data, privacy, info, reset, actions, onReady }: { data: CollectionWorkData; privacy: boolean; info: boolean; reset: number; actions: WorkActions; onReady(): void }) {
  const caseData = { ...data.case, privacy };
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
  return <>
    <div className="work-stage">
      <div style={isObject ? undefined : { position: "absolute", inset: 0, visibility: "hidden", pointerEvents: "none" }} className="work-case-slot" inert={!isObject} aria-hidden={!isObject}>
        <CollectionCase data={caseData} large open={mode === "open"} onOpenChange={open => pick(open ? "open" : "case")} frontReset={reset}
          inside={<CaseInside record={workRecord(data.collection)} facts={workFacts(data.collection, data.av)} memo={data.collection.description} />}
          note={data.av?.people.length ? <><b>출연 · 감독</b>{data.av.people.map(person => person.displayName).join(" · ")}</> : undefined} onReady={onReady} />
      </div>
      {data.collection.type === "av" && <div className="work-flat-slot" style={mode === "flat" ? undefined : { visibility: "hidden", pointerEvents: "none" }} aria-hidden={mode !== "flat"} inert={mode !== "flat"}><FlatJacket data={caseData} onReady={() => { flatReady.current = true; if (desired.current === "flat") setMode("flat"); }} /></div>}
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
    <aside className="asset-viewer__dock work-dock" aria-label="작품 정보" style={info ? undefined : { visibility: "hidden", pointerEvents: "none" }} aria-hidden={!info} inert={!info}><div className="asset-viewer__dock-body"><WorkInfo collection={data.collection} av={data.av} related={data.related}
      onSave={(score, memo) => actions.onSave(data.collection, score, memo)} onOpenPerson={actions.onOpenPerson} onOpenCollection={actions.onOpenCollection} onCopyCode={() => actions.onCopyCode(data.av?.productCode ?? null)} /></div></aside>
  </>;
}
function FlatJacket({ data, onReady }: { data: CaseData; onReady(): void }) {
  const settled = useRef(new Set<string>());
  const sources = data.privacy ? [] : [data.front, data.back, data.spine].filter((url): url is string => Boolean(url));
  useEffect(() => { if (sources.every(source => settled.current.has(source))) onReady(); });
  function settle(url: string) { settled.current.add(url); if (sources.every(source => settled.current.has(source))) onReady(); }
  return <div className="work-flat" aria-label="펼친 표지"><div className="work-flat-sheet">{([ ["뒷면", data.back], ["책등", data.spine], ["앞면", data.front] ]).map(([label, url]) => <figure key={label} className={label === "책등" ? "work-flat-spine" : undefined}>
    {!data.privacy && url ? <StableImage src={url} alt={`${data.title} ${label}`} onError={() => settle(url)} onLoad={async event => { const img = event.currentTarget; if (label === "앞면" && img.naturalHeight) img.closest<HTMLElement>(".work-flat-sheet")?.style.setProperty("--flat-ratio", String(img.naturalWidth / img.naturalHeight)); try { await img.decode?.(); } catch { /* Failed faces settle without blocking the sheet. */ } settle(url); }} /> : <span className="privacy-mask" aria-label={data.privacy ? "비공개 모드" : "이미지 없음"} />}<figcaption>{label}</figcaption>
  </figure>)}</div></div>;
}
