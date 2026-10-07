import { matchesKoreanSearch } from "../shared/koreanSearch";
import { nativeWorkload, updateWorkloadSettings, useWorkloadProfile } from "../app/workloadProfile";
import type { AlbumEntry, AssetView, ClassificationEntry } from "../library/types";
import { useExchangeSnapshot } from "../exchange/exchangeStore";
import { ChartBarIcon, FolderIcon, InboxIcon, PlusIcon, RectangleStackIcon, Square2StackIcon, TrashIcon, UserIcon } from "@heroicons/react/24/outline";
import { AREA_ICONS } from "../shared/ui/areaIcons";
import { useSyncExternalStore } from "react";
import { useOptionalLibrary } from "../library/LibraryContext";
import { notesStore } from "../notes/store";
import { deletedTrashNotes } from "../safety/trashSections";
import { collectionTrashCount, subscribeTrashCounts } from "../safety/trashCounts";

import { type NavigationEntry } from "../shared/findEntries";
export { NAVIGATION_GROUP_LABELS, type NavigationEntry, type NavigationEntryGroup } from "../shared/findEntries";

type SettingsSection = NonNullable<Extract<AssetView, { kind: "settings" }>["section"]>;
const SETTINGS_SECTIONS = [
  ["frequent", "자주 쓰는 것"], ["display", "화면"], ["library", "라이브러리"], ["connection", "연결"],
  ["catalog", "카탈로그"], ["vault", "보관함"], ["advanced", "고급"],
] as const satisfies readonly (readonly [SettingsSection, string])[];

const ARTIST_KINDS: AssetView["kind"][] = ["artists", "creator"];
const noSubscription = () => () => {};

export type NavigationEntryOptions = {
  view: AssetView;
  onNavigate: (view: AssetView) => void;
  reviewCount: number;
  /** Null while the count has not been read. */
  unsortedCount: number | null;
  trashCount: number;
  privateVaultAvailable: boolean;
  privateVaultActivity?: string;
  onImportFiles?: () => void;
};

/**
 * Destinations and commands shared by the 더보기 panel and the 찾기 palette (rail items such as 메모 are filtered out of 더보기).
 * Review queues are listed first only while they have a count; otherwise they stay reachable as plain destinations.
 */
export function useNavigationEntries({ view, onNavigate, reviewCount, unsortedCount, trashCount, privateVaultAvailable, privateVaultActivity, onImportFiles }: NavigationEntryOptions): NavigationEntry[] {
  const workload = useWorkloadProfile();
  const received = useExchangeSnapshot().unseen;
  const root = useOptionalLibrary()?.library?.root;
  const store = root ? notesStore(root) : null;
  const notesCount = useSyncExternalStore(store?.subscribe ?? noSubscription, () => deletedTrashNotes(store?.snapshot().notes ?? []).length);
  const collections = useSyncExternalStore(subscribeTrashCounts, () => root ? collectionTrashCount(root) : 0);
  // Only use already-cached counts; opening 더보기 must never fetch the trash.
  const totalTrashCount = trashCount + collections + notesCount;
  const go = (next: AssetView) => () => onNavigate(next);
  const queued = (count: number | null) => (count ?? 0) > 0;
  const entries: NavigationEntry[] = [
    { id: "review", group: queued(reviewCount) ? "queue" : "go", label: "유사 검토", keywords: ["유사 이미지 검토", "중복"], icon: <Square2StackIcon />, count: queued(reviewCount) ? reviewCount : undefined, selected: view.kind === "similarity_review", run: go({ kind: "similarity_review" }) },
    { id: "unsorted", group: queued(unsortedCount) ? "queue" : "go", label: "미분류", icon: <InboxIcon />, count: queued(unsortedCount) ? unsortedCount ?? undefined : undefined, selected: view.kind === "unsorted", run: go({ kind: "unsorted" }) },
    { id: "notes", group: "go", label: "메모", icon: <AREA_ICONS.notes />, selected: view.kind === "notes", run: go({ kind: "notes" }) },
    // Utility outside the Library: listed as a queue only while received files are unseen.
    { id: "exchange", group: queued(received) ? "queue" : "go", label: "전송", keywords: ["보내기/받기", "파일 보내기", "파일 받기", "받은 파일", "태블릿"], icon: <AREA_ICONS.exchange />, count: queued(received) ? received : undefined, selected: view.kind === "exchange", run: go({ kind: "exchange" }) },
    ...(privateVaultAvailable ? [{ id: "private_vault", group: "go" as const, label: "비밀", keywords: ["비밀 보관함"], icon: <AREA_ICONS.private_vault />, activity: privateVaultActivity, selected: view.kind === "private_vault", run: go({ kind: "private_vault" }) }] : []),
    { id: "artists", group: "go", label: "작가", keywords: ["다시보기", "작가 미상", "artist"], icon: <AREA_ICONS.artists />, selected: ARTIST_KINDS.includes(view.kind), run: go({ kind: "artists" }) },
    { id: "statistics", group: "go", label: "통계", icon: <ChartBarIcon />, selected: view.kind === "statistics", run: go({ kind: "statistics" }) },
    { id: "trash", group: "go", label: "휴지통", icon: <TrashIcon />, count: totalTrashCount > 0 ? totalTrashCount : undefined, selected: view.kind === "trash", run: go({ kind: "trash" }) },
    { id: "settings", group: "go", label: "설정", icon: <AREA_ICONS.settings />, selected: view.kind === "settings", run: go({ kind: "settings" }) },
  ];
  const queues = entries.filter((entry) => entry.group === "queue");
  const destinations = entries.filter((entry) => entry.group === "go");
  const actions: NavigationEntry[] = [
    ...(onImportFiles ? [{ id: "import", group: "action" as const, label: "파일 가져오기", icon: <PlusIcon />, run: onImportFiles }] : []),
    ...(nativeWorkload() && workload.ready ? [{
      id: "lightweight", group: "action" as const, label: workload.lightweight ? "절약 모드 끄기" : "절약 모드 켜기", keywords: ["절약 모드"], icon: <ChartBarIcon />,
      run: () => { void updateWorkloadSettings({ lightweight: !workload.lightweight }); },
    }] : []),
  ];
  const settings: NavigationEntry[] = SETTINGS_SECTIONS.map(([section, label]) => ({
    id: `settings-${section}`, group: "settings", label: `설정 · ${label}`, icon: <AREA_ICONS.settings />, run: go({ kind: "settings", section }),
  }));
  return [...queues, ...destinations, ...actions, ...settings];
}

