/**
 * One action list per target, shared by the PC context menus and the tablet's long-press sheet
 * (TABLET-STRUCT-001, DESIGN §12 "Words"). This module owns what an item is called, its icon key,
 * whether it is destructive, PC-only, or switched off right now. Each client binds the items to its own
 * operations with `bindMenuItems` (PC) or `bindSheetItems` (tablet): an item without a handler is
 * left out, which is how an operation a client does not have yet stays off its menu.
 *
 * Wording decisions fixed here: 이름 바꾸기 (never 이름 변경), 휴지통으로 for every restorable delete.
 */

/** Icon keys; each client maps them to its own icon set (the tablet uses Heroicons outline). */
export type ActionIcon =
  | "pin" | "pencil" | "plus" | "palette" | "move" | "trash" | "sparkles" | "hide" | "show" | "merge"
  | "container" | "copy" | "album" | "info" | "remove" | "cover" | "compare" | "refresh" | "order";

export type ActionDef = {
  id: string;
  label: string;
  icon: ActionIcon;
  /** Destructive items sit last, apart from the rest. */
  danger?: boolean;
  /** Not offered on the tablet (a heavy or desktop-only operation). */
  pcOnly?: boolean;
  /** Visible but cannot run right now. */
  disabled?: boolean;
  /** A standalone check state (the PC menu shows a mark). */
  checked?: boolean;
  /** A keyboard hint on the PC menu. */
  shortcut?: string;
  /** A heading row without an operation (for example the selection count); the PC shows it dimmed. */
  inert?: boolean;
};

export type ActionChoice = { id: string; label: string; run: () => void; disabled?: boolean };
/** An operation, or an operation with a list of choices (an item that opens a sub-menu). */
export type ActionHandler = (() => void) | { run?: () => void; choices: ActionChoice[] };
export type ActionHandlers = Record<string, ActionHandler | undefined>;

/** Structurally the PC `ContextMenuItem`, so this module stays free of UI imports. */
export type BoundMenuItem = {
  id: string; label: string; destructive?: boolean; disabled?: boolean; checked?: boolean; shortcut?: string;
  onSelect: () => void;
  children?: { id: string; label: string; disabled?: boolean; onSelect: () => void }[];
};
export type BoundSheetItem = ActionDef & { run: () => void; choices?: ActionChoice[] };

const noop = () => undefined;

/** The unique, non-empty source addresses of the assets a menu acts on (for 출처 복사). */
export const uniqueSources = (sourceUrls: readonly (string | null | undefined)[]) =>
  [...new Set(sourceUrls.map(url => url?.trim()).filter((url): url is string => Boolean(url)))];

/** PC menu items for `defs`: only those with a handler (or inert headings), in the defs' order. */
export function bindMenuItems(defs: readonly ActionDef[], handlers: ActionHandlers): BoundMenuItem[] {
  return defs.flatMap((def): BoundMenuItem[] => {
    const handler = handlers[def.id];
    if (!handler && !def.inert) return [];
    const item: BoundMenuItem = {
      id: def.id, label: def.label, destructive: def.danger, disabled: def.disabled || def.inert,
      checked: def.checked, shortcut: def.shortcut,
      onSelect: typeof handler === "function" ? handler : handler?.run ?? noop,
    };
    if (handler && typeof handler !== "function") {
      item.children = handler.choices.map(choice => ({ id: choice.id, label: choice.label, disabled: choice.disabled, onSelect: choice.run }));
    }
    return [item];
  });
}

/** Tablet sheet items: no PC-only items, no headings, and only items the tablet has an operation for. */
export function bindSheetItems(defs: readonly ActionDef[], handlers: ActionHandlers): BoundSheetItem[] {
  return defs.flatMap((def): BoundSheetItem[] => {
    const handler = handlers[def.id];
    if (def.pcOnly || def.inert || !handler) return [];
    return [typeof handler === "function"
      ? { ...def, run: handler }
      : { ...def, run: handler.run ?? noop, choices: handler.choices }];
  });
}

// ---------- Folders and albums (sidebar tree rows, tablet folder cards and album rows) ----------

export type TreeActionInput = {
  kind: "folder" | "album";
  /** The protected 오리지널 root: no rename, move or delete. */
  originalsRoot?: boolean;
  /** The 마음에 들어요 album cannot be deleted. */
  likesAlbum?: boolean;
  hasChildren: boolean;
  /** A folder with no parent can become a 분류함. */
  topLevel?: boolean;
  pinned?: boolean;
  container?: boolean;
};

