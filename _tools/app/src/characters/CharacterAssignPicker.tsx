import { EmptyState } from "../shared/ui/EmptyState";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { AssetImage } from "../privacy/AssetImage";
import { CheckIcon, MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, Squares2X2Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useId, useMemo, useState } from "react";
import { thumbnailUrl } from "../assets/mediaUrl";
import type { ClassificationEntry } from "../library/types";
import { matchesKoreanSearch } from "../shared/koreanSearch";
import { displayCount } from "../shared/displayDate";
import { Button } from "../shared/ui/Button";
import { characterAssignSuggestions, type CharacterAssignSuggestion, type CharacterTarget } from "./api";
import { characterExtrasApi } from "./extrasApi";
import type { CharacterGroup } from "./hubApi";
import "../shared/fold.css";
import "./CharacterAssignPicker.css";

export const CHARACTER_ASSIGN_RECENT_KEY = "lakomics.characterAssign.recent.v1";

type Props = {
  assetIds: string[];
  targets: CharacterTarget[];
  groups: CharacterGroup[];
  classifications: ClassificationEntry[];
  counts: Record<string, number>;
  privacyMode: boolean;
  busy?: boolean;
  onAssign: (targets: CharacterTarget[]) => void | Promise<void>;
  onClose: () => void;
  scopeSeriesId?: string;
  currentTargetId?: string;
  onCreate?: (name: string) => void | Promise<void>;
  loadSuggestions?: (assetIds: string[]) => Promise<CharacterAssignSuggestion[]>;
  /**
   * The 기타 buckets that exist. When given (even empty), every series section also offers 기타 for the
   * series and for each of its groups, creating a missing one with `ensureExtras` when it is chosen.
   */
  extras?: CharacterTarget[];
  ensureExtras?: (seriesId: string, groupId: string | null) => Promise<CharacterTarget>;
};

/** A 기타 row for a bucket that does not exist yet; choosing it creates the bucket first. */
const NEW_EXTRAS = "extras:new:";
const isNewExtras = (target: CharacterTarget) => target.id.startsWith(NEW_EXTRAS);
const shownName = (target: CharacterTarget) => target.role === "extras" ? "기타" : target.displayName;
function newExtras(seriesId: string, groupId: string | null): CharacterTarget {
  return { id: `${NEW_EXTRAS}${seriesId}:${groupId ?? ""}`, seriesClassificationId: seriesId, linkedClassificationId: null, displayName: "기타", enabled: false, manualOnly: true, revision: 0, references: [], ready: false, fingerprint: "", role: "extras", extrasGroupId: groupId };
}

/** A group with more characters than this starts folded, so the series' groups stay scannable. */
const GROUP_FOLD_OVER = 3;

type PickerRow = {
  key: string;
  target: CharacterTarget;
  context?: string;
  right: string;
  indented?: boolean;
  current?: boolean;
};

