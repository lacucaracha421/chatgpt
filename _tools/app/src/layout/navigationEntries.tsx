import type { ReactNode } from "react";
import { nativeWorkload, updateWorkloadSettings, useWorkloadProfile } from "../app/workloadProfile";
import type { AlbumEntry, AssetView, ClassificationEntry } from "../library/types";
import { ActivityIcon, BookmarkIcon, CalendarIcon, Cog6ToothIcon, FolderIcon, InboxIcon, NoteIcon, PersonIcon, PhotoIcon, PlusIcon, RectangleStackIcon, TrashIcon } from "../shared/ui/ArchiveIcons";

/** search: the current view's own search (palette only); place: folders, albums and characters by name (palette only, while typing); queue: non-empty review queues; go: destinations; action: commands; settings: settings sections (palette only). */
export type NavigationEntryGroup = "search" | "place" | "queue" | "go" | "action" | "settings";

export type NavigationEntry = {
  id: string;
  group: NavigationEntryGroup;
  label: string;
  icon: ReactNode;
  count?: number;
  /** Extra names the palette also matches, e.g. an English term or a longer Korean name. */
  keywords?: string[];
  /** Background activity for this destination, e.g. a running Private Vault import. */
  activity?: string;
  /** Where the destination lives, e.g. a folder path "게임 › 젠레스". */
  context?: string;
  selected?: boolean;
  run: () => void;
};

export const NAVIGATION_GROUP_LABELS: Record<NavigationEntryGroup, string> = {
  search: "검색",
  place: "폴더·앨범·캐릭터",
  queue: "확인할 것",
  go: "이동",
  action: "실행",
  settings: "설정",
};

type SettingsSection = NonNullable<Extract<AssetView, { kind: "settings" }>["section"]>;
const SETTINGS_SECTIONS = [
  ["general", "일반"], ["library", "라이브러리"], ["cloud", "클라우드"], ["catalog", "온라인 카탈로그"],
  ["external_services", "연결"], ["data", "데이터 관리"], ["about", "정보·도움말"], ["advanced", "고급"],
] as const satisfies readonly (readonly [SettingsSection, string])[];

const REVISIT_KINDS: AssetView["kind"][] = ["revisit", "creators", "creator", "calendar", "revisited-bundle"];

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
  const go = (next: AssetView) => () => onNavigate(next);
  const queued = (count: number | null) => (count ?? 0) > 0;
  const entries: NavigationEntry[] = [
    { id: "review", group: queued(reviewCount) ? "queue" : "go", label: "유사 검토", keywords: ["유사 이미지 검토", "중복"], icon: <PhotoIcon />, count: queued(reviewCount) ? reviewCount : undefined, selected: view.kind === "similarity_review", run: go({ kind: "similarity_review" }) },
    { id: "unsorted", group: queued(unsortedCount) ? "queue" : "go", label: "미분류", icon: <InboxIcon />, count: queued(unsortedCount) ? unsortedCount ?? undefined : undefined, selected: view.kind === "unsorted", run: go({ kind: "unsorted" }) },
    { id: "notes", group: "go", label: "메모", icon: <NoteIcon />, selected: view.kind === "notes", run: go({ kind: "notes" }) },
    ...(privateVaultAvailable ? [{ id: "private_vault", group: "go" as const, label: "비밀", keywords: ["비밀 보관함"], icon: <BookmarkIcon />, activity: privateVaultActivity, selected: view.kind === "private_vault", run: go({ kind: "private_vault" }) }] : []),
    { id: "revisit", group: "go", label: "다시보기", icon: <CalendarIcon />, selected: REVISIT_KINDS.includes(view.kind), run: go({ kind: "revisit" }) },
    { id: "statistics", group: "go", label: "통계", icon: <ActivityIcon />, selected: view.kind === "statistics", run: go({ kind: "statistics" }) },
    { id: "trash", group: "go", label: "휴지통", icon: <TrashIcon />, count: trashCount > 0 ? trashCount : undefined, selected: view.kind === "trash", run: go({ kind: "trash" }) },
    { id: "settings", group: "go", label: "설정", icon: <Cog6ToothIcon />, selected: view.kind === "settings", run: go({ kind: "settings" }) },
  ];
  const queues = entries.filter((entry) => entry.group === "queue");
  const destinations = entries.filter((entry) => entry.group === "go");
  const actions: NavigationEntry[] = [
    ...(onImportFiles ? [{ id: "import", group: "action" as const, label: "파일 가져오기", icon: <PlusIcon />, run: onImportFiles }] : []),
    ...(nativeWorkload() && workload.ready ? [{
      id: "lightweight", group: "action" as const, label: workload.lightweight ? "가벼운 모드 끄기" : "가벼운 모드 켜기", keywords: ["가벼운 모드"], icon: <ActivityIcon />,
      run: () => { void updateWorkloadSettings({ lightweight: !workload.lightweight }); },
    }] : []),
  ];
  const settings: NavigationEntry[] = SETTINGS_SECTIONS.map(([section, label]) => ({
    id: `settings-${section}`, group: "settings", label: `설정 · ${label}`, icon: <Cog6ToothIcon />, run: go({ kind: "settings", section }),
  }));
  return [...queues, ...destinations, ...actions, ...settings];
}

/** Case-insensitive substring match on the label and keywords. */
export function matchesEntry(entry: NavigationEntry, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [entry.label, ...(entry.keywords ?? [])].some((name) => name.toLocaleLowerCase().replace(/\s+/g, "").includes(needle.replace(/\s+/g, "")));
}

/** Named places the palette can jump to: the folder tree, albums and characters already loaded by the app. */
export type PlaceSources = {
  classifications: ClassificationEntry[];
  albums: AlbumEntry[];
  characters?: { id: string; displayName: string; seriesClassificationId: string | null }[];
  /** Group members are hidden from the folder tree, so the palette shows the group in their path. */
  characterGroups?: { id: string; name: string; seriesId: string; targetIds: string[] }[];
};

const PLACE_LIMIT = 8;

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
 * ("게임 › 젠레스") as context. Names starting with the text come first; at most eight rows.
 */
export function placeEntries(sources: PlaceSources | undefined, query: string, view: AssetView, onNavigate: (view: AssetView) => void): NavigationEntry[] {
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, "");
  if (!sources || !needle) return [];
  const folders = new Map(sources.classifications.map((entry) => [entry.id, entry]));
  const albums = new Map(sources.albums.map((entry) => [entry.id, entry]));
  type Candidate = { entry: NavigationEntry; name: string };
  const candidates: Candidate[] = [];
  const add = (name: string, entry: NavigationEntry) => {
    if (name.toLocaleLowerCase().replace(/\s+/g, "").includes(needle)) candidates.push({ name, entry });
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
      id: `place-character-${character.id}`, group: "place", label: character.displayName, icon: <PersonIcon />,
      context: [...ancestorNames(folders, series.parentId), series.name, ...(group ? [group.name] : [])].join(" › "),
      selected: view.kind === "classification" && view.characterId === character.id,
      run: () => onNavigate({ kind: "classification", classificationId: seriesId, characterId: character.id }),
    });
  }
  const starts = (candidate: Candidate) => candidate.name.toLocaleLowerCase().replace(/\s+/g, "").startsWith(needle) ? 0 : 1;
  return candidates
    .sort((a, b) => starts(a) - starts(b) || a.name.length - b.name.length || a.name.localeCompare(b.name, "ko"))
    .slice(0, PLACE_LIMIT)
    .map((candidate) => candidate.entry);
}
