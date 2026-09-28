import { ClipboardDocumentIcon, PencilIcon, StarIcon } from "@heroicons/react/24/outline";
import { useEffect, useState, type CSSProperties } from "react";
import { displayDate } from "../shared/displayDate";
import type { CollectionSummary } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { Menu } from "../shared/ui/Menu";
import { CollectionSidebarSection } from "./CollectionSidebarSection";
import { avError, avGateway } from "./avClient";
import type { AvCoverSet, AvDetails, AvGateway, AvRelated, AvWorkCard } from "./avTypes";
import type { DvdPose } from "./av/DvdCase";
import { AvEditPanel } from "./AvEditPanel";
import { AvArtworkDialog } from "./AvArtworkDialog";
import { AvPerformerPage } from "./av/AvPerformerPage";
import { AvPortrait } from "./av/AvPortrait";
import { AvViewer } from "./av/AvViewer";
import { DvdCase } from "./av/DvdCase";
import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import "./avCollections.css";

type Panel = "info" | "artwork" | "viewer" | null;
const JUMPS = [
  ["av-detail-work", "작품"], ["av-detail-cast", "출연·감독"], ["av-detail-performers", "같은 배우의 다른 작품"],
  ["av-detail-series", "같은 시리즈"], ["av-detail-label", "같은 레이블"], ["av-detail-more", "자세한 정보"],
] as const;

