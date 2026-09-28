import { CheckIcon, MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { useEffect, useMemo, useState } from "react";
import { thumbnailUrl } from "../assets/mediaUrl";
import type { ClassificationEntry } from "../library/types";
import { matchesKoreanSearch } from "../shared/koreanSearch";
import { Button } from "../shared/ui/Button";
import { TextInput } from "../shared/ui/TextInput";
import { characterAssignSuggestions, type CharacterAssignSuggestion, type CharacterTarget } from "./api";
import type { CharacterGroup } from "./hubApi";
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
  loadSuggestions?: (assetIds: string[]) => Promise<CharacterAssignSuggestion[]>;
};

type PickerRow = {
  key: string;
  target: CharacterTarget;
  context?: string;
  right: string;
  indented?: boolean;
};

export function CharacterAssignPicker({ assetIds, targets, groups, classifications, counts, privacyMode, busy = false, onAssign, onClose, loadSuggestions = characterAssignSuggestions }: Props) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<CharacterAssignSuggestion[]>([]);
  const [recentIds, setRecentIds] = useState(loadRecentIds);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmTargets, setConfirmTargets] = useState<CharacterTarget[] | null>(null);
  const targetById = useMemo(() => new Map(targets.map(target => [target.id, target])), [targets]);
  const seriesName = (target: CharacterTarget) => classifications.find(entry => entry.id === target.seriesClassificationId)?.name ?? "시리즈 없음";

  useEffect(() => {
    let active = true;
    void loadSuggestions(assetIds).then(result => {
      if (!active) return;
      const next = result.filter(item => targetById.has(item.targetId)).sort((a, b) => b.matched - a.matched || a.targetId.localeCompare(b.targetId)).slice(0, 3);
      setSuggestions(next);
      if (next[0]) setHighlightKey(`recommended:${next[0].targetId}`);
    }).catch(() => { if (active) setSuggestions([]); });
    return () => { active = false; };
  }, [assetIds, loadSuggestions, targetById]);

  const recommendedRows = suggestions.flatMap(suggestion => {
    const target = targetById.get(suggestion.targetId);
    return target ? [{ key: `recommended:${target.id}`, target, context: seriesName(target), right: `${suggestion.total.toLocaleString("ko-KR")}장 중 ${suggestion.matched.toLocaleString("ko-KR")}장` }] : [];
  });
  const recentRows = recentIds.flatMap(id => {
    const target = targetById.get(id);
    return target ? [{ key: `recent:${target.id}`, target, context: seriesName(target), right: formatCount(counts[target.id] ?? 0) }] : [];
  });
  const seriesSections = useMemo(() => buildSeriesSections(targets, groups, classifications, counts), [classifications, counts, groups, targets]);
  const filteredRecommended = recommendedRows.filter(row => matchesKoreanSearch([row.target.displayName, row.context], query));
  const filteredRecent = recentRows.filter(row => matchesKoreanSearch([row.target.displayName, row.context], query));
  const filteredSeries = seriesSections.flatMap(section => {
    const grouped = section.groups.flatMap(group => {
      const rows = group.rows.filter(row => matchesKoreanSearch([row.target.displayName, section.name, group.name], query));
      return rows.length ? [{ ...group, rows }] : [];
    });
    const ungrouped = section.ungrouped.filter(row => matchesKoreanSearch([row.target.displayName, section.name], query));
    return grouped.length || ungrouped.length ? [{ ...section, groups: grouped, ungrouped }] : [];
  });
  const visibleRows = [
    ...filteredRecommended,
    ...filteredRecent,
    ...filteredSeries.flatMap(section => [...section.groups.flatMap(group => group.rows), ...section.ungrouped]),
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
    try { await onAssign(chosen); } catch { return; }
    const nextRecent = rememberRecentIds(chosen.map(target => target.id), recentIds);
    setRecentIds(nextRecent);
    onClose();
  };
  const toggleChecked = (id: string) => {
    setConfirmTargets(null); setMessage(null);
    setCheckedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  };
  const renderRow = (row: PickerRow) => {
    const checked = checkedIds.includes(row.target.id);
    return <button key={row.key} type="button" role="option" aria-selected={checked} aria-label={[row.target.displayName, row.context, row.right].filter(Boolean).join(" · ")}
      className={`character-assign-picker__row${row.indented ? " character-assign-picker__row--indented" : ""}`}
      data-highlighted={highlightKey === row.key || undefined}
      onPointerMove={() => setHighlightKey(row.key)}
      onClick={event => {
        if (event.ctrlKey || event.metaKey) toggleChecked(row.target.id);
        else void assign([row.target]);
      }}>
      <CharacterThumbnail target={row.target} privacyMode={privacyMode} />
      <span className="character-assign-picker__name">{row.target.displayName}{row.context && <small>{row.context}</small>}</span>
      <span className="character-assign-picker__count">{row.right}</span>
      {checked && <CheckIcon className="character-assign-picker__check" aria-hidden="true" />}
    </button>;
  };
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
  const checkedTargets = checkedIds.flatMap(id => targetById.get(id) ?? []);

  return <div className="character-assign-picker ui-menu" role="listbox" aria-label="캐릭터에 넣기" aria-multiselectable="true" onKeyDown={keyDown} onClick={event => event.stopPropagation()}>
    <TextInput autoFocus type="search" role="searchbox" aria-label="캐릭터 찾기" icon={MagnifyingGlassIcon} value={query} onChange={event => { setQuery(event.target.value); setConfirmTargets(null); setMessage(null); }} autoComplete="off" />
    <div className="character-assign-picker__scroll" data-native-scrollbar="true">
      {filteredRecommended.length > 0 && <PickerSection label="추천">{filteredRecommended.map(renderRow)}</PickerSection>}
      {filteredRecent.length > 0 && <PickerSection label="최근">{filteredRecent.map(renderRow)}</PickerSection>}
      {filteredSeries.map(section => <PickerSection key={section.id} label={section.name}>
        {section.groups.map(group => <div key={group.id} role="group" aria-label={group.name}>
          <div className="character-assign-picker__group-caption">{group.name}</div>
          {group.rows.map(renderRow)}
        </div>)}
        {section.ungrouped.map(renderRow)}
      </PickerSection>)}
      {visibleRows.length === 0 && <div className="character-assign-picker__empty">일치하는 캐릭터가 없습니다.</div>}
    </div>
    {(message || confirmTargets) && <div className="character-assign-picker__message" role="status">
      {message ?? "시리즈가 다른 캐릭터 — 첫 캐릭터의 시리즈 폴더로 옮김"}
      {confirmTargets && <Button size="sm" onClick={() => { const chosen = confirmTargets; setConfirmTargets(null); void assign(chosen); }}>계속 넣기</Button>}
    </div>}
    {checkedTargets.length > 0 && <Button className="character-assign-picker__apply" size="sm" disabled={busy} onClick={() => void assign(checkedTargets)}>{checkedTargets.length.toLocaleString("ko-KR")}명에게 넣기</Button>}
    <div className="character-assign-picker__meta">누르면 바로 넣기 · Ctrl+클릭 여러 명 · 시리즈 폴더로 옮김</div>
  </div>;
}