export function treeActionDefs(input: TreeActionInput): ActionDef[] {
  const album = input.kind === "album";
  const defs: ActionDef[] = [];
  if (!album && !input.originalsRoot && input.topLevel) defs.push({ id: "container", label: "분류함으로 쓰기", icon: "container", checked: !!input.container, pcOnly: true });
  if (!album) defs.push({ id: "pin", label: input.pinned ? "고정 해제" : "고정", icon: "pin" });
  defs.push({ id: "create-child", label: album ? "하위 앨범 만들기" : "하위 폴더 만들기", icon: "plus" });
  if (!input.originalsRoot) defs.push({ id: "rename", label: "이름 바꾸기", icon: "pencil" });
  defs.push({ id: "appearance", label: "아이콘 및 색상", icon: "palette" });
  if (!input.originalsRoot) defs.push({ id: "move", label: album ? "앨범 이동" : "폴더 이동", icon: "move", pcOnly: true });
  if (!input.originalsRoot && !input.likesAlbum) {
    defs.push({
      id: "delete", label: input.hasChildren ? `삭제 — 하위 ${album ? "앨범" : "폴더"} 있음` : "삭제", icon: "trash",
      danger: true, disabled: input.hasChildren, pcOnly: !album,
    });
  }
  return defs;
}

// ---------- Collection works (shelf covers, spines, manga rows) ----------

export function collectionActionDefs(input: { showcase: boolean }): ActionDef[] {
  return [
    { id: "edit", label: "편집", icon: "pencil" },
    { id: "showcase", label: input.showcase ? "쇼케이스에서 빼기" : "쇼케이스에 추가", icon: "sparkles" },
    { id: "delete", label: "휴지통으로", icon: "trash", danger: true },
  ];
}

// ---------- Artists ----------

export function artistActionDefs(input: { pinned: boolean; hidden: boolean }): ActionDef[] {
  return [
    { id: "pin", label: input.pinned ? "고정 해제" : "고정", icon: "pin" },
    { id: "rename", label: "이름 바꾸기", icon: "pencil" },
    { id: "merge", label: "다른 작가와 합치기", icon: "merge", pcOnly: true },
    { id: "hide", label: input.hidden ? "숨김 해제" : "숨기기", icon: input.hidden ? "show" : "hide" },
  ];
}

// ---------- Images (gallery right-click on the PC, the selection bar's ⋯ on the tablet) ----------

export type ImageActionInput = {
  count: number;
  /** The menu acts on the selection (shown as "n개 선택") rather than on the one image under the pointer. */
  targetsSelection?: boolean;
  busy: boolean;
  sourceCount: number;
  albumCount: number;
  inAlbum?: boolean;
  inCollection?: boolean;
  videoCompare?: boolean;
  refresh?: boolean;
};

export function imageActionDefs(input: ImageActionInput): ActionDef[] {
  const { count, busy } = input;
  const idle = busy || count === 0;
  const defs: ActionDef[] = [];
  if (input.videoCompare) defs.push({ id: "video-similarity", label: "선택한 영상 비교", icon: "compare", disabled: busy, pcOnly: true });
  defs.push(
    { id: "count", label: input.targetsSelection === false ? `${count}개` : `${count}개 선택`, icon: "info", inert: true, pcOnly: true },
    { id: "copy-source", label: "출처 복사", icon: "copy", disabled: idle || input.sourceCount === 0 },
    { id: "album", label: "앨범에 추가", icon: "album", disabled: idle || input.albumCount === 0 },
  );
  if (input.inAlbum) defs.push({ id: "remove-album", label: "이 앨범에서 빼기", icon: "remove", disabled: busy });
  if (input.inCollection) defs.push({ id: "remove", label: "이 컬렉션에서 빼기", icon: "remove", disabled: busy });
  if (input.inCollection && count === 1) defs.push({ id: "cover", label: "대표 이미지로 지정", icon: "cover", disabled: busy });
  defs.push({ id: "info", label: "정보 열기", icon: "info" });
  if (input.refresh) defs.push({ id: "refresh", label: "새로고침", icon: "refresh", disabled: busy, pcOnly: true });
  defs.push({ id: "trash", label: "휴지통으로", icon: "trash", danger: true, disabled: idle });
  return defs;
}