/** Korean-aware name and keyword match, shared with the palette. */
export function matchesEntry(entry: NavigationEntry, query: string) {
  return matchesKoreanSearch([entry.label, ...(entry.keywords ?? [])], query);
}

/** Named places the palette can jump to: the folder tree, albums and characters already loaded by the app. */
export type PlaceSources = {
  classifications: ClassificationEntry[];
  albums: AlbumEntry[];
  characters?: { id: string; displayName: string; seriesClassificationId: string | null }[];
  /** Group members are hidden from the folder tree, so the palette shows the group in their path. */
  characterGroups?: { id: string; name: string; seriesId: string; targetIds: string[] }[];
};

function ancestorNames<T extends { id: string; name: string; parentId: string | null }>(byId: Map<string, T>, parentId: string | null): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = parentId ? byId.get(parentId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names;
}

/**
 * Folder, album and character rows whose name matches the typed text, with their path
 * ("게임 › 젠레스") as context. Names starting with the text come first; the palette limits and expands each group.
 */
export function placeEntries(sources: PlaceSources | undefined, query: string, view: AssetView, onNavigate: (view: AssetView) => void): NavigationEntry[] {
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, "");
  if (!sources) return [];
  const folders = new Map(sources.classifications.map((entry) => [entry.id, entry]));
  const albums = new Map(sources.albums.map((entry) => [entry.id, entry]));
  type Candidate = { entry: NavigationEntry; name: string };
  const candidates: Candidate[] = [];
  const add = (name: string, entry: NavigationEntry) => {
    if (matchesKoreanSearch(name, query)) candidates.push({ name, entry });
  };
  for (const folder of sources.classifications) {
    add(folder.name, {
      id: `place-folder-${folder.id}`, group: "place", label: folder.name, icon: <FolderIcon />,
      context: ancestorNames(folders, folder.parentId).join(" › ") || "폴더",
      selected: view.kind === "classification" && view.classificationId === folder.id && !view.characterId && !view.characterGroupId,
      run: () => onNavigate({ kind: "classification", classificationId: folder.id }),
    });
  }
  for (const album of sources.albums) {
    add(album.name, {
      id: `place-album-${album.id}`, group: "place", label: album.name, icon: <RectangleStackIcon />,
      context: ["앨범", ...ancestorNames(albums, album.parentId)].join(" › "),
      selected: view.kind === "album" && view.albumId === album.id,
      run: () => onNavigate({ kind: "album", albumId: album.id }),
    });
  }
  for (const character of sources.characters ?? []) {
    const seriesId = character.seriesClassificationId;
    const series = seriesId ? folders.get(seriesId) : undefined;
    if (!seriesId || !series) continue;
    const group = sources.characterGroups?.find((candidate) => candidate.seriesId === seriesId && candidate.targetIds.includes(character.id));
    add(character.displayName, {
      id: `place-character-${character.id}`, group: "place", label: character.displayName, icon: <UserIcon />,
      context: [...ancestorNames(folders, series.parentId), series.name, ...(group ? [group.name] : [])].join(" › "),
      selected: view.kind === "classification" && view.characterId === character.id,
      run: () => onNavigate({ kind: "classification", classificationId: seriesId, characterId: character.id }),
    });
  }
  const starts = (candidate: Candidate) => candidate.name.toLocaleLowerCase().replace(/\s+/g, "").startsWith(needle) ? 0 : 1;
  return candidates
    .sort((a, b) => starts(a) - starts(b) || a.name.length - b.name.length || a.name.localeCompare(b.name, "ko"))
    .map((candidate) => candidate.entry);
}
