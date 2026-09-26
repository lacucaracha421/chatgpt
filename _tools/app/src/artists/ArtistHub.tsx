import { useEffect, useMemo, useState, type ReactNode } from "react";
import { thumbnailUrl } from "../assets/mediaUrl";
import { ViewToolbar } from "../layout/ViewToolbar";
import { commandErrorMessage } from "../library/errorMessage";
import type { ArtistHubSection, AssetView } from "../library/types";
import { displayDate } from "../shared/displayDate";
import { Button } from "../shared/ui/Button";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { ArrowPathIcon, CheckIcon, Cog6ToothIcon, MagnifyingGlassIcon, MergeIcon, XMarkIcon } from "./artistIcons";
import { invalidateArtists, localDateAndOffset, useArtistGateway, useArtistOverview, useArtistRead } from "./artistStore";
import { UNKNOWN_SOURCE, type ArtistBucket, type ArtistMergeSuggestion, type ArtistSettings, type ArtistSort, type ArtistSummary } from "./types";
import "./artists.css";

type Navigate = (view: AssetView) => void;
const PAGE = 200;
const formatCount = (value: number) => value.toLocaleString("ko-KR");

/** `@handle` for the first handle key, else the host of a creator URL. */
export function artistHandle(artist: Pick<ArtistSummary, "keys">): string | null {
  const handle = artist.keys.find((key) => !/^https?:\/\//.test(key));
  if (handle) return /^\d+$/.test(handle) ? handle : `@${handle}`;
  const url = artist.keys[0];
  if (!url) return null;
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}

export function ArtistThumb({ assetId, privacyMode, className = "artist-thumb" }: { assetId?: string; privacyMode: boolean; className?: string }) {
  return <span className={className} aria-hidden="true">
    {assetId && !privacyMode && <img src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />}
  </span>;
}

/** A row of thumbnails at one height, each in its own aspect ratio; overflow is clipped. */
export function ThumbStrip({ assetIds, privacyMode, label, onOpen }: { assetIds: string[]; privacyMode: boolean; label: string; onOpen?: (assetId: string) => void }) {
  return <div className="artist-strip" aria-label={label}>
    {assetIds.map((assetId) => onOpen
      ? <button key={assetId} type="button" className="artist-strip__item" aria-label={`${label} 이미지 열기`} onClick={() => onOpen(assetId)}>
        {!privacyMode && <img src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />}
      </button>
      : <span key={assetId} className="artist-strip__item">{!privacyMode && <img src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />}</span>)}
  </div>;
}

/** `129장 · 최근 저장 09.12`; an artist that is main only by recent saves shows those instead. */
function metaLine(artist: ArtistSummary, rule?: ArtistSettings) {
  const saved = artist.lastSavedAt ? `최근 저장 ${displayDate(artist.lastSavedAt)}` : null;
  const byRecent = rule && artist.assetCount < rule.mainMinCount && artist.recentCount >= rule.recentMinCount;
  return [byRecent ? `최근 ${rule.recentDays}일 ${formatCount(artist.recentCount)}장` : `${formatCount(artist.assetCount)}장`, saved].filter(Boolean).join(" · ");
}

export function ArtistHub({ view, onNavigate, privacyMode }: { view: Extract<AssetView, { kind: "artists" }>; onNavigate: Navigate; privacyMode: boolean }) {
  const section: ArtistHubSection = view.section ?? "main";
  const overview = useArtistOverview();
  const [ruleOpen, setRuleOpen] = useState(false);
  const titles: Record<ArtistHubSection, string> = {
    main: "주요 작가", others: "그 외 작가", singles: "한 장뿐인 작가들", hidden: "숨긴 작가", merge: "같은 작가일 수 있어요", "source-fill": "출처에서 작가 채우기",
  };
  const rule = overview?.settings;
  const accessory = section === "main" && overview ? <span className="artist-hub__count">{formatCount(overview.main)}명</span>
    : section === "merge" && overview ? <span className="artist-hub__count">{formatCount(overview.mergeSuggestions)}쌍 · 따로 두기 한 쌍은 다시 나오지 않음</span>
      : section === "source-fill" && overview ? <span className="artist-hub__count">출처 주소는 있고 작가가 없는 {formatCount(overview.unknownSource)}장</span> : undefined;
  return <section className="artist-hub" aria-label={titles[section]}>
    <ViewToolbar title={titles[section]} ariaLabel="작가 도구" titleAccessory={accessory} chrome={{
      status: section === "main" && rule ? <button type="button" className="artist-rule" aria-label={`주요 작가 기준 바꾸기: ${ruleText(rule)}`} onClick={() => setRuleOpen(true)}>
        {ruleText(rule)}<Cog6ToothIcon aria-hidden="true" />
      </button> : undefined,
    }} />
    <div className="artist-hub__scroll">
      {section === "main" && <MainSection onNavigate={onNavigate} privacyMode={privacyMode} />}
      {(section === "others" || section === "hidden") && <OthersList key={section} initialBucket={section === "hidden" ? "hidden" : "other"} onNavigate={onNavigate} privacyMode={privacyMode} />}
      {section === "singles" && <SinglesMosaic onNavigate={onNavigate} privacyMode={privacyMode} />}
      {section === "merge" && <MergeReview privacyMode={privacyMode} onNavigate={onNavigate} />}
      {section === "source-fill" && <SourceFill onNavigate={onNavigate} privacyMode={privacyMode} />}
    </div>
    {ruleOpen && rule && <TierRuleDialog settings={rule} mainCount={overview?.main ?? 0} onClose={() => setRuleOpen(false)} />}
  </section>;
}

export function ruleText(rule: ArtistSettings) {
  return `${rule.mainMinCount}장 이상 · ${rule.recentDays}일 안에 ${rule.recentMinCount}장 이상`;
}

function TierRuleDialog({ settings, mainCount, onClose }: { settings: ArtistSettings; mainCount: number; onClose: () => void }) {
  const gateway = useArtistGateway();
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof ArtistSettings, label: string, max: number) => <input type="number" min={1} max={max} value={draft[key]} aria-label={label}
    onChange={(event) => setDraft({ ...draft, [key]: Math.max(1, Math.min(max, Math.round(Number(event.target.value) || 1))) })} />;
  const save = async () => {
    if (!gateway) return;
    try { await gateway.setSettings(draft); invalidateArtists(); onClose(); } catch (cause) { setError(commandErrorMessage(cause, "기준을 저장하지 못했습니다.")); }
  };
  return <Dialog open title="주요 작가 기준" onClose={onClose}>
    <div className="artist-rule-form">
      <label>저장 {field("mainMinCount", "저장 장수", 100000)} 장 이상</label>
      <label>또는 최근 {field("recentDays", "최근 기간(일)", 3650)} 일 안에 {field("recentMinCount", "최근 저장 장수", 100000)} 장 이상</label>
      <p className="artist-muted">지금 기준으로 {formatCount(mainCount)}명. 고정한 작가는 기준과 상관없이 맨 위에 둡니다.</p>
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="ui-dialog__actions">
      <Button variant="ghost" onClick={onClose}>취소</Button>
      <Button variant="primary" onClick={() => void save()}>저장</Button>
    </div>
  </Dialog>;
}

