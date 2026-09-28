import { useEffect, useState, type ReactNode } from "react";
import { AssetViewer } from "../assets/AssetViewer";
import { thumbnailUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetSummary, AssetView } from "../library/types";
import { displayDate } from "../shared/displayDate";
import { Button } from "../shared/ui/Button";
import { Toggle } from "../shared/ui/Toggle";
import { artistHandle, ArtistThumb, ThumbStrip } from "./ArtistHub";
import { CheckIcon, MagnifyingGlassIcon, MergeIcon, PencilIcon, PinIcon, PlayIcon, SparklesIcon, XMarkIcon } from "./artistIcons";
import { invalidateArtists, localDateAndOffset, useArtistGateway, useArtistOverview, useArtistRead, useArtistRevision } from "./artistStore";
import { UNKNOWN_NONE, UNKNOWN_SOURCE, isUnknownArtist, type ArtistDetail, type ArtistStyleGroup, type ArtistStylePage, type ArtistStyleStatus } from "./types";
import "./artists.css";

type Navigate = (view: AssetView) => void;
const formatCount = (value: number) => value.toLocaleString("ko-KR");
const SITE_LABEL: Record<string, string> = { "x.com": "x", pixiv: "Pixiv", manual: "지정", "arca.live": "arca", dcinside: "dc" };
const STYLE_PAGE_SIZE = 5;
const REPOSTER_EXPLANATION = "공식 이미지·스크린샷·스틸컷을 다시 올리는 계정입니다. 켜면 '닮은 작가' 추천 대상에서 빠지고, 작가 목록에서는 '정리' › '퍼온 계정'으로 모입니다. 이미 붙은 이미지는 그대로 둡니다.";

export type ArtistScopeChrome = { title: string; accessory: ReactNode; intro: ReactNode; panel: ReactNode };

/**
 * Chrome for the gallery of one artist (`creator` views): header title and actions, the
 * summary + 다시보기 intro above the images, and the 작가 편집 panel. 작가 미상 gets its
 * filter chips instead. Returns null for other views.
 */
