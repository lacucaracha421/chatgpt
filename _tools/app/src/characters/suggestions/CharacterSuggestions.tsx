import { BusyLabel } from "../../shared/ui/BusyLabel";
import { AssetImage } from "../../privacy/AssetImage";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useOptionalLibrary } from "../../library/LibraryContext";
import { RevisionReadCache, seriesDataScope } from "../seriesMountCache";
import { onFolderPrefetchInvalidated } from "../../assets/folderPrefetch";
import { thumbnailUrl } from "../../assets/mediaUrl";
import { commandErrorMessage } from "../../library/errorMessage";
import { AnchoredPanel } from "../../shared/ui/AnchoredPanel";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { Menu } from "../../shared/ui/Menu";
import { SectionLabel } from "../../shared/ui/SectionLabel";
import { ChevronDownIcon, ChevronUpIcon, ClockIcon, EllipsisHorizontalIcon, EyeSlashIcon, InformationCircleIcon, LinkIcon } from "@heroicons/react/24/outline";
import { Dialog } from "../../shared/ui/Dialog";
import { Toast } from "../../shared/ui/Toast";
import { useAutoDismiss } from "../../shared/ui/useAutoDismiss";
import { SuggestionDialog } from "./SuggestionDialog";
import { suggestionApi, suggestionName, type IgnoredTag, type Suggestion, type SuggestionApi, type SuggestionResult } from "./client";
import { readSuggestionFilters, SUGGESTION_MINIMUMS, writeSuggestionFilters } from "./suggestionFilters";
import "./CharacterSuggestions.css";

// Shared browsing filters: remembered on this device and independent of library data.
let filters = readSuggestionFilters();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => filters;
const setFilters = (next: typeof filters) => { filters = next; writeSuggestionFilters(next); listeners.forEach(listener => listener()); };

const suggestionCache = new RevisionReadCache<{ rows: Suggestion[]; ignored: IgnoredTag[] }>();
onFolderPrefetchInvalidated(() => suggestionCache.clear());
export function prefetchCharacterSuggestions(version: number, scope: string, api: SuggestionApi = suggestionApi) {
  return suggestionCache.read(api, scope, version, String(filters.minimum), async () => {
    const [rows, ignored] = await Promise.all([api.list(filters.minimum), api.ignored()]);
    return { rows, ignored };
  });
}