function MainSection({ onNavigate, privacyMode }: { onNavigate: Navigate; privacyMode: boolean }) {
  const [shown, setShown] = useState(30);
  const rule = useArtistOverview()?.settings;
  const page = useArtistRead((gateway) => gateway.list({ bucket: "main", sort: "recent", limit: 1000 }), "main").data;
  const open = (artist: ArtistSummary) => onNavigate({ kind: "creator", creatorKey: artist.id });
  return <>
    <TodayStrip onNavigate={onNavigate} privacyMode={privacyMode} />
    <div className="artist-section-head"><span className="workspace-section-label">최근 저장 순 · 고정한 작가 제외</span></div>
    {!page && <Skeleton className="artist-hub__skeleton" label="작가를 불러오는 중" />}
    {page && page.artists.length === 0 && <EmptyState title="주요 작가가 아직 없습니다">작가 정보가 있는 이미지를 모으면 기준에 맞는 작가가 여기에 모입니다.</EmptyState>}
    {page && <ul className="artist-rows" aria-label="주요 작가">
      {page.artists.slice(0, shown).map((artist) => <li key={artist.id}>
        <ArtistMenu artist={artist} onNavigate={onNavigate}>
          <button type="button" className="artist-row" onClick={() => open(artist)} aria-label={`${artist.label} ${metaLine(artist, rule)}`}>
            <ArtistThumb assetId={artist.coverAssetIds[0]} privacyMode={privacyMode} />
            <span className="artist-row__copy">
              <span className="artist-row__name artist-name">{artist.label}</span>
              {artistHandle(artist) && <span className="artist-row__handle">{artistHandle(artist)}</span>}
              <span className="artist-row__meta">{metaLine(artist, rule)}</span>
            </span>
            <ThumbStrip assetIds={artist.coverAssetIds} privacyMode={privacyMode} label={artist.label} />
          </button>
        </ArtistMenu>
      </li>)}
    </ul>}
    {page && page.artists.length > shown && <div className="artist-more"><Button variant="ghost" onClick={() => setShown((value) => value + 30)}>주요 작가 {formatCount(page.artists.length - shown)}명 더 보기</Button></div>}
  </>;
}