export function useArtistScopeChrome(view: AssetView, { onNavigate, onPlay, privacyMode }: { onNavigate?: Navigate; onPlay: () => void; privacyMode: boolean }): ArtistScopeChrome | null {
  const id = view.kind === "creator" ? view.creatorKey : null;
  const artistId = id && !isUnknownArtist(id) ? id : null;
  const { localDate, offsetMinutes } = localDateAndOffset();
  const { data: detail, error } = useArtistRead(artistId ? (gateway) => gateway.detail(artistId, localDate, offsetMinutes) : null, `detail:${artistId}:${localDate}`);
  const overview = useArtistOverview();
  const [editOpen, setEditOpen] = useState(false);
  const requestedEdit = view.kind === "creator" && view.edit === true;
  useEffect(() => { setEditOpen(requestedEdit); }, [artistId, requestedEdit]);
  const gateway = useArtistGateway();
  const navigate = onNavigate ?? (() => undefined);
  if (!id) return null;

  if (!artistId) {
    const chip = (target: string, label: string, count: number | undefined) => <button type="button" className="artist-filter" aria-pressed={id === target}
      onClick={() => navigate({ kind: "creator", creatorKey: target })}>{label}{count !== undefined && <> <span>{formatCount(count)}</span></>}</button>;
    const suggestionsOnly = view.kind === "creator" && view.styleSuggestionsOnly === true;
    return {
      title: "작가 미상",
      accessory: null,
      intro: <div className="artist-intro artist-intro--unknown">
        <div className="artist-others__filters" role="group" aria-label="작가 미상 거르기">
          {chip(UNKNOWN_NONE, "출처 없음", overview?.unknownNone)}
          {chip(UNKNOWN_SOURCE, "출처만 있음", overview?.unknownSource)}
          {overview?.styleSuggestionCount ? <button type="button" className="artist-filter" aria-pressed={suggestionsOnly}
            onClick={() => navigate({ kind: "creator", creatorKey: id, ...(suggestionsOnly ? {} : { styleSuggestionsOnly: true }) })}>
            추천 있음 <span>{formatCount(overview.styleSuggestionCount)}</span>
          </button> : null}
        </div>
        <p className="artist-muted">{id === UNKNOWN_NONE ? "작가도 출처도 없는 이미지" : "출처 주소는 있지만 작가가 없는 이미지"} · 골라서 작가 지정으로 붙일 수 있어요. 원본 파일과 출처 정보는 바뀌지 않습니다.</p>
        <UnknownStyleSuggestions privacyMode={privacyMode} onNavigate={navigate} />
      </div>,
      panel: null,
    };
  }

  const summary = detail?.summary;
  const togglePin = async () => {
    if (!gateway || !summary) return;
    const next = await gateway.setFlags(summary.id, { pinned: !summary.pinned });
    invalidateArtists();
    if (next && next !== summary.id) navigate({ kind: "creator", creatorKey: next });
  };
  const otherNames = detail ? [...new Set(detail.members.map((member) => member.name).filter((name): name is string => Boolean(name) && name !== summary?.label))] : [];
  return {
    title: summary?.label ?? (error ? "작가" : "…"),
    accessory: summary ? <>
      {summary.reposter && <span className="artist-badge artist-badge--reposter">퍼온 계정</span>}
      <span className="artist-page__subtitle">{[otherNames[0], otherNames.length > 1 ? `외 ${otherNames.length - 1}` : null].filter(Boolean).join(" ")}{otherNames.length ? " · " : ""}{formatCount(summary.assetCount)}장</span>
      <Button size="icon" variant={summary.pinned ? "secondary" : "ghost"} aria-label={summary.pinned ? "고정 해제" : "고정"} aria-pressed={summary.pinned} onClick={() => void togglePin()}><PinIcon aria-hidden="true" /></Button>
      <Button size="icon" variant={editOpen ? "secondary" : "ghost"} aria-label="작가 편집" aria-expanded={editOpen} onClick={() => setEditOpen((open) => !open)}><PencilIcon aria-hidden="true" /></Button>
      <Button size="sm" variant="primary" onClick={onPlay}><PlayIcon aria-hidden="true" />연속 보기</Button>
    </> : null,
    intro: detail ? <ArtistIntro detail={detail} privacyMode={privacyMode} /> : error ? <p role="alert" className="artist-error artist-intro">{commandErrorMessage(error, "작가를 불러오지 못했습니다.")}</p> : null,
    panel: detail && editOpen ? <ArtistEditPanel key={detail.summary.id} detail={detail} privacyMode={privacyMode} onClose={() => setEditOpen(false)} onNavigate={navigate} /> : null,
  };
}

function useArtistStyleSuggestionPages() {
  const gateway = useArtistGateway();
  const revision = useArtistRevision();
  const [page, setPage] = useState<ArtistStylePage | null>(null);
  const [status, setStatus] = useState<ArtistStyleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!gateway) { setPage(null); setStatus(null); setLoading(false); return; }
    let active = true;
    let timer: number | undefined;
    // The list answers from the last ranking right away; while that ranking is behind the
    // library (e.g. just after assigning images) it re-ranks in the background, so poll quietly.
    const load = async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const [nextStatus, nextPage] = await Promise.all([gateway.styleStatus(), gateway.styleSuggestions(0, STYLE_PAGE_SIZE)]);
        if (!active) return;
        setStatus(nextStatus);
        setPage(nextPage);
        setError(null);
        if (nextStatus.computing || nextPage.upToDate === false) timer = window.setTimeout(() => { void load(true); }, 1500);
      } catch (cause) {
        if (active) setError(cause);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [gateway, revision]);

  const loadMore = async () => {
    if (!gateway || !page || moreLoading || page.groups.length >= page.totalArtists) return;
    setMoreLoading(true);
    try {
      const next = await gateway.styleSuggestions(page.groups.length, STYLE_PAGE_SIZE);
      setPage((current) => current ? { ...current, groups: [...current.groups, ...next.groups], totalImages: next.totalImages, totalArtists: next.totalArtists } : next);
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setMoreLoading(false);
    }
  };
  return { page, status, loading, moreLoading, error, loadMore };
}