function PickerSection({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="character-assign-picker__section" role="group" aria-label={label}>
    <div className="character-assign-picker__section-label"><span aria-hidden="true" />{label}<i aria-hidden="true" /></div>
    {children}
  </section>;
}

function CharacterThumbnail({ target, privacyMode }: { target: CharacterTarget; privacyMode: boolean }) {
  const assetId = target.thumbnailAssetId ?? target.references.find(reference => reference.status === "ready")?.assetId;
  if (privacyMode || !assetId) return <span className={`character-assign-picker__thumbnail${privacyMode ? " character-assign-picker__thumbnail--private" : ""}`} aria-hidden="true" />;
  return <img className="character-assign-picker__thumbnail" src={thumbnailUrl(assetId)} alt="" draggable={false} />;
}

function buildSeriesSections(targets: CharacterTarget[], groups: CharacterGroup[], classifications: ClassificationEntry[], counts: Record<string, number>) {
  const nameById = new Map(classifications.map(entry => [entry.id, entry.name]));
  const groupByTarget = new Map<string, CharacterGroup>();
  groups.forEach(group => group.targetIds.forEach(id => groupByTarget.set(id, group)));
  const bySeries = new Map<string, CharacterTarget[]>();
  targets.forEach(target => {
    if (!target.seriesClassificationId) return;
    const members = bySeries.get(target.seriesClassificationId) ?? [];
    members.push(target); bySeries.set(target.seriesClassificationId, members);
  });
  const sortTargets = (a: CharacterTarget, b: CharacterTarget) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0) || a.displayName.localeCompare(b.displayName, "ko");
  return [...bySeries].map(([id, members]) => {
    const seriesGroups = groups.filter(group => group.seriesId === id && group.targetIds.some(targetId => members.some(target => target.id === targetId)))
      .map(group => ({
        id: group.id,
        name: group.name,
        count: group.targetIds.reduce((sum, targetId) => sum + (counts[targetId] ?? 0), 0),
        rows: group.targetIds.flatMap(targetId => members.find(target => target.id === targetId) ?? []).sort(sortTargets)
          .map(target => ({ key: `all:${id}:${group.id}:${target.id}`, target, right: formatCount(counts[target.id] ?? 0), indented: true })),
      })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
    const ungrouped = members.filter(target => !groupByTarget.has(target.id)).sort(sortTargets)
      .map(target => ({ key: `all:${id}:${target.id}`, target, right: formatCount(counts[target.id] ?? 0) }));
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