/** 오늘: two or three artists to revisit, fixed for the day until 다시 고르기. */
function TodayStrip({ onNavigate, privacyMode }: { onNavigate: Navigate; privacyMode: boolean }) {
  const [seed, setSeed] = useState(0);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const { localDate, offsetMinutes } = localDateAndOffset();
  const rows = useArtistRead((gateway) => gateway.today(localDate, offsetMinutes, seed, dismissed), `today:${localDate}:${seed}:${dismissed.join("|")}`).data;
  if (rows && rows.length === 0) return null;
  const [, month, day] = localDate.split("-");
  return <section className="artist-today" aria-label="오늘">
    <div className="artist-section-head">
      <span className="workspace-section-label">오늘 · {Number(month)}월 {Number(day)}일</span>
      <Button size="sm" variant="ghost" onClick={() => setSeed((value) => value + 1)}><ArrowPathIcon aria-hidden="true" />다시 고르기</Button>
    </div>
    <div className="artist-today__rows">
      {(rows ?? []).map((row) => <article key={row.artist.id} className="artist-today__row" aria-label={`${row.artist.label} · ${row.reason}`}>
        <header>
          <button type="button" className="artist-today__who" onClick={() => onNavigate({ kind: "creator", creatorKey: row.artist.id })}>
            <ArtistThumb assetId={row.artist.coverAssetIds[0]} privacyMode={privacyMode} className="artist-thumb artist-thumb--small" />
            <span><span className="artist-name">{row.artist.label}</span><small className={`artist-today__reason artist-today__reason--${row.kind}`}>{row.reason}</small></span>
          </button>
          <Button size="icon" variant="ghost" aria-label={`${row.artist.label} 오늘에서 빼기`} onClick={() => setDismissed((list) => [...list, row.artist.id])}><XMarkIcon aria-hidden="true" /></Button>
        </header>
        <ThumbStrip assetIds={row.assetIds} privacyMode={privacyMode} label={row.artist.label} onOpen={() => onNavigate({ kind: "creator", creatorKey: row.artist.id })} />
      </article>)}
    </div>
  </section>;
}

/** Right-click actions shared by artist rows: 고정, 이름 바꾸기, 다른 작가와 합치기, 숨기기. */
function ArtistMenu({ artist, onNavigate, children }: { artist: ArtistSummary; onNavigate: Navigate; children: React.ReactElement }) {
  const gateway = useArtistGateway();
  const flag = (flags: { pinned?: boolean; hidden?: boolean }) => { if (gateway) void gateway.setFlags(artist.id, flags).then(invalidateArtists, () => undefined); };
  return <ContextMenu items={[
    { id: "pin", label: artist.pinned ? "고정 해제" : "고정", onSelect: () => flag({ pinned: !artist.pinned }) },
    { id: "rename", label: "이름 바꾸기", onSelect: () => onNavigate({ kind: "creator", creatorKey: artist.id, edit: true }) },
    { id: "merge", label: "다른 작가와 합치기", onSelect: () => onNavigate({ kind: "creator", creatorKey: artist.id, edit: true }) },
    { id: "hide", label: artist.hidden ? "다시 보이기" : "숨기기", onSelect: () => flag({ hidden: !artist.hidden }) },
  ]}>{children}</ContextMenu>;
}

function useDebounced<T>(value: T, delay = 150) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(value), delay); return () => window.clearTimeout(timer); }, [value, delay]);
  return debounced;
}