export function UnknownStyleSuggestions({ privacyMode, onNavigate }: { privacyMode: boolean; onNavigate: Navigate }) {
  const { gateway } = useLibrary();
  const { page, status, loading, moreLoading, error, loadMore } = useArtistStyleSuggestionPages();
  const [viewer, setViewer] = useState<{ items: AssetSummary[]; activeId: string } | null>(null);
  const groups = page?.groups ?? [];
  if (!loading && !status?.computing && groups.length === 0 && !error) return null;
  const open = (assetIds: string[]) => (assetId: string) => {
    const unique = [...new Set(assetIds)];
    void Promise.all(unique.map((id) => gateway.getAsset(id))).then((items) => setViewer({ items, activeId: assetId }), () => undefined);
  };
  const remaining = Math.max(0, (page?.totalArtists ?? 0) - groups.length);
  return <details className="artist-style-suggestions" open>
    <summary className="artist-style-suggestions__summary">
      <span className="workspace-section-label"><SparklesIcon aria-hidden="true" />닮은 작가 추천</span>
      {page && <span className="artist-style-suggestions__count">{formatCount(page.totalImages)}장 · {formatCount(page.totalArtists)}명</span>}
    </summary>
    <div className="artist-style-suggestions__body">
      {((loading && !page) || (status?.computing && groups.length === 0)) && <p className="artist-muted artist-style-suggestions__status" role="status">{status?.computing ? "라이브러리 변경 뒤 닮은 작가를 계산하는 중입니다…" : "닮은 작가 추천을 불러오는 중입니다…"}</p>}
      {Boolean(error) && <p className="artist-error artist-style-suggestions__status" role="alert">추천을 불러오지 못했습니다.</p>}
      {groups.map((group) => <ArtistStyleSuggestionRow key={group.artist.id} group={group} privacyMode={privacyMode} onNavigate={onNavigate} onOpen={open} />)}
      {remaining > 0 && <div className="artist-style-suggestions__more"><Button variant="ghost" disabled={moreLoading} onClick={() => void loadMore()}>작가 {STYLE_PAGE_SIZE}명 더 보기 · 남은 {formatCount(remaining)}명</Button></div>}
    </div>
    {viewer && <AssetViewer items={viewer.items} activeId={viewer.activeId} onActiveIdChange={(activeId) => setViewer((current) => current && { ...current, activeId })}
      onClose={() => setViewer(null)} onAssetOpened={(asset) => gateway.recordAssetOpened(asset.id, new Date().toISOString())} privacyMode={privacyMode} />}
  </details>;
}