export function AvCollectionDetail({ collection, scope: _scope, api = avGateway, onChanged, onEdit, onToggleShowcase, onDelete, onOpenCollection, onOpenSettings }: {
  onOpenSettings?: () => void;
  collection: CollectionSummary; scope: string; api?: AvGateway; onChanged(): Promise<void>;
  onEdit(): void; onToggleShowcase(): void; onDelete(): void; onOpenCollection?: (collectionId: string) => void;
}) {
  const { privacyMode } = usePrivacy();
  const [details, setDetails] = useState<AvDetails | null>(null);
  const [covers, setCovers] = useState<AvCoverSet | null>(null);
  const [related, setRelated] = useState<AvRelated | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [performerId, setPerformerId] = useState<string | null>(null);
  const [selectedPerformerId, setSelectedPerformerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [pose, setPose] = useState<DvdPose>("front");

  useEffect(() => {
    let active = true;
    setError(null); setDetails(null); setCovers(null); setRelated(null); setPerformerId(null); setSelectedPerformerId(null);
    void Promise.all([
      api.getDetails(collection.id),
      api.getCoverSet(collection.id),
      typeof api.getRelated === "function" ? api.getRelated(collection.id) : Promise.resolve(null),
    ]).then(([info, images, relations]) => {
      if (!active) return;
      setDetails(info); setCovers(images); setRelated(relations);
      setSelectedPerformerId(relations?.performers.find(person => person.items.length > 0)?.personId ?? null);
    }, reason => { if (active) setError(avError(reason)); });
    return () => { active = false; };
  }, [api, collection.id, collection.updatedAt, reload]);

  const title = details?.titleJa?.trim() || collection.name;
  const performers = details?.people.filter(person => person.role === "performer") ?? [];
  const directors = details?.people.filter(person => person.role === "director") ?? [];
  const activePerformer = related?.performers.find(person => person.personId === selectedPerformerId) ?? related?.performers[0] ?? null;
  const hasSeries = Boolean(related?.series?.items.length);
  const hasLabel = Boolean(related?.label?.items.length);
  const jumpIds = new Set(["av-detail-work", "av-detail-cast", ...(activePerformer?.items.length ? ["av-detail-performers"] : []), ...(hasSeries ? ["av-detail-series"] : []), ...(hasLabel ? ["av-detail-label"] : []), "av-detail-more"]);

  function changed() {
    void onChanged().catch(reason => setError(avError(reason)));
    setReload(value => value + 1);
  }
  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  const menu = <Menu label="작품 관리" trigger="관리" triggerClassName="av-detail-sidebar__manage" items={[
    { id: "edit", label: "컬렉션 편집", onSelect: onEdit },
    { id: "av-info", label: "AV 정보 편집", disabled: !details, onSelect: () => setPanel("info") },
    { id: "av-artwork", label: "표지 앞면·책등·뒷면", disabled: !covers, onSelect: () => setPanel("artwork") },
    { id: "showcase", label: collection.showcase ? "쇼케이스에서 제외" : "쇼케이스에 추가", onSelect: onToggleShowcase },
    { id: "delete", label: "컬렉션 삭제", destructive: true, onSelect: onDelete },
  ]} />;

  return <article className="av-collection-detail" aria-label="AV 상세">
    <CollectionSidebarSection>
      <div className="av-detail-sidebar">
        <h2>{performerId ? "AV 배우" : title}</h2>
        <span className="av-detail-sidebar__code numeric">{details?.productCode ?? "품번 없음"}</span>
        {!performerId && <StarRating value={collection.myScore} />}
        {!performerId && <Button size="sm" onClick={onToggleShowcase}>{collection.showcase ? "쇼케이스에서 제외" : "쇼케이스에 추가"}</Button>}
        {performerId && <Button size="sm" variant="ghost" onClick={() => setPerformerId(null)}>작품으로 돌아가기</Button>}
        {!performerId && <nav className="av-detail-sidebar__jumps" aria-label="AV 상세 이동">{JUMPS.filter(([id]) => jumpIds.has(id)).map(([id, label]) => <button key={id} type="button" onClick={() => scrollTo(id)}>{label}</button>)}</nav>}
      </div>
    </CollectionSidebarSection>
    <CollectionSidebarSection actions>{menu}</CollectionSidebarSection>
    {error && <p className="av-collection-detail__error" role="alert">{error} <Button size="sm" onClick={() => setReload(value => value + 1)}>다시 불러오기</Button></p>}
    {!details && !error && <p role="status">불러오는 중…</p>}
    {details && performerId ? <AvPerformerPage key={performerId} personId={performerId} currentCollectionId={collection.id} api={api} onOpenSettings={onOpenSettings} onBack={() => setPerformerId(null)} onOpenCollection={onOpenCollection} onOpenPerformer={setPerformerId} /> : details && covers && <>
      <AvHero id="av-detail-work" collection={collection} details={details} covers={covers} title={title} pose={pose} privacyMode={privacyMode} onPoseChange={setPose} onViewer={() => setPanel("viewer")} onEditInfo={() => setPanel("info")} onEdit={onEdit} onCopy={() => void copyText(details.productCode)} />
      <CastSection id="av-detail-cast" people={performers} directors={directors} privacyMode={privacyMode} onOpenPerson={setPerformerId} />
      <RelatedSections related={related} activePerformer={activePerformer} hasMultiplePerformers={performers.length > 1} onSelectPerformer={setSelectedPerformerId} onOpenPerformer={setPerformerId} onOpenCollection={onOpenCollection} />
      <details className="av-detail-more" id="av-detail-more"><summary>자세한 정보</summary><dl>
        {collection.originalTitle && <div><dt>원제</dt><dd lang="ja">{collection.originalTitle}</dd></div>}
        {details.genres.length > 0 && <div><dt>장르</dt><dd>{details.genres.join(" · ")}</dd></div>}
        <div><dt>표지</dt><dd>앞면 · 책등 · 뒷면 · 선택된 작품 아트워크</dd></div>
        <div><dt>보관 범위</dt><dd>AV 작품은 PC에서 표시하며 모바일 컬렉션 공개 목록에 포함하지 않습니다. PC 복구점에는 다른 컬렉션과 함께 기록됩니다. 별도 암호화 금고는 아닙니다. 표지 원본은 라이브러리의 작품 아트워크로 보관되며, 이미지 복구에는 원본 폴더 백업도 필요합니다.</dd></div>
      </dl></details>
    </>}
    {panel === "info" && details && <AvEditPanel details={details} api={api} onClose={() => setPanel(null)} onSaved={value => { setDetails(value); changed(); }} />}
    {panel === "artwork" && covers && <AvArtworkDialog collectionId={collection.id} covers={covers} api={api} onClose={() => setPanel(null)} onSaved={value => { setCovers(value); changed(); }} />}
    {panel === "viewer" && covers && <AvViewer title={title} covers={covers} onClose={() => setPanel(null)} />}
  </article>;
}

function AvHero({ id, collection, details, covers, title, pose, privacyMode, onPoseChange, onViewer, onEdit, onEditInfo, onCopy }: {
  id: string; collection: CollectionSummary; details: AvDetails; covers: AvCoverSet; title: string; pose: DvdPose; privacyMode: boolean;
  onPoseChange(pose: DvdPose): void; onViewer(): void; onEdit(): void; onEditInfo(): void; onCopy(): void;
}) {
  const wash = useCoverWash(covers.frontId, covers.revision, privacyMode);
  return <section id={id} className="av-detail-hero" style={{ "--av-wash-one": wash.one, "--av-wash-two": wash.two } as CSSProperties}>
    <div className="av-detail-hero__atmosphere" aria-hidden="true" />
    <div className="av-detail-hero__case">
      <div onDoubleClick={onViewer}><DvdCase frontArtworkId={covers.frontId} spineArtworkId={covers.spineId} backArtworkId={covers.backId} revision={covers.revision} pose={pose} interactive large restingAngle={12} size={392} onPoseChange={onPoseChange} alt={`${title} DVD 케이스`} /></div>
      <div className="av-detail-stops" role="group" aria-label="케이스 면">{(["front", "spine", "back"] as const).map(value => <Button key={value} size="sm" aria-pressed={pose === value} onClick={() => onPoseChange(value)}>{value === "front" ? "앞면" : value === "spine" ? "책등" : "뒷면"}</Button>)}</div>
      <Button size="sm" variant="ghost" disabled={privacyMode} onClick={onViewer}>표지 감상</Button>
    </div>
    <div className="av-detail-hero__identity">
      <div className="av-detail-code"><b className="numeric">{details.productCode ?? "품번 없음"}</b><Button size="icon" variant="ghost" aria-label="품번 복사" disabled={!details.productCode} onClick={onCopy}><ClipboardDocumentIcon aria-hidden="true" /></Button><Button size="sm" variant="ghost" className="av-detail-code__edit" onClick={onEditInfo}>AV 정보 편집</Button></div>
      <h1 lang={details.titleJa ? "ja" : undefined} title={title}>{title}</h1>
      <div className="av-detail-facts"><span>발매 <b className="numeric">{displayDate(details.releaseDate || collection.releaseDate) || "미상"}</b></span>{collection.runtimeMinutes != null && <span>수록 <b className="numeric">{collection.runtimeMinutes}</b>분</span>}</div>
      <dl className="av-detail-meta"><MetaRow label="메이커" value={details.maker} count={details.makerCount} /><MetaRow label="레이블" value={details.label} count={details.labelCount} linkId="av-detail-label" /><MetaRow label="시리즈" value={details.series} count={details.seriesCount} linkId="av-detail-series" /></dl>
      {details.genres.length > 0 && <div className="av-detail-chips">{details.genres.map(genre => <span key={genre}>{genre}</span>)}</div>}
      <div className="av-detail-personal"><span>내 별점</span><StarRating value={collection.myScore} large /><span className="av-detail-personal__memo">{collection.description || "메모 없음"}</span><Button size="icon" variant="ghost" aria-label="컬렉션 메모 편집" onClick={onEdit}><PencilIcon aria-hidden="true" /></Button></div>
    </div>
  </section>;
}

function MetaRow({ label, value, count, linkId }: { label: string; value: string | null; count: number; linkId?: string }) {
  if (!value?.trim()) return null;
  const content = linkId ? <button type="button" onClick={() => document.getElementById(linkId)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{value}</button> : <span>{value}</span>;
  return <div><dt>{label}</dt><dd>{content}<small className="numeric">{count}</small></dd></div>;
}

function CastSection({ id, people, directors, privacyMode, onOpenPerson }: { id: string; people: AvDetails["people"]; directors: AvDetails["people"]; privacyMode: boolean; onOpenPerson(id: string): void }) {
  return <section id={id} className="av-detail-cast"><SectionHeading title="출연" count={people.length} /><div className="av-detail-cast__row">{people.map(person => <PersonCard key={`${person.role}/${person.id}`} person={person} privacyMode={privacyMode} onClick={() => onOpenPerson(person.id)} />)}{directors.length > 0 && <><span className="av-detail-cast__divider" /><div><small className="av-detail-cast__role">감독</small>{directors.map(person => <PersonCard key={`${person.role}/${person.id}`} person={{ ...person, portrait: null }} privacyMode={privacyMode} onClick={() => onOpenPerson(person.id)} />)}</div></>}</div></section>;
}

function PersonCard({ person, privacyMode, onClick }: { person: AvDetails["people"][number]; privacyMode: boolean; onClick(): void }) {
  return <button type="button" className="av-detail-person" onClick={onClick}><AvPortrait portrait={person.portrait} name={person.displayName} size={84} /><span><b>{person.displayName}</b>{person.nameJa && person.nameJa !== person.displayName && <small lang="ja">{person.nameJa}</small>}{person.creditName && person.creditName !== person.displayName && person.creditName !== person.nameJa && <small>{person.creditName}</small>}<small>내 라이브러리 <em className="numeric">{person.workCount}</em>편</small></span>{privacyMode && <i>비공개</i>}</button>;
}

function RelatedSections({ related, activePerformer, hasMultiplePerformers, onSelectPerformer, onOpenPerformer, onOpenCollection }: { related: AvRelated | null; activePerformer: AvRelated["performers"][number] | null; hasMultiplePerformers: boolean; onSelectPerformer(id: string): void; onOpenPerformer(id: string): void; onOpenCollection?: (collectionId: string) => void }) {
  return <div className="av-detail-related">
    {activePerformer && activePerformer.items.length > 0 && <section id="av-detail-performers"><div className="av-detail-related__head"><SectionHeading title="같은 배우의 다른 작품" count={activePerformer.total} />{hasMultiplePerformers && <div className="av-detail-related__chips">{related?.performers.filter(person => person.items.length > 0).map(person => <Button key={person.personId} size="sm" aria-pressed={person.personId === activePerformer.personId} onClick={() => onSelectPerformer(person.personId)}>{person.displayName} <small className="numeric">{person.total}</small></Button>)}</div>}<Button size="sm" variant="ghost" onClick={() => onOpenPerformer(activePerformer.personId)}>배우 페이지</Button></div><Shelf items={activePerformer.items} total={activePerformer.total} onOpenCollection={onOpenCollection} /></section>}
    <div className="av-detail-related__two">
      {related?.series && related.series.items.length > 0 && <section id="av-detail-series"><div className="av-detail-related__head"><SectionHeading title="같은 시리즈" count={related.series.total} /><span>{related.series.name}</span></div><Shelf items={related.series.items} total={related.series.total} series onOpenCollection={onOpenCollection} /></section>}
      {related?.label && related.label.items.length > 0 && <section id="av-detail-label"><div className="av-detail-related__head"><SectionHeading title="같은 레이블" count={related.label.total} /><span>{related.label.name}</span></div><Shelf items={related.label.items} total={related.label.total} onOpenCollection={onOpenCollection} /></section>}
    </div>
  </div>;
}

function Shelf({ items, total, series = false, onOpenCollection }: { items: (AvWorkCard | (AvWorkCard & { current: boolean }))[]; total?: number; series?: boolean; onOpenCollection?: (collectionId: string) => void }) {
  return <div className="av-detail-shelf">{items.map((item, index) => <WorkTile key={item.collectionId} item={item} order={series ? index + 1 : undefined} onOpenCollection={onOpenCollection} />)}{total !== undefined && total > items.length && <div className="av-detail-more-tile">+{total - items.length}</div>}</div>;
}

function WorkTile({ item, order, onOpenCollection }: { item: AvWorkCard & { current?: boolean }; order?: number; onOpenCollection?: (collectionId: string) => void }) {
  return <button type="button" className="av-detail-work-tile" onClick={() => onOpenCollection?.(item.collectionId)}><DvdCase frontArtworkId={item.frontArtworkId} spineArtworkId={item.spineArtworkId} backArtworkId={item.backArtworkId} revision={item.coverRevision} size={order ? 120 : 132} /><span>{order !== undefined && <em className="numeric">{order}</em>} {item.current && <i>이 작품</i>}</span><b className="numeric">{item.productCode ?? item.name}</b><small className="numeric">{displayDate(item.releaseDate)}</small></button>;
}

function SectionHeading({ title, count }: { title: string; count?: number }) { return <div className="av-detail-section-heading"><h2>{title}</h2>{count !== undefined && <span className="numeric">{count}</span>}</div>; }

function StarRating({ value, large = false }: { value: number | null; large?: boolean }) {
  const score = value == null ? 0 : Math.max(0, Math.min(5, value));
  return <span className={`av-stars${large ? " av-stars--large" : ""}`} aria-label={`내 별점 ${value == null ? "없음" : `${score}/5`}`}>{[1, 2, 3, 4, 5].map(star => <StarIcon key={star} aria-hidden="true" className={star <= score ? "is-filled" : ""} />)}</span>;
}

function useCoverWash(frontId: string | null, revision: string, privacyMode: boolean) {
  const [wash, setWash] = useState({ one: "rgb(82 85 89 / 24%)", two: "rgb(45 48 52 / 18%)" });
  useEffect(() => {
    if (privacyMode || !frontId) { setWash({ one: "rgb(82 85 89 / 24%)", two: "rgb(45 48 52 / 18%)" }); return; }
    let active = true;
    const image = new Image(); image.decoding = "async"; image.src = `${workArtworkThumbnailUrl(frontId)}?v=${encodeURIComponent(revision)}`;
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8;
        const context = canvas.getContext("2d"); if (!context) return;
        context.drawImage(image, 0, 0, 8, 8);
        const samples = [context.getImageData(1, 2, 1, 1).data, context.getImageData(6, 5, 1, 1).data];
        if (active) setWash({ one: `rgb(${samples[0]![0]} ${samples[0]![1]} ${samples[0]![2]} / .38)`, two: `rgb(${samples[1]![0]} ${samples[1]![1]} ${samples[1]![2]} / .28)` });
      } catch { /* Canvas can be unavailable in the browser fixture. */ }
    };
    return () => { active = false; image.src = ""; };
  }, [frontId, privacyMode, revision]);
  return wash;
}

async function copyText(value: string | null) {
  if (!value || !navigator.clipboard?.writeText) return;
  await navigator.clipboard.writeText(value);
}