/** 그 외 작가 / 숨긴 작가: a dense name list with 초성 search and count filters. */
export function OthersList({ initialBucket, onNavigate, privacyMode }: { initialBucket: ArtistBucket; onNavigate: Navigate; privacyMode: boolean }) {
  const overview = useArtistOverview();
  const [query, setQuery] = useState("");
  const [bucket, setBucket] = useState<ArtistBucket>(initialBucket);
  const [sort, setSort] = useState<ArtistSort>("name");
  const [limit, setLimit] = useState(PAGE);
  const search = useDebounced(query.trim());
  // Searching looks through every visible artist; filters narrow the plain list.
  const effectiveBucket: ArtistBucket = search && bucket === "other" ? "all" : bucket;
  const page = useArtistRead((gateway) => gateway.list({ bucket: effectiveBucket, search: search || null, sort, limit }), `others:${effectiveBucket}:${search}:${sort}:${limit}`).data;
  const filter = (value: ArtistBucket, label: string, count: number | undefined) => <button type="button" className="artist-filter" aria-pressed={bucket === value}
    onClick={() => { setBucket(bucket === value ? initialBucket : value); setLimit(PAGE); }}>{label}{count !== undefined && <> <span>{formatCount(count)}</span></>}</button>;
  return <div className="artist-others">
    <div className="artist-others__controls">
      <label className="artist-search">
        <MagnifyingGlassIcon aria-hidden="true" />
        <input type="search" value={query} placeholder="이름 · 핸들 · 초성으로 찾기" aria-label="작가 찾기" onChange={(event) => { setQuery(event.target.value); setLimit(PAGE); }} />
      </label>
      <div className="artist-others__filters" role="group" aria-label="작가 거르기">
        {initialBucket === "other" && filter("twoToFour", "2–4장", overview?.twoToFour)}
        {initialBucket === "other" && filter("single", "1장", overview?.single)}
        {initialBucket === "other" && filter("hidden", "숨긴 작가", overview?.hidden)}
        <select className="artist-sort" aria-label="정렬" value={sort} onChange={(event) => setSort(event.target.value as ArtistSort)}>
          <option value="name">이름순</option><option value="recent">최근 저장순</option><option value="count">장수순</option>
        </select>
      </div>
    </div>
    {search && page && <p className="artist-muted artist-others__hint">{/^[ㄱ-ㅎ\s]+$/.test(search) ? `초성 ${search} · ` : ""}{formatCount(page.total)}명 · 이름·원래 이름·핸들에서 찾음</p>}
    {!page && <Skeleton className="artist-hub__skeleton" label="작가를 불러오는 중" />}
    {page && page.artists.length === 0 && <EmptyState title={search ? "찾는 작가가 없습니다" : "작가가 없습니다"} />}
    {page && <ul className="artist-list" aria-label="작가 목록">
      {page.artists.map((artist) => <li key={artist.id}>
        <ArtistMenu artist={artist} onNavigate={onNavigate}>
          <button type="button" className="artist-list__row" onClick={() => onNavigate({ kind: "creator", creatorKey: artist.id })}>
            <ArtistThumb assetId={artist.coverAssetIds[0]} privacyMode={privacyMode} className="artist-thumb artist-thumb--small" />
            <span className="artist-name artist-list__name">{artist.label}</span>
            <span className="artist-list__handle">{artistHandle(artist)}</span>
            <span className="artist-list__count">{formatCount(artist.assetCount)}</span>
            <span className="artist-list__date">{artist.lastSavedAt ? displayDate(artist.lastSavedAt) : ""}</span>
          </button>
        </ArtistMenu>
      </li>)}
    </ul>}
    {page && page.total > page.artists.length && <div className="artist-more"><Button variant="ghost" onClick={() => setLimit((value) => value + PAGE)}>{formatCount(page.total - page.artists.length)}명 더 보기</Button></div>}
  </div>;
}