export function CharacterAssignPicker({ assetIds, targets, groups, classifications, counts, privacyMode, busy = false, onAssign, onClose, scopeSeriesId, currentTargetId, onCreate, loadSuggestions = characterAssignSuggestions, extras, ensureExtras = characterExtrasApi.ensure }: Props) {
  const [query, setQuery] = useState("");
  const [activeScopeId, setActiveScopeId] = useState<string | null>(scopeSeriesId ?? null);
  const [suggestions, setSuggestions] = useState<CharacterAssignSuggestion[]>([]);
  const [recentIds, setRecentIds] = useState(loadRecentIds);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmTargets, setConfirmTargets] = useState<CharacterTarget[] | null>(null);
  // Folds the user toggled while the picker is open; a search opens every matching group, and folds toggled during it last until the query changes.
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [searchFolded, setSearchFolded] = useState<string[]>([]);
  const foldIdPrefix = useId();
  const targetById = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets]);
  const seriesName = (target: CharacterTarget) => classifications.find(entry => entry.id === target.seriesClassificationId)?.name ?? "시리즈 없음";
  const activeScopeName = activeScopeId ? classifications.find(entry => entry.id === activeScopeId)?.name ?? "시리즈" : null;

  useEffect(() => { setActiveScopeId(scopeSeriesId ?? null); }, [scopeSeriesId]);

  useEffect(() => {
    let active = true;
    void Promise.resolve(loadSuggestions(assetIds)).then(result => {
      if (!active) return;
      const next = result.filter(item => targetById.has(item.targetId)).sort((a, b) => b.matched - a.matched || a.targetId.localeCompare(b.targetId)).slice(0, 3);
      setSuggestions(next);
      if (next[0]) setHighlightKey(`recommended:${next[0].targetId}`);
    }).catch(() => { if (active) setSuggestions([]); });
    return () => { active = false; };
  }, [assetIds, loadSuggestions, targetById]);

  const recommendedRows = suggestions.flatMap(suggestion => {
    const target = targetById.get(suggestion.targetId);
    if (!target || (activeScopeId && target.seriesClassificationId !== activeScopeId)) return [];
    return [{ key: `recommended:${target.id}`, target, context: activeScopeId ? undefined : seriesName(target), right: `${suggestion.total.toLocaleString("ko-KR")}장 중 ${suggestion.matched.toLocaleString("ko-KR")}장`, current: target.id === currentTargetId }];
  });
  const recentRows = recentIds.flatMap(id => {
    const target = targetById.get(id);
    if (!target || (activeScopeId && target.seriesClassificationId !== activeScopeId)) return [];
    return [{ key: `recent:${target.id}`, target, context: activeScopeId ? undefined : seriesName(target), right: formatCount(counts[target.id] ?? 0), current: target.id === currentTargetId }];
  });
  const seriesSections = useMemo(() => buildSeriesSections(targets, groups, classifications, counts, extras, scopeSeriesId), [classifications, counts, groups, targets, extras, scopeSeriesId]);
  const extraById = useMemo(() => new Map(seriesSections.flatMap(section => [...section.groups.flatMap(group => group.rows), ...section.ungrouped]).filter(row => row.target.role === "extras").map(row => [row.target.id, row.target] as const)), [seriesSections]);
  const filteredRecommended = recommendedRows.filter(row => matchesKoreanSearch([row.target.displayName, row.context], query));
  const filteredRecent = recentRows.filter(row => matchesKoreanSearch([row.target.displayName, row.context], query));
  const filteredSeries = seriesSections.flatMap(section => {
    const grouped = section.groups.flatMap(group => {
      const rows = group.rows.filter(row => matchesKoreanSearch([shownName(row.target), section.name, group.name], query));
      return rows.length ? [{ ...group, rows }] : [];
    });
    const ungrouped = section.ungrouped.filter(row => matchesKoreanSearch([shownName(row.target), section.name], query));
    return grouped.length || ungrouped.length ? [{ ...section, groups: grouped, ungrouped }] : [];
  });
  const scopedSeries = activeScopeId ? filteredSeries.filter(section => section.id === activeScopeId) : filteredSeries;
  const searching = query.trim().length > 0;
  const isGroupOpen = (group: SeriesGroup) => searching
    ? !searchFolded.includes(group.id)
    : groupOpen[group.id] ?? (group.characterCount <= GROUP_FOLD_OVER || group.rows.some(row => row.target.id === currentTargetId));
  const toggleGroup = (group: SeriesGroup) => {
    const open = isGroupOpen(group);
    if (searching) setSearchFolded(current => open ? [...current, group.id] : current.filter(id => id !== group.id));
    else setGroupOpen(current => ({ ...current, [group.id]: !open }));
  };
  const scopeRows = [
    ...filteredRecommended,
    ...filteredRecent,
    ...scopedSeries.flatMap(section => [...section.groups.flatMap(group => isGroupOpen(group) ? group.rows : []), ...section.ungrouped]),
  ].map(row => row.target.id === currentTargetId ? { ...row, current: true, right: "현재" } : row);
  const scopedNoMatch = Boolean(activeScopeId && query.trim() && scopeRows.length === 0);
  const otherSeriesRows = scopedNoMatch
    ? filteredSeries.filter(section => section.id !== activeScopeId).flatMap(section => [
      ...section.groups.flatMap(group => group.rows), ...section.ungrouped,
    ].map(row => ({ ...row, key: `other:${row.key}`, context: `${section.name} · 폴더 옮김`, current: false })))
    : [];
  const visibleRows = [
    ...(scopedNoMatch ? otherSeriesRows : scopeRows),
  ];
  useEffect(() => {
    if (!visibleRows.some(row => row.key === highlightKey)) setHighlightKey(visibleRows[0]?.key ?? null);
  }, [highlightKey, query, visibleRows.map(row => row.key).join("\n")]);

  const assign = async (chosen: CharacterTarget[]) => {
    if (busy || chosen.length === 0) return;
    if (assetIds.length * chosen.length > 200) {
      setMessage("이미지 수 × 캐릭터 수는 한 번에 200개까지 지정할 수 있습니다.");
      return;
    }
    const distinctSeries = new Set(chosen.map(target => target.seriesClassificationId));
    if (chosen.length > 1 && distinctSeries.size > 1 && confirmTargets === null) {
      setConfirmTargets(chosen);
      setMessage(null);
      return;
    }
    setMessage(null);
    let resolved = chosen;
    try {
      // A 기타 that does not exist yet is created now, on first use.
      resolved = await Promise.all(chosen.map(target => isNewExtras(target) ? ensureExtras(target.seriesClassificationId!, target.extrasGroupId ?? null) : target));
      await onAssign(resolved);
    } catch (reason) {
      if (resolved === chosen) setMessage(reason instanceof Error && reason.message ? reason.message : "기타를 만들지 못했습니다.");
      return;
    }
    const nextRecent = rememberRecentIds(resolved.filter(target => target.role !== "extras").map(target => target.id), recentIds);
    setRecentIds(nextRecent);
    onClose();
  };
  const toggleChecked = (id: string) => {
    setConfirmTargets(null); setMessage(null);
    setCheckedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  };
  const renderRow = (row: PickerRow) => {
    const checked = checkedIds.includes(row.target.id);
    return <button key={row.key} type="button" role="option" aria-selected={checked} aria-label={[shownName(row.target), row.context, row.right].filter(Boolean).join(" · ")}
      className={`character-assign-picker__row${row.indented ? " character-assign-picker__row--indented" : ""}`}
      data-highlighted={highlightKey === row.key || undefined}
      onPointerMove={() => setHighlightKey(row.key)}
      onClick={event => {
        if (event.ctrlKey || event.metaKey) toggleChecked(row.target.id);
        else void assign([row.target]);
      }}>
      <CharacterThumbnail target={row.target} privacyMode={privacyMode} />
      <span className="character-assign-picker__name">{shownName(row.target)}{row.context && <small>{row.context}</small>}</span>
      {row.current ? <span className="character-assign-picker__current">현재</span> : <span className="character-assign-picker__count">{row.right}</span>}
      {checked && <CheckIcon className="character-assign-picker__check" aria-hidden="true" />}
    </button>;
  };
  const clearScope = () => { setActiveScopeId(null); setConfirmTargets(null); setMessage(null); };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const current = visibleRows.findIndex(row => row.key === highlightKey);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = current < 0 ? 0 : Math.max(0, Math.min(visibleRows.length - 1, current + delta));
      setHighlightKey(visibleRows[next]?.key ?? null);
      return;
    }
    if (event.key === "Enter") {
      const row = visibleRows.find(item => item.key === highlightKey);
      if (row) { event.preventDefault(); void assign([row.target]); }
    }
  };
  const checkedTargets = checkedIds.flatMap(id => targetById.get(id) ?? extraById.get(id) ?? []);

  return <div className="character-assign-picker ui-menu" role="listbox" aria-label="캐릭터에 넣기" aria-multiselectable="true" onKeyDown={keyDown} onClick={event => event.stopPropagation()}>
    <div className="character-assign-picker__search ui-text-input">
      <MagnifyingGlassIcon aria-hidden="true" />
      {activeScopeId && <button type="button" className="character-assign-picker__scope" aria-label={`${activeScopeName} 범위 빼기`} onMouseDown={event => event.preventDefault()} onClick={clearScope}>
        <span>{activeScopeName}</span><XMarkIcon aria-hidden="true" />
      </button>}
      <input autoFocus type="search" role="searchbox" aria-label="캐릭터 찾기" placeholder="캐릭터 찾기" value={query}
        onChange={event => { setQuery(event.target.value); setSearchFolded([]); setConfirmTargets(null); setMessage(null); }}
        onKeyDown={event => { if (event.key === "Backspace" && !query && activeScopeId) { event.preventDefault(); clearScope(); } }} autoComplete="off" />
    </div>
    <div className="character-assign-picker__scroll" data-native-scrollbar="true">
      {!scopedNoMatch && filteredRecommended.length > 0 && <PickerSection label="추천">{filteredRecommended.map(row => renderRow(row.target.id === currentTargetId ? { ...row, current: true, right: "현재" } : row))}</PickerSection>}
      {!scopedNoMatch && filteredRecent.length > 0 && <PickerSection label="최근">{filteredRecent.map(row => renderRow(row.target.id === currentTargetId ? { ...row, current: true, right: "현재" } : row))}</PickerSection>}
      {!scopedNoMatch && scopedSeries.map(section => <PickerSection key={section.id} label={section.name}>
        {section.groups.map(group => {
          const open = isGroupOpen(group);
          const foldId = `${foldIdPrefix}-group-${group.id}`;
          return <div key={group.id} className="character-assign-picker__group" role="group" aria-label={group.name}>
            <button type="button" className="character-assign-picker__group-header" aria-expanded={open} aria-controls={foldId}
              onClick={() => toggleGroup(group)}
              // Enter and Space toggle this header; the list's Enter-to-assign must not take them.
              onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}>
              <span className="character-assign-picker__group-name">{group.name}</span>
              <span className="character-assign-picker__group-count">{displayCount(group.characterCount, "명")}</span>
              <ChevronDownIcon className="character-assign-picker__group-chevron" aria-hidden="true" />
            </button>
            <div id={foldId} className="ui-fold character-assign-picker__group-fold" data-open={open} inert={!open} aria-hidden={!open}>
              <div className="ui-fold__inner">
                {group.rows.map(row => renderRow(row.target.id === currentTargetId ? { ...row, current: true, right: "현재" } : row))}
              </div>
            </div>
          </div>;
        })}
        {section.ungrouped.map(row => renderRow(row.target.id === currentTargetId ? { ...row, current: true, right: "현재" } : row))}
      </PickerSection>)}
      {scopedNoMatch && <>
        <div className="character-assign-picker__empty character-assign-picker__empty--scoped">{activeScopeName}에 없음</div>
        {otherSeriesRows.length > 0 && <PickerSection label="다른 시리즈">{otherSeriesRows.map(renderRow)}</PickerSection>}
        {onCreate && <PickerSection label="새 캐릭터"><button type="button" className="character-assign-picker__create" onClick={() => void onCreate(query.trim())}>
          <span className="character-assign-picker__create-icon"><PlusIcon aria-hidden="true" /></span><span>{activeScopeName}에 “{query.trim()}” 만들기</span>
        </button></PickerSection>}
        {otherSeriesRows.length === 0 && !onCreate && <EmptyState inline className="character-assign-picker__empty" title="검색 결과 없음" />}
      </>}
      {!scopedNoMatch && visibleRows.length === 0 && <EmptyState inline className="character-assign-picker__empty" title="검색 결과 없음" />}
      {!scopedNoMatch && visibleRows.length === 0 && query.trim() && onCreate && <PickerSection label="새 캐릭터"><button type="button" className="character-assign-picker__create" disabled={busy} onClick={() => void onCreate(query.trim())}><span className="character-assign-picker__create-icon"><PlusIcon aria-hidden="true" /></span>“{query.trim()}” 만들기</button></PickerSection>}
    </div>
    {activeScopeId && <button type="button" className="character-assign-picker__all-series" onClick={clearScope}>
      <span className="character-assign-picker__all-series-icon"><Squares2X2Icon aria-hidden="true" /></span><span>모든 시리즈</span><ChevronRightIcon aria-hidden="true" />
    </button>}
    {(message || confirmTargets) && <div className="character-assign-picker__message" role="status">
      {message ?? "시리즈가 다른 캐릭터 — 첫 캐릭터의 시리즈 폴더로 옮김"}
      {confirmTargets && <Button size="sm" onClick={() => { const chosen = confirmTargets; setConfirmTargets(null); void assign(chosen); }}>계속 넣기</Button>}
    </div>}
    {checkedTargets.length > 0 && <Button className="character-assign-picker__apply" size="sm" disabled={busy} onClick={() => void assign(checkedTargets)}>{checkedTargets.length.toLocaleString("ko-KR")}명에게 넣기</Button>}
    <div className="character-assign-picker__meta">누르면 바로 넣기 · Ctrl+클릭 여러 명 · 시리즈 폴더로 옮김</div>
  </div>;
}