export function useCharacterSuggestions(version: number, api: SuggestionApi = suggestionApi) {
  const currentFilters = useSyncExternalStore(subscribe, snapshot);
  const library = useOptionalLibrary();
  const dataScope = seriesDataScope(library?.gateway, library?.library?.root);
  const revision = useSyncExternalStore(suggestionCache.subscribe, () => suggestionCache.generation(api, dataScope));
  const cached = suggestionCache.peek(api, dataScope, version, String(currentFilters.minimum));
  const [rows, setRows] = useState<Suggestion[]>([]);
  const [ignored, setIgnored] = useState<IgnoredTag[]>([]);
  const [settledRequest, setSettledRequest] = useState<{ api: SuggestionApi; scope: string; minimum: number; version: number; revision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loading = !cached && (!settledRequest || settledRequest.api !== api || settledRequest.scope !== dataScope || settledRequest.minimum !== currentFilters.minimum || settledRequest.version !== version || settledRequest.revision !== revision);
  // Only the first read for this scope locks the rows; a later refresh (analysis keeps changing the
  // library) keeps the shown rows and their actions usable instead of flickering.
  const firstLoad = loading && !(settledRequest && settledRequest.api === api && settledRequest.scope === dataScope && settledRequest.minimum === currentFilters.minimum);
  const [message, setMessage] = useState<string | null>(null);
  const [postponed, setPostponed] = useState<string[]>([]);
  const refresh = useCallback(() => suggestionCache.invalidate(api, dataScope), [api, dataScope]);
  useEffect(() => {
    let live = true;
    setError(null);
    const request = { api, scope: dataScope, minimum: currentFilters.minimum, version, revision };
    void prefetchCharacterSuggestions(version, dataScope, api).then(({ rows: next, ignored: hidden }) => {
      if (live) { setRows(next); setIgnored(hidden); setSettledRequest(request); }
    }, reason => { if (live) { setSettledRequest(request); setError(commandErrorMessage(reason, "새 캐릭터 제안을 불러오지 못했습니다.")); } });
    return () => { live = false; };
  }, [api, dataScope, currentFilters.minimum, version, revision]);
  const ignore = async (tag: string, value: boolean) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await api.ignore(tag, value); setMessage(value ? "제안을 무시했습니다. 무시 목록에서 되돌릴 수 있어요." : "제안을 되돌렸습니다."); refresh(); }
    catch (reason) { setError(commandErrorMessage(reason, "무시 설정을 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  };
  useAutoDismiss(message, setMessage);
  const saved = (result: SuggestionResult) => {
    setMessage(result.queuedCount > 0 ? `${result.target.displayName} · ${result.queuedCount.toLocaleString("ko-KR")}장을 확인에 넣었습니다.` : `${result.target.displayName} · 저장했습니다.`);
    refresh();
  };
  return {
    rows: (cached?.rows ?? rows).filter(row => (!currentFilters.insideOnly || row.insideCount > 0) && !postponed.includes(row.tag)),
    ignored: cached?.ignored ?? ignored, loading, firstLoad, busy, error, message, dismissMessage: () => setMessage(null), refresh, ignore, saved, api,
    filters: currentFilters, setFilters,
    postponed, postpone: (tag: string) => setPostponed(tags => [...tags, tag]), clearPostponed: () => setPostponed([]),
  };
}
export type SuggestionState = ReturnType<typeof useCharacterSuggestions>;

export function CharacterSuggestionsOverview({ version, privacyMode, api = suggestionApi, onCount, onSaved }: {
  version: number; privacyMode: boolean; api?: SuggestionApi; onCount?: (count: number) => void;
  /** Called after a registration or merge is stored: its images just entered 확인, so the host list must read again. */
  onSaved?: (result: SuggestionResult) => void;
}) {
  const state = useCharacterSuggestions(version, api);
  const [collapsed, setCollapsed] = useState(false);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [editor, setEditor] = useState<{ suggestion: Suggestion; mode: "register" | "merge" } | null>(null);
  useEffect(() => { onCount?.(state.rows.length); }, [onCount, state.rows.length]);
  const groups = new Map<string, Suggestion[]>();
  for (const row of state.rows) {
    const key = row.seriesId ?? "";
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const busy = state.busy || state.firstLoad;
  return <section id="new-character-suggestions" className="character-suggestions" aria-label="새 캐릭터 제안">
    <header className="character-suggestions__bar">
      <h3><button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}><span>새 캐릭터 제안 <span className="numeric">{state.rows.length}</span>명</span>{collapsed ? <ChevronDownIcon aria-hidden="true" /> : <ChevronUpIcon aria-hidden="true" />}</button>
        <AnchoredPanel open={helpOpen} onOpenChange={setHelpOpen} title="새 캐릭터 제안" trigger={<Button size="icon" variant="ghost" aria-label="새 캐릭터 제안 도움말"><InformationCircleIcon aria-hidden="true" /></Button>}>
          <p>자동 태그가 읽었지만 아직 등록하지 않은 캐릭터예요. 자동으로 만들지 않고, 등록하면 그 이미지를 확인에 넣어요.</p>
        </AnchoredPanel></h3>
      {!collapsed && <>
        <span className="character-suggestions__space" />
        <select aria-label="최소 이미지 수" value={state.filters.minimum} onChange={event => state.setFilters({ ...state.filters, minimum: Number(event.target.value) })}>{SUGGESTION_MINIMUMS.map(value => <option key={value} value={value}>{value}장 이상</option>)}</select>
        <Checkbox checked={state.filters.insideOnly} onChange={event => state.setFilters({ ...state.filters, insideOnly: event.target.checked })}>시리즈 폴더 안에 있는 것만</Checkbox>
        {state.postponed.length > 0 && <Button size="sm" variant="quiet" onClick={state.clearPostponed}>나중에 {state.postponed.length} · 다시 보기</Button>}
        <Button size="sm" variant="quiet" onClick={() => setIgnoredOpen(true)}>무시 목록 <span className="numeric">{state.ignored.length}</span></Button>
      </>}
    </header>
    {!collapsed && <>
      <BusyLabel busy={!!(state.firstLoad)}><p role="status">제안 불러오는 중…</p></BusyLabel>
      {state.error && <p role="alert">{state.error} <Button size="sm" onClick={state.refresh}>다시 시도</Button></p>}
      {!state.loading && !state.error && state.rows.length === 0 && <p>조건에 맞는 새 캐릭터 제안이 없습니다.</p>}
      {[...groups].map(([key, rows]) => <section key={key} className="character-suggestions__group" aria-label={rows[0].seriesName ?? "시리즈 폴더 없음"}>
        <SectionLabel as="h3" title={rows[0].seriesName ?? "시리즈 폴더 없음"} count={rows.length} unit="명" actions={!key ? <small>등록할 때 폴더를 골라요</small> : undefined} />
        <div className="character-suggestion-cards">
          {rows.map(row => <SuggestionCard key={row.tag} suggestion={row} privacyMode={privacyMode} disabled={busy}
            onRegister={() => setEditor({ suggestion: row, mode: "register" })} onMerge={() => setEditor({ suggestion: row, mode: "merge" })}
            onIgnore={() => void state.ignore(row.tag, true)} onPostpone={() => state.postpone(row.tag)} />)}
        </div>
      </section>)}
    </>}
    {state.message && <Toast onDismiss={() => state.dismissMessage()}>{state.message}</Toast>}
    {ignoredOpen && <Dialog open title="무시한 캐릭터 제안" onClose={() => setIgnoredOpen(false)}>
      <div className="character-suggestion-ignored">
        {!state.ignored.length && <p>무시한 제안이 없습니다.</p>}
        {state.ignored.map(row => <div key={row.tag}><span>{suggestionName(row.tag)}<small>{row.tag}</small></span><Button size="sm" disabled={state.busy} onClick={() => void state.ignore(row.tag, false)}>되돌리기</Button></div>)}
      </div>
      {state.error && <p role="alert">{state.error}</p>}
      <Button variant="ghost" onClick={() => setIgnoredOpen(false)}>닫기</Button>
    </Dialog>}
    {editor && <SuggestionDialog {...editor} privacyMode={privacyMode} api={api} onClose={() => setEditor(null)} onSaved={result => { setEditor(null); state.saved(result); onSaved?.(result); }} />}
  </section>;
}

const FOLDER_PICTURES = 3;
/** One sentence from the same counts the row used: folder, then the images found elsewhere. */
export function suggestionFolderSentence(row: Suggestion): string {
  if (!row.seriesId) return "시리즈 폴더 없음";
  const elsewhere = row.imageCount - row.insideCount;
  if (elsewhere <= 0) return `${row.seriesName} 폴더에 ${row.insideCount}장`;
  if (row.insideCount <= 0) return `${row.seriesName} 폴더에는 없고 다른 곳에 ${elsewhere}장`;
  return `${row.seriesName} 폴더에 ${row.insideCount}장, 다른 곳에 ${elsewhere}장`;
}

function SuggestionCard({ suggestion: row, privacyMode, disabled, onRegister, onMerge, onIgnore, onPostpone }: {
  suggestion: Suggestion; privacyMode: boolean; disabled: boolean; onRegister(): void; onMerge(): void; onIgnore(): void; onPostpone(): void;
}) {
  const name = suggestionName(row.tag);
  const sure = row.bothCount, unsure = row.imageCount - row.bothCount;
  return <article className="character-suggestion-card" aria-label={name}>
    <div className="character-suggestion-card__media" aria-label="표본 이미지">
      {Array.from({ length: FOLDER_PICTURES }, (_, slot) => {
        const id = row.sampleAssetIds[slot];
        return <span key={slot} className="character-suggestion-card__thumb">
          {!privacyMode && id && <AssetImage loading="lazy" draggable={false} src={thumbnailUrl(id, row.sampleThumbnailRevisions?.[id])} alt="" />}
          {slot === FOLDER_PICTURES - 1 && row.imageCount > FOLDER_PICTURES && <Badge variant="scrim">+{row.imageCount - FOLDER_PICTURES}</Badge>}
        </span>;
      })}
    </div>
    <div className="character-suggestion-card__body">
      <div className="character-suggestion-card__name"><b>{name}</b><small title={row.tag}>{row.tag}</small></div>
      <div className="character-suggestion-card__count"><b><span className="numeric">{row.imageCount}</span>장</b>{sure > 0 && <Badge>확실 {sure}</Badge>}{unsure > 0 && <Badge>불확실 {unsure}</Badge>}</div>
      <p className="character-suggestion-card__where">{suggestionFolderSentence(row)}</p>
      <div className="character-suggestion-card__actions">
        <Button disabled={disabled} onClick={onRegister}>캐릭터로 등록</Button>
        <Menu label={`${name} 더 보기`} align="end" disabled={disabled} triggerClassName="ui-button ui-button--quiet character-suggestion-card__more" trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={[
          { id: "merge", label: "다른 캐릭터와 같음…", icon: <LinkIcon />, onSelect: onMerge },
          { id: "postpone", label: "나중에", icon: <ClockIcon />, onSelect: onPostpone },
          { id: "ignore", label: "무시", icon: <EyeSlashIcon />, onSelect: onIgnore },
        ]} />
      </div>
    </div>
  </article>;
}

export function CharacterSuggestionTile({ suggestion, state, privacyMode, onChanged }: { suggestion: Suggestion; state: SuggestionState; privacyMode: boolean; onChanged(): void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"register" | "merge" | null>(null);
  const edit = (value: "register" | "merge") => { setOpen(false); setMode(value); };
  return <>
    <AnchoredPanel open={open} onOpenChange={setOpen} title={suggestionName(suggestion.tag)} description={suggestion.tag}
      trigger={<button type="button" className="character-suggestion-tile" aria-label={`${suggestionName(suggestion.tag)} 제안 ${suggestion.imageCount}장`}>
        <span className="character-suggestion-tile__mosaic character-suggestion-tile__mosaic--suggestion">{!privacyMode && suggestion.sampleAssetIds.map(id => <AssetImage key={id} draggable={false} loading="lazy" src={thumbnailUrl(id, suggestion.sampleThumbnailRevisions?.[id])} alt="" />)}</span>
        <span className="character-suggestion-tile__flag">제안</span><b>{suggestionName(suggestion.tag)}</b><small>{suggestion.imageCount}장 · 확실 {suggestion.bothCount} · 불확실 {suggestion.imageCount - suggestion.bothCount}</small>
      </button>}
      footer={<SuggestionActions disabled={state.busy} onRegister={() => edit("register")} onMerge={() => edit("merge")} onIgnore={() => { setOpen(false); void state.ignore(suggestion.tag, true); }} onPostpone={() => state.postpone(suggestion.tag)} />}>
      <SuggestionCounts suggestion={suggestion} /><Samples suggestion={suggestion} privacyMode={privacyMode} /><Location suggestion={suggestion} />
    </AnchoredPanel>
    {mode && <SuggestionDialog suggestion={suggestion} mode={mode} privacyMode={privacyMode} api={state.api} onClose={() => setMode(null)} onSaved={result => { setMode(null); state.saved(result); onChanged(); }} />}
  </>;
}

function SuggestionCounts({ suggestion: row }: { suggestion: Suggestion }) {
  return <div className="character-suggestion-count"><b><span className="numeric">{row.imageCount}</span>장</b><small>확실 {row.bothCount} · 불확실 {row.imageCount - row.bothCount}</small></div>;
}
function Samples({ suggestion, privacyMode }: { suggestion: Suggestion; privacyMode: boolean }) {
  return <div className="character-suggestion-samples" aria-label="표본 이미지">{suggestion.sampleAssetIds.map(id => <span key={id}>{!privacyMode && <AssetImage loading="lazy" draggable={false} src={thumbnailUrl(id, suggestion.sampleThumbnailRevisions?.[id])} alt="" />}</span>)}{suggestion.imageCount > 4 && <small>+{suggestion.imageCount - 4}</small>}</div>;
}
function Location({ suggestion }: { suggestion: Suggestion }) {
  return <div className="character-suggestion-location">{suggestion.seriesId ? <><span>{suggestion.seriesName} 폴더 {suggestion.insideCount}장</span><small>{suggestion.imageCount === suggestion.insideCount ? "모두 시리즈 폴더 안" : `다른 곳 ${suggestion.imageCount - suggestion.insideCount}장`}</small></> : <span>시리즈 폴더 없음</span>}</div>;
}
function SuggestionActions({ disabled, onRegister, onMerge, onIgnore, onPostpone }: { disabled: boolean; onRegister(): void; onMerge(): void; onIgnore(): void; onPostpone(): void }) {
  return <div className="character-suggestion-actions"><Button size="sm" disabled={disabled} onClick={onRegister}>등록</Button><Button size="sm" variant="ghost" disabled={disabled} onClick={onMerge}>다른 캐릭터와 같음…</Button><Button size="sm" variant="ghost" disabled={disabled} onClick={onPostpone}>나중에</Button><Button size="sm" variant="ghost" disabled={disabled} onClick={onIgnore}>무시</Button></div>;
}