/** 한 장뿐인 작가들: browse by image instead of by name; a tile opens its artist. */
function SinglesMosaic({ onNavigate, privacyMode }: { onNavigate: Navigate; privacyMode: boolean }) {
  const [limit, setLimit] = useState(PAGE);
  const page = useArtistRead((gateway) => gateway.list({ bucket: "single", sort: "recent", limit }), `singles:${limit}`).data;
  if (!page) return <Skeleton className="artist-hub__skeleton" label="작가를 불러오는 중" />;
  if (page.artists.length === 0) return <EmptyState title="한 장뿐인 작가가 없습니다" />;
  return <>
    <p className="artist-muted artist-hub__lead">이름 대신 그림으로 훑어보기 · 마음에 들면 작가 페이지로</p>
    <div className="artist-mosaic">
      {page.artists.map((artist) => <button key={artist.id} type="button" className="artist-mosaic__tile" aria-label={`${artist.label} 작가 페이지`} onClick={() => onNavigate({ kind: "creator", creatorKey: artist.id })}>
        {!privacyMode && artist.coverAssetIds[0] && <img src={thumbnailUrl(artist.coverAssetIds[0])} alt="" loading="lazy" decoding="async" draggable={false} />}
        <span className="artist-name">{artist.label}</span>
      </button>)}
    </div>
    {page.total > page.artists.length && <div className="artist-more"><Button variant="ghost" onClick={() => setLimit((value) => value + PAGE)}>{formatCount(page.total - page.artists.length)}명 더 보기</Button></div>}
  </>;
}

const SUGGESTION_LABEL: Record<ArtistMergeSuggestion["kind"], string> = { handle: "핸들이 같아요", name: "이름이 같아요", similar: "핸들이 비슷해요" };

function suggestionReason(suggestion: ArtistMergeSuggestion) {
  if (suggestion.kind === "handle") return "대소문자만 다름";
  if (suggestion.kind === "similar") return "뒤에 숫자만 다름";
  return suggestion.uncertain ? "게시판 출처" : "다른 사이트";
}

type SuggestionFilter = "all" | "handle" | "name" | "uncertain";

/** 합치기 제안: one card per pair with both sides' images, a name choice, 합치기 / 따로 두기. */
function MergeReview({ privacyMode, onNavigate }: { privacyMode: boolean; onNavigate: Navigate }) {
  const suggestions = useArtistRead((gateway) => gateway.mergeSuggestions(), "merge").data;
  const [filter, setFilter] = useState<SuggestionFilter>("all");
  const shown = useMemo(() => (suggestions ?? []).filter((suggestion) => filter === "all" || (filter === "uncertain" ? suggestion.uncertain : !suggestion.uncertain && suggestion.kind === filter)), [filter, suggestions]);
  if (!suggestions) return <Skeleton className="artist-hub__skeleton" label="합치기 제안을 불러오는 중" />;
  if (suggestions.length === 0) return <EmptyState title="합칠 만한 작가가 없습니다">핸들이 같거나 다른 사이트에서 이름이 같은 작가가 생기면 여기에 모입니다.</EmptyState>;
  const count = (value: SuggestionFilter) => suggestions.filter((suggestion) => value === "all" || (value === "uncertain" ? suggestion.uncertain : !suggestion.uncertain && suggestion.kind === value)).length;
  const chip = (value: SuggestionFilter, label: string) => <button type="button" className="artist-filter" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span>{count(value)}</span></button>;
  return <>
    <div className="artist-others__filters" role="group" aria-label="제안 거르기">{chip("all", "전체")}{chip("handle", "핸들 같음")}{chip("name", "이름 같음")}{chip("uncertain", "확실하지 않음")}</div>
    <div className="artist-merge-grid">
      {shown.map((suggestion) => <MergeCard key={`${suggestion.keyA}\n${suggestion.keyB}`} suggestion={suggestion} privacyMode={privacyMode} onNavigate={onNavigate} />)}
    </div>
  </>;
}

function MergeSide({ artist, privacyMode, onNavigate }: { artist: ArtistSummary; privacyMode: boolean; onNavigate: Navigate }) {
  return <div className="artist-merge__side">
    <button type="button" className="artist-merge__who" onClick={() => onNavigate({ kind: "creator", creatorKey: artist.id })}>
      <ArtistThumb assetId={artist.coverAssetIds[0]} privacyMode={privacyMode} className="artist-thumb artist-thumb--small" />
      <span><span className="artist-name">{artist.label}</span><small>{[artistHandle(artist), `${formatCount(artist.assetCount)}장`].filter(Boolean).join(" · ")}</small></span>
    </button>
    <ThumbStrip assetIds={artist.coverAssetIds.slice(0, 5)} privacyMode={privacyMode} label={artist.label} />
  </div>;
}

