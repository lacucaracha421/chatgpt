import type { ComponentType, SVGProps } from "react";
import {
  AcademicCapIcon,
  ArchiveBoxIcon,
  BellIcon,
  BoltIcon,
  BookOpenIcon,
  BookmarkIcon,
  BriefcaseIcon,
  CalendarIcon,
  CameraIcon,
  ChatBubbleLeftIcon,
  ClockIcon,
  CloudIcon,
  CubeIcon,
  DocumentIcon,
  DocumentTextIcon,
  EyeIcon,
  FaceSmileIcon,
  FilmIcon,
  FireIcon,
  FlagIcon,
  FolderIcon,
  GiftIcon,
  GlobeAltIcon,
  HeartIcon,
  HomeIcon,
  InboxIcon,
  KeyIcon,
  LightBulbIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  MapIcon,
  MicrophoneIcon,
  MoonIcon,
  MusicalNoteIcon,
  PaintBrushIcon,
  PhotoIcon,
  PuzzlePieceIcon,
  RocketLaunchIcon,
  SparklesIcon,
  SpeakerWaveIcon,
  StarIcon,
  SunIcon,
  TagIcon,
  TrophyIcon,
  TvIcon,
  UserGroupIcon,
  UserIcon,
  VideoCameraIcon,
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
  { key: "camera", label: "카메라", icon: CameraIcon },
  { key: "video", label: "비디오", icon: VideoCameraIcon },
  { key: "tv", label: "TV", icon: TvIcon },
  { key: "mic", label: "마이크", icon: MicrophoneIcon },
  { key: "speaker", label: "스피커", icon: SpeakerWaveIcon },
  { key: "document", label: "문서", icon: DocumentIcon },
  { key: "doc-text", label: "글", icon: DocumentTextIcon },
  { key: "archive", label: "보관함", icon: ArchiveBoxIcon },
  { key: "inbox", label: "수신함", icon: InboxIcon },
  { key: "gift", label: "선물", icon: GiftIcon },
  { key: "flag", label: "깃발", icon: FlagIcon },
  { key: "bell", label: "알림", icon: BellIcon },
  { key: "moon", label: "달", icon: MoonIcon },
  { key: "sun", label: "태양", icon: SunIcon },
  { key: "cloud", label: "구름", icon: CloudIcon },
  { key: "eye", label: "눈", icon: EyeIcon },
  { key: "key", label: "열쇠", icon: KeyIcon },
  { key: "lock", label: "자물쇠", icon: LockClosedIcon },
  { key: "search", label: "검색", icon: MagnifyingGlassIcon },
  { key: "brush", label: "브러시", icon: PaintBrushIcon },
  { key: "chat", label: "채팅", icon: ChatBubbleLeftIcon },
  { key: "smile", label: "스마일", icon: FaceSmileIcon },
  { key: "idea", label: "아이디어", icon: LightBulbIcon },
  { key: "rocket", label: "로켓", icon: RocketLaunchIcon },
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