function ArtistStyleSuggestionRow({ group, privacyMode, onNavigate, onOpen }: { group: ArtistStyleGroup; privacyMode: boolean; onNavigate: Navigate; onOpen: (assetIds: string[]) => (assetId: string) => void }) {
  const gateway = useArtistGateway();
  const [selectedIds, setSelectedIds] = useState<string[]>(() => group.candidates.map((candidate) => candidate.assetId));
  const [pending, setPending] = useState<"assign" | "dismiss" | "reposter" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const candidateKey = group.candidates.map((candidate) => candidate.assetId).join(",");
  useEffect(() => { setSelectedIds(group.candidates.map((candidate) => candidate.assetId)); }, [candidateKey]);
  const run = async (action: () => Promise<unknown>, kind: "assign" | "dismiss" | "reposter", requiresSelection = true) => {
    if (!gateway || (requiresSelection && selectedIds.length === 0)) return;
    setPending(kind); setError(null);
    try {
      await action();
      invalidateArtists();
    } catch (cause) {
      setError(commandErrorMessage(cause, "추천을 처리하지 못했습니다."));
    } finally {
      setPending(null);
    }
  };
  const setSelected = (assetId: string, checked: boolean) => setSelectedIds((current) => checked ? [...current, assetId] : current.filter((id) => id !== assetId));
  const candidateIds = group.candidates.map((candidate) => candidate.assetId);
  const setArtist = () => run(() => gateway!.assignAssets(selectedIds, { artistId: group.artist.id }), "assign");
  const dismiss = () => run(() => gateway!.dismissStyleSuggestion(selectedIds, group.artist.id), "dismiss");
  const reposter = () => {
    if (!gateway || !window.confirm(`${group.artist.label}을 퍼온 계정으로 표시할까요? 이 계정의 모든 추천 대상에 영향을 줍니다.`)) return;
    return run(() => gateway.setFlags(group.artist.id, { reposter: true }), "reposter", false);
  };
  return <article className="artist-style-row" aria-label={`${group.artist.label} 닮은 작가 추천`}>
    <div className="artist-style-row__artist">
      <button type="button" className="artist-style-row__artist-button" onClick={() => onNavigate({ kind: "creator", creatorKey: group.artist.id })}>
        <ArtistThumb assetId={group.artist.coverAssetIds[0]} privacyMode={privacyMode} className="artist-thumb artist-thumb--medium" />
        <span className="artist-style-row__artist-copy"><strong className="artist-name">{group.artist.label}</strong><small>라이브러리 {formatCount(group.artist.assetCount)}장 · 추천 {formatCount(group.candidates.length)}장</small></span>
      </button>
      <ThumbStrip assetIds={group.referenceAssetIds.slice(0, 4)} privacyMode={privacyMode} label={`${group.artist.label} 참고 이미지`} />
    </div>
    <div className="artist-style-row__candidates">
      {group.candidates.map((candidate) => <div className="artist-style-candidate" key={candidate.assetId}>
        <input type="checkbox" checked={selectedIds.includes(candidate.assetId)} aria-label={`${group.artist.label} ${candidate.score.toFixed(2)} 이미지 지정`} onChange={(event) => setSelected(candidate.assetId, event.target.checked)} />
        <button type="button" className="artist-style-candidate__open" aria-label={`${group.artist.label} ${candidate.score.toFixed(2)} 이미지 열기`} onClick={() => onOpen(candidateIds)(candidate.assetId)}>
          <span className="artist-style-candidate__media">{!privacyMode && <img src={thumbnailUrl(candidate.assetId)} alt="" loading="lazy" decoding="async" draggable={false} />}</span>
          <span className="artist-style-candidate__score">{candidate.score.toFixed(2)}</span>
        </button>
      </div>)}
      {group.candidates.length === 0 && <span className="artist-muted">추천 이미지가 없습니다.</span>}
    </div>
    <div className="artist-style-row__actions">
      <Button variant="primary" disabled={pending !== null || selectedIds.length === 0} onClick={() => void setArtist()}><CheckIcon aria-hidden="true" />선택한 이미지 지정 {formatCount(selectedIds.length)}</Button>
      <Button disabled={pending !== null || selectedIds.length === 0} onClick={() => void dismiss()}><XMarkIcon aria-hidden="true" />이 작가 아님</Button>
      <Button variant="ghost" disabled={pending !== null} onClick={() => void reposter()}><span aria-hidden="true">⊘</span>퍼온 계정으로 표시</Button>
    </div>
    {error && <p className="artist-error" role="alert">{error}</p>}
  </article>;
}

function ArtistIntro({ detail, privacyMode }: { detail: ArtistDetail; privacyMode: boolean }) {
  const { summary } = detail;
  const [viewer, setViewer] = useState<{ items: AssetSummary[]; activeId: string } | null>(null);
  const { gateway } = useLibrary();
  const open = (assetIds: string[]) => (assetId: string) => {
    void Promise.all(assetIds.map((id) => gateway.getAsset(id))).then((items) => setViewer({ items, activeId: assetId }), () => undefined);
  };
  const manual = detail.assignments.find((entry) => entry.source === "manual");
  const stat = (label: string, value: ReactNode) => <div className="artist-stat"><span>{label}</span><strong>{value}</strong></div>;
  return <div className="artist-intro">
    <div className="artist-stats">
      {stat("저장", formatCount(summary.assetCount))}
      {stat("처음 저장", summary.firstSavedAt ? displayDate(summary.firstSavedAt) : "–")}
      {stat("최근 저장", summary.lastSavedAt ? displayDate(summary.lastSavedAt) : "–")}
      {stat("출처", detail.sources.map((source) => `${SITE_LABEL[source.host] ?? source.host} ${formatCount(source.count)}`).join(" · ") || "–")}
    </div>
    <div className="artist-origins">
      {summary.displayName && <span className="artist-badge">직접 지은 이름</span>}
      <span className="artist-muted">원래 이름</span>
      {detail.members.map((member) => <span key={member.key} className="artist-origin">
        <span className="artist-name">{member.name ?? artistHandle({ keys: [member.key] })}</span>
        {member.host && <span className="artist-badge">{member.host}</span>}
      </span>)}
      {manual && <span className="artist-badge">직접 지정 {formatCount(manual.assetCount)}장</span>}
    </div>
    {(detail.onThisDay || detail.longUnseen) && <section className="artist-rediscovery" aria-label="다시보기">
      <span className="workspace-section-label">다시보기</span>
      {detail.onThisDay && <div className="artist-rediscovery__row">
        <p><strong>{detail.onThisDay.yearsAgo}년 전 오늘</strong> <span className="artist-muted">{displayDate(detail.onThisDay.localDate)}에 {formatCount(detail.onThisDay.total)}장 저장</span></p>
        <ThumbStrip assetIds={detail.onThisDay.assetIds} privacyMode={privacyMode} label={`${detail.onThisDay.yearsAgo}년 전 오늘`} onOpen={open(detail.onThisDay.assetIds)} />
      </div>}
      {detail.longUnseen && <div className="artist-rediscovery__row">
        <p><strong>오래 안 본 작품</strong> <span className="artist-muted">1년 넘게 열지 않은 {formatCount(detail.longUnseen.total)}장</span></p>
        <ThumbStrip assetIds={detail.longUnseen.assetIds} privacyMode={privacyMode} label="오래 안 본 작품" onOpen={open(detail.longUnseen.assetIds)} />
      </div>}
    </section>}
    {viewer && <AssetViewer items={viewer.items} activeId={viewer.activeId} onActiveIdChange={(activeId) => setViewer((current) => current && { ...current, activeId })}
      onClose={() => setViewer(null)} onAssetOpened={(asset) => gateway.recordAssetOpened(asset.id, new Date().toISOString())} privacyMode={privacyMode} />}
  </div>;
}