function MergeCard({ suggestion, privacyMode, onNavigate }: { suggestion: ArtistMergeSuggestion; privacyMode: boolean; onNavigate: Navigate }) {
  const gateway = useArtistGateway();
  const names = [...new Set([suggestion.left.label, suggestion.right.label])];
  const [choice, setChoice] = useState<string>(names[0]!);
  const [custom, setCustom] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true); setError(null);
    try { await action(); invalidateArtists(); } catch (cause) { setError(commandErrorMessage(cause, "작업을 마치지 못했습니다.")); } finally { setPending(false); }
  };
  const chosen = choice === "\u0000custom" ? custom.trim() : choice;
  const merge = () => gateway && run(() => gateway.merge(suggestion.left.id, [suggestion.right.id], chosen === suggestion.left.label || !chosen ? null : chosen));
  return <article className="artist-merge" aria-label={`${suggestion.left.label}와 ${suggestion.right.label}`}>
    <header className="artist-merge__reason">
      <span className={suggestion.uncertain ? "artist-merge__mark artist-merge__mark--weak" : "artist-merge__mark"} aria-hidden="true" />
      <strong>{SUGGESTION_LABEL[suggestion.kind]}</strong><span className="artist-muted"> · {suggestionReason(suggestion)}</span>
      {suggestion.uncertain && suggestion.kind === "name" && <span className="artist-badge artist-badge--warn">올린 사람일 수 있음</span>}
    </header>
    <div className="artist-merge__pair">
      <MergeSide artist={suggestion.left} privacyMode={privacyMode} onNavigate={onNavigate} />
      <MergeIcon className="artist-merge__join" aria-hidden="true" />
      <MergeSide artist={suggestion.right} privacyMode={privacyMode} onNavigate={onNavigate} />
    </div>
    <fieldset className="artist-merge__names">
      <legend>합친 이름</legend>
      {names.map((name) => <label key={name}><input type="radio" name={`merge-${suggestion.keyA}-${suggestion.keyB}`} checked={choice === name} onChange={() => setChoice(name)} />{name}</label>)}
      <label><input type="radio" name={`merge-${suggestion.keyA}-${suggestion.keyB}`} checked={choice === "\u0000custom"} onChange={() => setChoice("\u0000custom")} />직접 입력</label>
      {choice === "\u0000custom" && <input type="text" className="artist-input" aria-label="합친 이름 직접 입력" value={custom} onChange={(event) => setCustom(event.target.value)} />}
    </fieldset>
    <footer className="artist-merge__actions">
      <Button variant="primary" disabled={pending || (choice === "\u0000custom" && !custom.trim())} onClick={() => void merge()}><MergeIcon aria-hidden="true" />합치기</Button>
      <Button disabled={pending} onClick={() => gateway && void run(() => gateway.dismissSuggestion(suggestion.keyA, suggestion.keyB))}>따로 두기</Button>
      <span className="artist-muted">합친 뒤에도 작가 편집에서 떼어낼 수 있어요</span>
    </footer>
    {error && <p role="alert" className="artist-error">{error}</p>}
  </article>;
}

const SITE_NOTE: Record<string, string> = {
  "x.com": "주소에서 핸들 읽기",
  pixiv: "작품 번호만 있어 조회가 필요해요 · 지금은 직접 지정",
  "arca.live": "글쓴이가 작가가 아닐 수 있음",
  dcinside: "글쓴이가 작가가 아닐 수 있음",
};

