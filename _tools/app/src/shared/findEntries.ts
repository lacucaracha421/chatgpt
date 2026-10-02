import type { ReactNode } from "react";

/** search: the current view's own search (palette only); tag: 자동 태그 filters for the 에셋 screen (palette only, while typing); place: folders, albums and characters by name (palette only, while typing); queue: non-empty review queues; go: destinations; action: commands; settings: settings sections (palette only). */
export type NavigationEntryGroup = "search" | "work" | "artist" | "note" | "recent" | "tag" | "place" | "queue" | "go" | "action" | "settings";

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
  thumbnail?: string;
  avatar?: boolean;
  run: () => void;
  /** Shift+Enter or Shift+click, e.g. exclude a tag instead of including it. */
  runAlternate?: () => void;
};

export const NAVIGATION_GROUP_LABELS: Record<NavigationEntryGroup, string> = {
  search: "이 화면에서",
  work: "작품",
  artist: "작가",
  note: "메모",
  recent: "최근 연 것",
  tag: "자동 태그",
  place: "폴더",
  queue: "확인할 것",
  go: "이동",
  action: "실행",
  settings: "설정",
};


export const FIND_WORK_TYPE_LABEL = { game: "게임", manga: "만화", movie: "영화", av: "AV" };