function PickerSection({ label, children }: { label?: string; children: React.ReactNode }) {
  return <section className="character-assign-picker__section" role="group" aria-label={label}>
    {label && <SectionLabel className="character-assign-picker__section-label" title={label} />}
    {children}
  </section>;
}

function CharacterThumbnail({ target, privacyMode }: { target: CharacterTarget; privacyMode: boolean }) {
  const assetId = target.thumbnailAssetId ?? target.references.find(reference => reference.status === "ready")?.assetId;
  if (privacyMode || !assetId) return <span className={`character-assign-picker__thumbnail${privacyMode ? " character-assign-picker__thumbnail--private" : ""}`} aria-hidden="true" />;
  return <AssetImage className="character-assign-picker__thumbnail" src={thumbnailUrl(assetId)} alt="" draggable={false} />;
}

type SeriesGroup = ReturnType<typeof buildSeriesSections>[number]["groups"][number];

function buildSeriesSections(targets: CharacterTarget[], groups: CharacterGroup[], classifications: ClassificationEntry[], counts: Record<string, number>, extras?: CharacterTarget[], scopeSeriesId?: string) {
  const nameById = new Map(classifications.map(entry => [entry.id, entry.name]));
  const groupByTarget = new Map<string, CharacterGroup>();
  groups.forEach(group => group.targetIds.forEach(id => groupByTarget.set(id, group)));
  const bySeries = new Map<string, CharacterTarget[]>();
  // With 기타 offered, the open series is listed even when it has no character yet, and so is every
  // other series that has a group or a 기타 bucket (its characters may all be in the 기타).
  if (extras) {
    if (scopeSeriesId) bySeries.set(scopeSeriesId, []);
    groups.forEach(group => { if (!bySeries.has(group.seriesId)) bySeries.set(group.seriesId, []); });
    extras.forEach(target => { if (target.seriesClassificationId && !bySeries.has(target.seriesClassificationId)) bySeries.set(target.seriesClassificationId, []); });
  }
  targets.forEach(target => {
    if (!target.seriesClassificationId) return;
    const members = bySeries.get(target.seriesClassificationId) ?? [];
    members.push(target); bySeries.set(target.seriesClassificationId, members);
  });
  const sortTargets = (a: CharacterTarget, b: CharacterTarget) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0) || a.displayName.localeCompare(b.displayName, "ko");
  /** The series' or group's 기타 as the last row: the existing bucket, else one that is created when chosen. */
  const extrasRow = (seriesId: string, group: CharacterGroup | null, indented: boolean) => {
    if (!extras) return [];
    const existing = group
      ? extras.find(target => target.id === group.extrasTargetId || (target.extrasGroupId === group.id))
      : extras.find(target => target.seriesClassificationId === seriesId && !target.extrasGroupId);
    const target = existing ?? newExtras(seriesId, group?.id ?? null);
    return [{ key: `all:${seriesId}:${group?.id ?? ""}:extras`, target, right: formatCount(counts[target.id] ?? 0), indented }];
  };
  return [...bySeries].map(([id, members]) => {
    const seriesGroups = groups.filter(group => group.seriesId === id && (extras || group.targetIds.some(targetId => members.some(target => target.id === targetId))))
      .map(group => ({
        id: group.id,
        name: group.name,
        count: group.targetIds.reduce((sum, targetId) => sum + (counts[targetId] ?? 0), 0),
        characterCount: group.targetIds.filter(targetId => members.some(target => target.id === targetId && target.role !== "extras")).length,
        rows: [
          ...group.targetIds.flatMap(targetId => members.find(target => target.id === targetId) ?? []).sort(sortTargets)
            .map(target => ({ key: `all:${id}:${group.id}:${target.id}`, target, right: formatCount(counts[target.id] ?? 0), indented: true })),
          ...extrasRow(id, group, true),
        ],
      })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
    const ungrouped = [
      ...members.filter(target => !groupByTarget.has(target.id)).sort(sortTargets)
        .map(target => ({ key: `all:${id}:${target.id}`, target, right: formatCount(counts[target.id] ?? 0), indented: false })),
      ...extrasRow(id, null, false),
    ];
    return { id, name: nameById.get(id) ?? "시리즈 없음", count: members.reduce((sum, target) => sum + (counts[target.id] ?? 0), 0), groups: seriesGroups, ungrouped };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
}

function formatCount(value: number) { return value.toLocaleString("ko-KR"); }

function loadRecentIds(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CHARACTER_ASSIGN_RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))].slice(0, 5) : [];
  } catch { return []; }
}

function rememberRecentIds(assigned: string[], current: string[]): string[] {
  const next = [...new Set([...assigned, ...current])].slice(0, 5);
  try { localStorage.setItem(CHARACTER_ASSIGN_RECENT_KEY, JSON.stringify(next)); } catch { /* storage can be unavailable */ }
  return next;
}