/** 출처에서 작가 채우기: x.com handles are read offline and linked in one step; other sites are listed for 작가 지정. */
function SourceFill({ onNavigate, privacyMode }: { onNavigate: Navigate; privacyMode: boolean }) {
  const gateway = useArtistGateway();
  const preview = useArtistRead((artists) => artists.sourceFillPreview(), "source-fill").data;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useAutoDismiss(message, setMessage);
  if (!preview) return <Skeleton className="artist-hub__skeleton" label="출처를 살펴보는 중" />;
  if (preview.total === 0) return <EmptyState title="채울 이미지가 없습니다">출처 주소가 있는 이미지는 모두 작가와 이어져 있어요.</EmptyState>;
  const apply = async () => {
    if (!gateway) return;
    setPending(true);
    try {
      const result = await gateway.applySourceFill();
      invalidateArtists();
      setOpen(false);
      setMessage(`${formatCount(result.assigned)}장을 작가와 이었어요${result.createdArtists ? ` · 새 작가 ${formatCount(result.createdArtists)}명` : ""}`);
    } catch (cause) {
      setMessage(commandErrorMessage(cause, "작가를 채우지 못했습니다."));
    } finally { setPending(false); }
  };
  const table: ReactNode = <table className="artist-fill-table">
    <thead><tr><th scope="col">출처</th><th scope="col">장수</th><th scope="col">채우는 방법</th><th scope="col">채울 수 있음</th><th scope="col"><span className="artist-sr-only">작업</span></th></tr></thead>
    <tbody>
      {preview.sites.map((site) => <tr key={site.host} aria-current={open && site.host === "x.com" ? "true" : undefined}>
        <th scope="row">{site.host}</th>
        <td>{formatCount(site.assetCount)}</td>
        <td><span className={`artist-badge${site.method === "auto" ? " artist-badge--auto" : ""}`}>{site.method === "auto" ? "자동" : "직접"}</span> <span className="artist-muted">{SITE_NOTE[site.host] ?? "직접 지정"}</span></td>
        <td>{site.method === "auto" ? <>{formatCount(site.fillable)}{preview.withoutHandle > 0 && <small className="artist-muted"> · 핸들 없음 {formatCount(preview.withoutHandle)}</small>}</> : "–"}</td>
        <td>{site.method === "auto"
          ? <Button size="sm" aria-pressed={open} disabled={site.fillable === 0} onClick={() => setOpen((value) => !value)}>미리보기</Button>
          : <Button size="sm" variant="ghost" onClick={() => onNavigate({ kind: "creator", creatorKey: UNKNOWN_SOURCE })}>작가 미상에서 보기</Button>}</td>
      </tr>)}
      <tr className="artist-fill-table__total"><th scope="row">합계</th><td>{formatCount(preview.total)}</td><td /><td>{formatCount(preview.fillable)}</td><td /></tr>
    </tbody>
  </table>;
  return <div className={`artist-fill${open ? " artist-fill--open" : ""}`}>
    <div className="artist-fill__main">
      {table}
      <p className="artist-muted artist-fill__note">x.com은 주소 x.com/(핸들)/status/…에서 바로 읽어 오프라인으로 채웁니다. 작가 정보는 이미지에 쓰지 않고 연결 기록으로만 남아 언제든 떼어낼 수 있어요. pixiv는 작품 번호만 있어 조회가 필요하고, arca.live·dcinside는 게시글별로 묶어 작가 지정으로 직접 붙입니다.</p>
    </div>
    {open && <aside className="artist-fill__preview" aria-label="x.com 채우기 미리보기">
      <header>
        <strong>x.com {formatCount(preview.fillable)}장 → 작가 {formatCount(preview.groups.length)}명</strong>
        <span className="artist-muted">기존 작가 {formatCount(preview.existingArtists)}명에 붙음 · 새 작가 {formatCount(preview.newArtists)}명</span>
        <Button variant="primary" disabled={pending} onClick={() => void apply()}><CheckIcon aria-hidden="true" />{formatCount(preview.fillable)}장 채우기</Button>
      </header>
      <ul className="artist-fill__groups">
        {preview.groups.slice(0, 100).map((group) => <li key={group.handle}>
          <ThumbStrip assetIds={group.sampleAssetIds} privacyMode={privacyMode} label={`@${group.handle}`} />
          <span className="artist-fill__handle">@{group.handle}</span>
          <span className="artist-fill__target">→ <span className="artist-name">{group.targetLabel ?? group.handle}</span> {group.targetId ? <span className="artist-muted">기존</span> : <span className="artist-badge">새 작가</span>}</span>
          <span className="artist-list__count">{formatCount(group.assetCount)}</span>
        </li>)}
      </ul>
      {preview.groups.length > 100 && <p className="artist-muted">… {formatCount(preview.groups.length - 100)}명 더</p>}
      {preview.withoutHandle > 0 && <p className="artist-muted">핸들이 없는 {formatCount(preview.withoutHandle)}장은 작가 미상에 남습니다</p>}
    </aside>}
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
  </div>;
}