/** 작가 편집: 표시 이름, keys and assignments with 떼어내기, 합치기, 고정/숨기기. Opens beside the gallery without resizing it. */
export function ArtistEditPanel({ detail, privacyMode, onClose, onNavigate }: { detail: ArtistDetail; privacyMode: boolean; onClose: () => void; onNavigate: Navigate }) {
  const gateway = useArtistGateway();
  const { summary } = detail;
  const [name, setName] = useState(summary.displayName ?? "");
  const [pinned, setPinned] = useState(summary.pinned);
  const [hidden, setHidden] = useState(summary.hidden);
  const [reposter, setReposter] = useState(summary.reposter);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = search.trim();
  const candidates = useArtistRead(query ? (artists) => artists.list({ bucket: "all", search: query, sort: "count", limit: 8 }) : null, `merge-search:${query}`).data;
  const run = async (action: () => Promise<string | void>, close = false) => {
    setPending(true); setError(null);
    try {
      const next = await action();
      invalidateArtists();
      if (close) onClose();
      if (typeof next === "string" && next && next !== summary.id) onNavigate({ kind: "creator", creatorKey: next });
      else if (typeof next === "string" && !next) onNavigate({ kind: "artists" });
    } catch (cause) {
      setError(commandErrorMessage(cause, "작가를 바꾸지 못했습니다."));
    } finally { setPending(false); }
  };
  const save = () => gateway && run(async () => {
    let id = summary.id;
    const nextName = name.trim() || null;
    if (nextName !== summary.displayName) id = await gateway.setDisplayName(id, nextName);
    if (pinned !== summary.pinned || hidden !== summary.hidden || reposter !== summary.reposter) id = await gateway.setFlags(id, {
      ...(pinned !== summary.pinned ? { pinned } : {}),
      ...(hidden !== summary.hidden ? { hidden } : {}),
      ...(reposter !== summary.reposter ? { reposter } : {}),
    });
    return id;
  }, true);
  const explicit = summary.id.startsWith("artist:");
  const detachable = explicit && detail.members.length + detail.assignments.length > 1;
  const suggestions = detail.mergeSuggestions.map((suggestion) => suggestion.left.id === summary.id ? suggestion.right : suggestion.left);
  const mergeRows = (candidates?.artists ?? []).filter((artist) => artist.id !== summary.id);
  const mergeRow = (artist: typeof summary, note: string) => <li key={artist.id} className="artist-edit__row">
    <ArtistThumb assetId={artist.coverAssetIds[0]} privacyMode={privacyMode} className="artist-thumb artist-thumb--small" />
    <span className="artist-edit__copy"><span className="artist-name">{artist.label}</span><small>{[artistHandle(artist), note].filter(Boolean).join(" · ")}</small></span>
    <span className="artist-list__count">{formatCount(artist.assetCount)}</span>
    <Button size="sm" disabled={pending} onClick={() => gateway && void run(() => gateway.merge(summary.id, [artist.id], null))}><MergeIcon aria-hidden="true" />합치기</Button>
  </li>;
  return <aside className="artist-edit" aria-label="작가 편집">
    <header className="artist-edit__head"><h3>작가 편집</h3><Button size="icon" variant="ghost" aria-label="작가 편집 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button></header>
    <div className="artist-edit__body">
      <label className="artist-edit__label" htmlFor="artist-display-name">표시 이름</label>
      <div className="artist-edit__name">
        <input id="artist-display-name" className="artist-input" value={name} placeholder={summary.sourceName ?? ""} onChange={(event) => setName(event.target.value)} />
        {name && <Button size="icon" variant="ghost" aria-label="표시 이름 지우기" onClick={() => setName("")}><XMarkIcon aria-hidden="true" /></Button>}
      </div>
      <p className="artist-muted">비우면 원래 이름 <strong>{summary.sourceName ?? summary.label}</strong>. 원래 이름·핸들로도 검색됩니다.</p>

      <span className="workspace-section-label">원래 이름 · 핸들 {detail.members.length + detail.assignments.length}</span>
      <ul className="artist-edit__list">
        {detail.members.map((member) => <li key={member.key} className="artist-edit__row">
          <span className="artist-edit__copy">
            <span><span className="artist-name">{member.name ?? member.key}</span>{member.host && <span className="artist-badge">{member.host}</span>}</span>
            <small>{/^\d+$/.test(member.key) ? `작가 번호 ${member.key}` : artistHandle({ keys: [member.key] })}</small>
          </span>
          <span className="artist-list__count">{formatCount(member.assetCount)}</span>
          <Button size="sm" variant="ghost" disabled={pending || !detachable} onClick={() => gateway && void run(() => gateway.detachMember(summary.id, member.key))}>떼어내기</Button>
        </li>)}
        {detail.assignments.map((assignment) => <li key={assignment.source} className="artist-edit__row">
          <span className="artist-edit__copy">
            <span><span className="artist-name">{assignment.source === "manual" ? "직접 지정" : "출처에서 채움"}</span><span className="artist-badge">{assignment.source === "manual" ? "작가 미상에서" : "x.com 주소"}</span></span>
            <small>{assignment.latestAt ? `${displayDate(assignment.latestAt)}에 붙인 이미지` : ""}</small>
          </span>
          <span className="artist-list__count">{formatCount(assignment.assetCount)}</span>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => gateway && void run(() => gateway.detachAssignments(summary.id, assignment.source))}>떼어내기</Button>
        </li>)}
      </ul>

      <span className="workspace-section-label">합치기</span>
      <label className="artist-search">
        <MagnifyingGlassIcon aria-hidden="true" />
        <input type="search" value={search} placeholder="합칠 작가를 이름 · 핸들로 찾기" aria-label="합칠 작가 찾기" onChange={(event) => setSearch(event.target.value)} />
      </label>
      <ul className="artist-edit__list">
        {query ? mergeRows.map((artist) => mergeRow(artist, ""))
          : suggestions.map((artist) => mergeRow(artist, "같은 작가일 수 있어요"))}
      </ul>

      <div className="artist-edit__flags">
        <Toggle checked={pinned} onChange={(event) => setPinned(event.target.checked)}>고정</Toggle>
        <Toggle checked={hidden} onChange={(event) => setHidden(event.target.checked)}>숨기기</Toggle>
      </div>
      <div className="artist-edit__reposter">
        <Toggle checked={reposter} onChange={(event) => setReposter(event.target.checked)}>퍼온 계정 — 작가가 아님</Toggle>
        <p className="artist-muted">{REPOSTER_EXPLANATION}</p>
      </div>
      {error && <p role="alert" className="artist-error">{error}</p>}
    </div>
    <footer className="artist-edit__foot">
      <Button variant="ghost" onClick={onClose}>취소</Button>
      <Button variant="primary" disabled={pending} onClick={() => void save()}>저장</Button>
    </footer>
  </aside>;
}
