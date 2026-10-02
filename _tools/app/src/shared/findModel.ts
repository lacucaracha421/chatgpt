import { matchesKoreanSearch } from "./koreanSearch";
import type { NavigationEntry, NavigationEntryGroup } from "./findEntries";

export const FIND_SCOPES = ["전체", "작품", "작가", "메모", "폴더", "화면", "명령"] as const;
export type FindScope = typeof FIND_SCOPES[number];
export const FIND_GROUP_ORDER: NavigationEntryGroup[] = ["search", "work", "artist", "note", "place", "queue", "recent", "go", "action"];
export const GROUP_LIMIT = 5;
export const RECENT_LIMIT = 5;
const recentMemory = new Map<string, string[]>();
const RECENT_STORAGE = "lakomics.find.recent.v1:";

export function entryScope(entry: NavigationEntry): FindScope {
  if (entry.group === "work") return "작품";
  if (entry.group === "artist") return "작가";
  if (entry.group === "note") return "메모";
  if (entry.group === "place") return "폴더";
  if (entry.group === "action" || entry.group === "tag") return "명령";
  return "화면";
}

export function findGroups(entries: NavigationEntry[], query: string, scope: FindScope, recentIds: string[]) {
  const typed = query.trim();
  const accepts = (entry: NavigationEntry) => scope === "전체" || entry.group === "search" || entryScope(entry) === scope;
  const visible = typed
    ? entries.filter(entry => accepts(entry) && (entry.group === "search" || matchesKoreanSearch([entry.label, ...(entry.keywords ?? [])], typed)))
    : [...entries.filter(entry => accepts(entry) && (entry.group === "queue" || entry.group === "search")),
      ...recentIds.flatMap(id => {
        const entry = entries.find(candidate => candidate.id === id);
        return entry && accepts(entry) && entry.group !== "queue" ? [{ ...entry, group: "recent" as const }] : [];
      }).slice(0, RECENT_LIMIT)];
  const grouped = visible.map(entry => entry.group === "settings" || (typed && entry.group === "queue")
    ? { ...entry, group: "go" as const } : entry.group === "tag" ? { ...entry, group: "action" as const } : entry);
  return FIND_GROUP_ORDER.flatMap(group => {
    const items = grouped.filter(entry => entry.group === group);
    return items.length ? [{ group, items }] : [];
  });
}

/** Persist identifiers only. Resolve names and permissions again from the active library. */
export function readRecent(key: string): string[] {
  if (recentMemory.has(key)) return recentMemory.get(key)!;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_STORAGE + key) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))].slice(0, RECENT_LIMIT) : [];
  } catch { return recentMemory.get(key) ?? []; }
}
export function rememberRecent(key: string, id: string) {
  const next = [id, ...readRecent(key).filter(previous => previous !== id)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_STORAGE + key, JSON.stringify(next));
    recentMemory.delete(key);
  } catch { recentMemory.set(key, next); }
  return next;
}

/** Highlight the shortest matching spans, including Korean initials and an unfinished syllable. */
export function matchedSpans(label: string, query: string): { text: string; matched: boolean }[] {
  const chars = Array.from(label);
  const marked = new Set<number>();
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    if (!matchesKoreanSearch(label, token)) continue;
    const candidates: { start: number; end: number }[] = [];
    for (let start = 0; start < chars.length; start += 1) {
      for (let end = start + 1; end <= chars.length; end += 1) {
        if (!matchesKoreanSearch(chars.slice(start, end).join(""), token)) continue;
        candidates.push({ start, end });
        break;
      }
    }
    candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start));
    const occupied = new Set<number>();
    for (const { start, end } of candidates) {
      if (Array.from({ length: end - start }, (_, at) => start + at).some(at => occupied.has(at))) continue;
      for (let at = start; at < end; at += 1) { occupied.add(at); marked.add(at); }
    }
  }
  const spans: { text: string; matched: boolean }[] = [];
  chars.forEach((char, index) => {
    const matched = marked.has(index);
    const previous = spans[spans.length - 1];
    if (previous?.matched === matched) previous.text += char;
    else spans.push({ text: char, matched });
  });
  return spans;
}
