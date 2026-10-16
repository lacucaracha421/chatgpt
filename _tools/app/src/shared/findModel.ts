import { createKoreanMatcher, normalizeSearchText, matchesKoreanSearch } from "./koreanSearch";
import naturalLanguageSearchEnabled from "../../nl-search-runtime/enabled.json";
import type { NavigationEntry, NavigationEntryGroup } from "./findEntries";

export const FIND_SCOPES = ["전체", "작품", "폴더·캐릭터", "태그", "작가", "메모", "메뉴"] as const;
export type FindScope = typeof FIND_SCOPES[number];
export type FindTab = "assets" | "home" | "collections" | "manga" | "notes" | "menu";
export type FindContext = { tab: FindTab; workType?: "game" | "manga" | "movie" | "av" };
export const GROUP_LIMIT = 5;
export const RECENT_LIMIT = 5;
const recentMemory = new Map<string, string[]>();
const RECENT_STORAGE = "lakomics.find.recent.v1:";
const HOME_ORDER: NavigationEntryGroup[] = ["work", "place", "tag", "artist", "note", "menu"];
const TAB_ORDER: Record<FindTab, NavigationEntryGroup[]> = {
  assets: ["place", "tag", "artist", "work", "note", "menu"],
  home: HOME_ORDER,
  collections: ["work", "search", "place", "artist", "tag", "note", "menu"],
  manga: ["work", "search", "menu", "place", "tag", "artist", "note"],
  notes: ["note", "search", "menu", "work", "place", "tag", "artist"],
  menu: ["menu", "search", "work", "place", "tag", "artist", "note"],
};
export function allowsSceneSearch(tab: FindTab) { return naturalLanguageSearchEnabled && (tab === "assets" || tab === "home"); }
export function findPlaceholder(tab: FindTab) {
  return { assets: "캐릭터, 폴더, 태그 찾기", collections: "작품 찾기", manga: "망가 제목 찾기", notes: "메모 찾기", home: "작품, 캐릭터, 폴더, 태그 찾기", menu: "메뉴, 작품, 폴더 찾기" }[tab];
}
function normalizedGroup(group: NavigationEntryGroup): NavigationEntryGroup {
  return ["go", "action", "settings", "queue"].includes(group) ? "menu" : group;
}
export function entryScope(entry: NavigationEntry): FindScope {
  if (entry.group === "work") return "작품";
  if (entry.group === "artist") return "작가";
  if (entry.group === "note") return "메모";
  if (entry.group === "place") return "폴더·캐릭터";
  if (entry.group === "tag") return "태그";
  return entry.group === "content" ? "전체" : "메뉴";
}
/** Literal name/alias matches are strong; substring and Korean initials remain weak. */
export function nameMatchRank(entry: NavigationEntry, query: string): number {
  const needle = normalizeSearchText(query);
  return Math.min(3, ...[entry.label, ...(entry.keywords ?? [])].map(field => {
    const value = normalizeSearchText(field);
    if (value === needle) return 0;
    if (value.startsWith(needle)) return 1;
    const words = field.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.some((_, index) => normalizeSearchText(words.slice(index).join(" ")).startsWith(needle))) return 2;
    return 3;
  }));
}
function placeOrder(entry: NavigationEntry) {
  if (entry.placeKind) return { character: 0, folder: 1, album: 2 }[entry.placeKind];
  return entry.id.startsWith("place-character-") ? 0 : entry.id.startsWith("place-folder-") ? 1 : 2;
}
export function findGroups(entries: NavigationEntry[], query: string, scope: FindScope, recentIds: string[], context: FindContext = { tab: "home" }) {
  const typed = query.trim();
  const accepts = (entry: NavigationEntry) => entry.group === "content"
    ? scope === "전체" && allowsSceneSearch(context.tab)
    : scope === "전체" || entry.group === "search" || entryScope(entry) === scope;
  if (!typed) {
    const queues = entries.filter(entry => accepts(entry) && (entry.group === "queue" || entry.group === "search"));
    const recent = recentIds.flatMap(id => {
      const entry = entries.find(candidate => candidate.id === id);
      return entry && accepts(entry) && entry.group !== "queue" ? [entry] : [];
    }).slice(0, RECENT_LIMIT);
    return ["search", "queue", "recent"].flatMap(group => {
      const items = group === "recent" ? recent : queues.filter(entry => entry.group === group);
      return items.length ? [{ group: group as NavigationEntryGroup, items }] : [];
    });
  }
  const order = TAB_ORDER[context.tab];
  const matcher = createKoreanMatcher(typed);
  const visible = entries.filter(entry => accepts(entry) && (entry.group === "search" || entry.group === "content" || matcher([entry.label, ...(entry.keywords ?? [])])));
  const rank = new Map(visible.map(entry => [entry.id, nameMatchRank(entry, typed)]));
  const groupRank = (entry: NavigationEntry) => {
    // Only manga works occupy Manga's first priority; other work types follow its menu.
    if (context.tab === "manga" && entry.group === "work" && entry.workType !== "manga") return 2.5;
    const at = order.indexOf(normalizedGroup(entry.group));
    return at < 0 ? order.length : at;
  };
  const compare = (a: NavigationEntry, b: NavigationEntry) => {
    const recentRank = (entry: NavigationEntry) => { const at = recentIds.indexOf(entry.id); return at < 0 ? Infinity : at; };
    const sameName = normalizeSearchText(a.label) === normalizeSearchText(b.label);
    return groupRank(a) - groupRank(b)
      || (context.tab === "collections" && a.group === "work" && b.group === "work" && context.workType ? Number(b.workType === context.workType) - Number(a.workType === context.workType) : 0)
      || rank.get(a.id)! - rank.get(b.id)!
      || (context.tab === "assets" && sameName && a.group === "place" && b.group === "place" ? placeOrder(a) - placeOrder(b) : 0)
      || ((recentRank(a) === recentRank(b)) ? 0 : recentRank(a) < recentRank(b) ? -1 : 1)
      || (b.count ?? 0) - (a.count ?? 0)
      || a.label.length - b.label.length
      || a.label.localeCompare(b.label, "ko");
  };
  const names = visible.filter(entry => entry.group !== "content" && entry.group !== "search");
  const strong = names.filter(entry => rank.get(entry.id)! < 3).sort(compare);
  const weak = names.filter(entry => rank.get(entry.id)! >= 3).sort(compare);
  const search = visible.filter(entry => entry.group === "search");
  const content = visible.filter(entry => entry.group === "content");
  const screenSearch = search.find(entry => !entry.id.endsWith("clear"));
  // Asset and Home put the scene search ahead of the view's own search; the other tabs do the reverse.
  const best = strong[0] ?? (allowsSceneSearch(context.tab) ? content[0] ?? screenSearch : screenSearch ?? content[0]) ?? weak[0];
  const groups: { group: NavigationEntryGroup; items: NavigationEntry[] }[] = best ? [{ group: "best", items: [best] }] : [];
  // Keep strength tiers separate so a weak result in the preferred group cannot precede a strong one elsewhere.
  const append = (rows: NavigationEntry[]) => {
    for (const entry of rows) {
      if (entry === best) continue;
      const group = normalizedGroup(entry.group);
      const previous = groups[groups.length - 1];
      if (previous?.group === group) previous.items.push(entry);
      else groups.push({ group, items: [entry] });
    }
  };
  append([...strong, ...search].sort((a, b) => groupRank(a) - groupRank(b) || (a.group === "search" || b.group === "search" ? 0 : compare(a, b))));
  append(weak);
  append(content);
  return groups;
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
