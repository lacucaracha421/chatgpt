import type { ComponentType, SVGProps } from "react";
import {
  AcademicCapIcon,
  BoltIcon,
  BookOpenIcon,
  BookmarkIcon,
  BriefcaseIcon,
  CalendarIcon,
  ClockIcon,
  CubeIcon,
  FilmIcon,
  FireIcon,
  FolderIcon,
  GlobeAltIcon,
  HeartIcon,
  HomeIcon,
  MapIcon,
  MusicalNoteIcon,
  PhotoIcon,
  PuzzlePieceIcon,
  SparklesIcon,
  StarIcon,
  TagIcon,
  TrophyIcon,
  UserGroupIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import type { ClassificationKind } from "../library/types";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export const CLASSIFICATION_ICONS: ReadonlyArray<{
  key: string;
  label: string;
  icon: IconComponent;
}> = [
  { key: "folder", label: "폴더", icon: FolderIcon },
  { key: "photo", label: "사진", icon: PhotoIcon },
  { key: "film", label: "영상", icon: FilmIcon },
  { key: "music", label: "음악", icon: MusicalNoteIcon },
  { key: "book", label: "책", icon: BookOpenIcon },
  { key: "star", label: "별", icon: StarIcon },
  { key: "heart", label: "하트", icon: HeartIcon },
  { key: "user", label: "사람", icon: UserIcon },
  { key: "users", label: "사람들", icon: UserGroupIcon },
  { key: "academic-cap", label: "학습", icon: AcademicCapIcon },
  { key: "briefcase", label: "업무", icon: BriefcaseIcon },
  { key: "home", label: "집", icon: HomeIcon },
  { key: "globe", label: "세계", icon: GlobeAltIcon },
  { key: "map", label: "지도", icon: MapIcon },
  { key: "calendar", label: "달력", icon: CalendarIcon },
  { key: "clock", label: "시간", icon: ClockIcon },
  { key: "bookmark", label: "북마크", icon: BookmarkIcon },
  { key: "tag", label: "태그", icon: TagIcon },
  { key: "sparkles", label: "반짝임", icon: SparklesIcon },
  { key: "bolt", label: "번개", icon: BoltIcon },
  { key: "fire", label: "불꽃", icon: FireIcon },
  { key: "trophy", label: "트로피", icon: TrophyIcon },
  { key: "puzzle", label: "퍼즐", icon: PuzzlePieceIcon },
  { key: "cube", label: "큐브", icon: CubeIcon },
];

export const CLASSIFICATION_COLORS: ReadonlyArray<{
  key: string;
  label: string;
  value: string;
}> = [
  { key: "red", label: "빨강", value: "#ef6b73" },
  { key: "orange", label: "주황", value: "#f28c52" },
  { key: "amber", label: "호박", value: "#dba84b" },
  { key: "yellow", label: "노랑", value: "#c9b94d" },
  { key: "lime", label: "라임", value: "#8fbd52" },
  { key: "green", label: "초록", value: "#58b67a" },
  { key: "teal", label: "청록", value: "#47b6a7" },
  { key: "cyan", label: "하늘", value: "#4fabc9" },
  { key: "blue", label: "파랑", value: "#5b8def" },
  { key: "indigo", label: "남색", value: "#7c7ee8" },
  { key: "purple", label: "보라", value: "#aa75df" },
  { key: "pink", label: "분홍", value: "#df6fa7" },
];

const icons = new Map(CLASSIFICATION_ICONS.map((item) => [item.key, item.icon]));
const colors = new Map(CLASSIFICATION_COLORS.map((item) => [item.key, item.value]));

export function classificationColor(colorKey: string | null): string {
  return (colorKey && colors.get(colorKey)) ?? "var(--color-muted)";
}

type ClassificationIconProps = SVGProps<SVGSVGElement> & {
  kind: ClassificationKind;
  iconKey: string | null;
};

export function ClassificationIcon({
  kind,
  iconKey,
  ...props
}: ClassificationIconProps) {
  const fallbackKey = kind === "work" ? "book" : "folder";
  const resolvedKey = iconKey && icons.has(iconKey) ? iconKey : fallbackKey;
  const Icon = icons.get(resolvedKey) ?? FolderIcon;

  return (
    <Icon
      {...props}
      data-icon-key={resolvedKey}
      data-testid="classification-icon"
      aria-hidden="true"
    />
  );
}
