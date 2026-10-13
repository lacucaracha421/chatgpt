import { AssetImage } from "../privacy/AssetImage";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUturnLeftIcon, PencilIcon, PhotoIcon, UserGroupIcon, UserPlusIcon } from "@heroicons/react/24/outline";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { ShelfBridgeContext, type ShelfBridge } from "../shared/ui/ShelfScroller";
import { TextField } from "../shared/ui/TextField";
import { commandErrorMessage } from "../library/errorMessage";
import { groupMemberImage, groupPreviewMembers } from "./shelfImages";
import type { CharacterTarget } from "./api";
import { FolderShelf } from "../assets/FolderShelf";
import { characterExtrasApi } from "./extrasApi";
import { useExtrasPreviews } from "./ExtrasCard";
import type { CharacterHubApi } from "./hubApi";
import { NO_OVER, ShelfDrag, type DragOver, type DropIntent, type ShelfDragHost } from "./shelfDrag";
import { SHELF_MOVE_ITEMS as MOVE_ITEMS, SHELF_KEY_MOVES as KEY_MOVES, canMove, movedIds, orderAnnouncement, type OrderKind, type OrderMove } from "./shelfOrder";

type Group = { id: string; name: string; revision: number; targetIds: string[]; extrasTargetId?: string | null };
type Props = {
  seriesId: string;
  members: CharacterTarget[];
  groups?: Group[];
  activeGroupId?: string;
  privacyMode?: boolean;
  onOpenGroup?: (groupId: string | null) => void;
  onGroupsChanged?: () => void;
  folderCards?: ReactNode[];
  /** The sub-folder band (registered series and plain folders): ids in shelf order, aligned with `folderCards`. Without it those cards stay fixed. */
  folderOrder?: { ids: string[]; names: Record<string, string>; onReorder: (ids: string[]) => Promise<void> };
  suggestionCards?: ReactNode[];
  /** The 기타 card: always the last character card, after the characters (and before suggestions and folders). */
  extrasCard?: ReactNode;
  suggestionCount?: number;
  /**
   * Where a group card reads its 기타 images from. A group card's mosaic is its members' pictures first,
   * then (up to four slots in all) its own 기타's newest images; without this, a group shows members only.
   */
  extrasPreviewApi?: Pick<CharacterHubApi, "browse">;
  /** Changes when the 기타 images may have changed; a group card re-reads then and keeps its pictures meanwhile. */
  extrasPreviewVersion?: number;
  memberCounts?: Record<string, number | undefined>;
  /** Quiet action on the right of the series count line (e.g. waiting S36 candidates). */
  headerAccessory?: ReactNode;
  /** Incremented by the owner's "그룹 만들기" command; each change opens a new group draft. */
  groupCreateRequest?: number;
  /** Increments open the current group's editor (the titlebar 그룹 더보기 menu owns the entry). */
  groupEditRequest?: number;
  /** Opens the editor of this series' group (the sidebar's 그룹 편집); handled once per request. */
  editGroupRequest?: { groupId: string; token: number } | null;
  onEditGroupRequestHandled?: () => void;
  /** Stores the new order of the series' groups (shown at once by the owner; rejects when storing fails). */
  onReorderGroups?: (seriesId: string, groupIds: string[]) => Promise<void>;
  /** Stores the new order of one band of characters: the loose ones (`groupId` null) or one group's members. */
  onReorderCharacters?: (seriesId: string, groupId: string | null, targetIds: string[]) => Promise<void>;
  /** Renders the character cards; `shelf` gives them their order attributes and menu entries. */
  children: (members: CharacterTarget[], shelf: CharacterShelfApi) => ReactNode;
};

/** What a character card needs to take part in the shelf's ordering. */
export type CharacterShelfApi = {
  cardProps(targetId: string): { "data-order-id": string; "data-order-kind": "character" };
  /** The order and group entries of a character card's menu; the owner adds its own after them. */
  menuItems(target: CharacterTarget, disabled: boolean): ContextMenuItem[];
};

type Notice = { id: number; text: string; tone: "status" | "error"; actionLabel?: string; run?: () => void };

export function CharacterGroups({ seriesId, members, groups: providedGroups, activeGroupId, privacyMode = false, onOpenGroup, onGroupsChanged, folderCards, folderOrder, suggestionCards = [], extrasCard, suggestionCount = 0, extrasPreviewApi, extrasPreviewVersion = 0, memberCounts = {}, headerAccessory, groupCreateRequest = 0, groupEditRequest = 0, editGroupRequest = null, onEditGroupRequestHandled, onReorderGroups, onReorderCharacters, children }: Props) {
  const [loadedGroups, setLoadedGroups] = useState<Group[]>([]);
  const [draft, setDraft] = useState<Group | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const seenCreateRequest = useRef(groupCreateRequest);
  useEffect(() => {
    if (groupCreateRequest === seenCreateRequest.current) return;
    seenCreateRequest.current = groupCreateRequest;
    setDraft({ id: "", name: "", revision: 0, targetIds: [] });
  }, [groupCreateRequest]);
  const seenEditRequest = useRef(groupEditRequest);
  useEffect(() => {
    if (groupEditRequest === seenEditRequest.current) return;
    seenEditRequest.current = groupEditRequest;
    const group = groups.find(item => item.id === activeGroupId);
    if (group) setDraft({ ...group, targetIds: [...group.targetIds] });
  }, [groupEditRequest]);
  const handledEditToken = useRef<number | null>(null);
  useEffect(() => {
    if (!editGroupRequest || handledEditToken.current === editGroupRequest.token) return;
    const group = groups.find(item => item.id === editGroupRequest.groupId);
    if (!group) return;
    handledEditToken.current = editGroupRequest.token;
    setDraft({ ...group, targetIds: [...group.targetIds] });
    onEditGroupRequestHandled?.();
  }, [editGroupRequest, providedGroups, loadedGroups]);
  useEffect(() => {
    if (providedGroups) return;
    let alive = true;
    void invoke<Group[]>("character_groups", { seriesId }).then(result => {
      if (alive) { setLoadedGroups(result); setError(null); }
    }).catch(error => {
      if (alive) setError(commandErrorMessage(error, "캐릭터 그룹을 불러오지 못했습니다."));
    });
    return () => { alive = false; };
  }, [seriesId, revision, providedGroups]);
  const groups = providedGroups ?? loadedGroups;
  const current = groups.find(group => group.id === activeGroupId);
  const grouped = new Set(groups.flatMap(group => group.targetIds));
  const visibleMembers = current
    ? members.filter(target => current.targetIds.includes(target.id))
    : members.filter(target => !grouped.has(target.id));

  const draftGroup = draft?.id ? groups.find(group => group.id === draft.id) : undefined;
  const rootGroups = current ? [] : groups;
  const rootFolders = current ? [] : (folderCards ?? []).filter(Boolean);

  // ---- Order of the shelf (user-accepted design 2026-10-13) ----
  // Two bands: the groups, then the loose characters (in a group view: that group's members). Nothing else moves.
  const groupIds = rootGroups.map(group => group.id);
  const characterIds = visibleMembers.map(target => target.id);
  const looseIds = members.filter(target => !grouped.has(target.id)).map(target => target.id);
  const folderIds = current || !folderOrder || folderOrder.ids.length !== rootFolders.length ? [] : folderOrder.ids;
  const bandOf = (kind: OrderKind) => kind === "group" ? groupIds : kind === "folder" ? folderIds : characterIds;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [lift, setLift] = useState<{ kind: OrderKind; id: string } | null>(null);
  const [over, setOver] = useState<DragOver>(NO_OVER);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeId = useRef(0);
  const [announcement, setAnnouncement] = useState("");
  const dismissNotice = useCallback((_value: null) => setNotice(null), []);
  useAutoDismiss(notice ? String(notice.id) : null, dismissNotice);
  const showNotice = (value: Omit<Notice, "id">) => setNotice({ id: ++noticeId.current, ...value });
  const reorderGroups = onReorderGroups ?? (async (id: string, ids: string[]) => { await invoke("reorder_character_groups", { seriesId: id, groupIds: ids }); setRevision(value => value + 1); onGroupsChanged?.(); });
  const reorderCharacters = onReorderCharacters ?? (async (id: string, groupId: string | null, ids: string[]) => { await invoke("reorder_character_folders", { seriesId: id, groupId, targetIds: ids }); onGroupsChanged?.(); });
  /** The new order shows at once (the owner updates its lists first); when storing fails it returns and one toast offers a retry. */
  async function applyOrder(kind: OrderKind, ids: string[]) {
    try {
      await (kind === "group" ? reorderGroups(seriesId, ids) : kind === "folder" ? folderOrder!.onReorder(ids) : reorderCharacters(seriesId, current?.id ?? null, ids));
    } catch {
      showNotice({ text: "순서를 바꾸지 못했습니다", tone: "error", actionLabel: "다시 시도", run: () => { setNotice(null); void applyOrder(kind, ids); } });
    }
  }
  const pendingFocus = useRef<{ kind: OrderKind; id: string } | null>(null);
  function moveCard(kind: OrderKind, id: string, move: OrderMove, keyboard = false) {
    const ids = bandOf(kind);
    const next = movedIds(ids, id, move);
    if (!next) return;
    const name = kind === "group" ? groups.find(group => group.id === id)?.name : kind === "folder" ? folderOrder?.names[id] : members.find(target => target.id === id)?.displayName;
    if (keyboard) pendingFocus.current = { kind, id };
    setAnnouncement(orderAnnouncement(kind, name ?? "", next.indexOf(id)));
    void applyOrder(kind, next);
  }
  // A moved card is re-inserted by the browser and loses focus: give it back and keep it in view.
  const orderSignature = `${groupIds.join()}|${characterIds.join()}|${folderIds.join()}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const bridge = useRef<ShelfBridge>({ locked: false, track: null }).current;
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const card = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-order-id]") ?? [])].find(node => node.dataset.orderId === pending.id && node.dataset.orderKind === pending.kind);
    card?.querySelector<HTMLElement>(".series-character__open")?.focus({ preventScroll: true });
    const track = bridge.track;
    if (!card || !track) return;
    const box = card.getBoundingClientRect(), view = track.getBoundingClientRect();
    if (box.left < view.left) track.scrollLeft -= view.left - box.left + 8;
    else if (box.right > view.right) track.scrollLeft += box.right - view.right + 8;
  }, [orderSignature]);

  const orderedMembersOf = (group: Group) => members.filter(target => group.targetIds.includes(target.id)).map(target => target.id);
  const keepsExtras = (group: Group) => Boolean(group.extrasTargetId) && (memberCounts[group.extrasTargetId!] ?? 0) > 0;
  const saveMembers = (group: Group, targetIds: string[]) => invoke("save_character_group", { request: {
    id: group.id, seriesId, expectedRevision: group.revision, name: group.name, targetIds, delete: false,
  } });
  /** 그룹에 넣기: the character becomes the group's last member. */
  async function putIn(targetId: string, groupId: string): Promise<boolean> {
    const group = groupsRef.current.find(item => item.id === groupId);
    if (!group || group.targetIds.includes(targetId) || !members.some(target => target.id === targetId)) return false;
    const before = { loose: looseIds, group: orderedMembersOf(group) };
    try {
      await saveMembers(group, [...group.targetIds, targetId]);
      await reorderCharacters(seriesId, group.id, [...before.group, targetId]);
    } catch (error) {
      onGroupsChanged?.();
      showNotice({ text: commandErrorMessage(error, "그룹에 넣지 못했습니다."), tone: "error" });
      return false;
    }
    onGroupsChanged?.();
    showNotice({ text: `${group.name}에 넣음`, tone: "status", actionLabel: "되돌리기", run: () => void undoPutIn(group.id, targetId, before) });
    return true;
  }
  async function undoPutIn(groupId: string, targetId: string, before: { loose: string[]; group: string[] }) {
    setNotice(null);
    const group = groupsRef.current.find(item => item.id === groupId);
    try {
      if (!group) throw new Error("그룹이 바뀌었습니다.");
      await saveMembers(group, group.targetIds.filter(id => id !== targetId));
      await reorderCharacters(seriesId, null, before.loose);
      if (before.group.length > 1) await reorderCharacters(seriesId, groupId, before.group);
    } catch (error) {
      showNotice({ text: commandErrorMessage(error, "되돌리지 못했습니다."), tone: "error" });
    }
    onGroupsChanged?.();
  }
  /** 그룹에서 빼기: the character returns to the series' loose characters, after the others. */
  async function takeOut(targetId: string): Promise<boolean> {
    const group = current;
    if (!group || !group.targetIds.includes(targetId)) return false;
    const before = { loose: looseIds, group: orderedMembersOf(group) };
    const remaining = group.targetIds.filter(id => id !== targetId);
    const dissolved = remaining.length === 0 && !keepsExtras(group);
    try {
      await saveMembers(group, remaining);
      await reorderCharacters(seriesId, null, [...before.loose, targetId]);
    } catch (error) {
      onGroupsChanged?.();
      showNotice({ text: commandErrorMessage(error, "그룹에서 빼지 못했습니다."), tone: "error" });
      return false;
    }
    if (dissolved) onOpenGroup?.(null);
    onGroupsChanged?.();
    showNotice({ text: `${group.name}에서 뺌`, tone: "status", actionLabel: "되돌리기", run: () => void undoTakeOut(group, targetId, before) });
    return true;
  }
  async function undoTakeOut(group: Group, targetId: string, before: { loose: string[]; group: string[] }) {
    setNotice(null);
    const existing = groupsRef.current.find(item => item.id === group.id);
    try {
      if (existing) await saveMembers(existing, [...existing.targetIds, targetId]);
      else await invoke("save_character_group", { request: { id: null, seriesId, expectedRevision: null, name: group.name, targetIds: before.group, delete: false } });
      await reorderCharacters(seriesId, null, before.loose);
      if (existing && before.group.length > 1) await reorderCharacters(seriesId, group.id, before.group);
    } catch (error) {
      showNotice({ text: commandErrorMessage(error, "되돌리지 못했습니다."), tone: "error" });
    }
    onGroupsChanged?.();
  }

  const host: ShelfDragHost = {
    // A card can be carried when its band has somewhere to go: a neighbour to pass, a group to enter, or the group to leave.
    band: (kind, id) => {
      const ids = bandOf(kind);
      return ids.includes(id) && (ids.length > 1 || (kind === "character" && (rootGroups.length > 0 || Boolean(current)))) ? ids : null;
    },
    canPutIn: !current && rootGroups.length > 0,
    canTakeOut: Boolean(current),
    onLift: (kind, id) => setLift({ kind, id }),
    onOver: setOver,
    onEnd: (intent: DropIntent | null) => {
      setLift(null); setOver(NO_OVER);
      if (!intent) return;
      if (intent.type === "reorder") { void applyOrder(intent.kind, intent.ids); return; }
      return intent.type === "into" ? putIn(intent.targetId, intent.groupId) : takeOut(intent.targetId);
    },
  };
  const hostRef = useRef(host);
  hostRef.current = host;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return new ShelfDrag(root, bridge, () => hostRef.current).attach();
  }, [bridge]);

  const shelfApi: CharacterShelfApi = {
    cardProps: targetId => ({ "data-order-id": targetId, "data-order-kind": "character" }),
    menuItems: (target, disabled) => [
      ...MOVE_ITEMS.map(item => ({ id: `move-${item.move}`, label: item.label, shortcut: item.shortcut, disabled: disabled || !canMove(characterIds, target.id, item.move), onSelect: () => moveCard("character", target.id, item.move) })),
      ...(current
        ? [{ id: "take-out", label: `${current.name}에서 빼기`, separatorBefore: true, disabled, onSelect: () => void takeOut(target.id) }]
        : [{ id: "put-in", label: "그룹에 넣기", separatorBefore: true, disabled: disabled || groups.length === 0, onSelect: () => undefined,
            children: groups.map(group => ({ id: group.id, label: group.name, onSelect: () => void putIn(target.id, group.id) })) }]),
    ],
  };
  const labelParts = [
    ...((current ? visibleMembers.length : members.length) > 0 ? [["캐릭터", current ? visibleMembers.length : members.length]] : []),
    ...(!current && rootGroups.length ? [["그룹", rootGroups.length]] : []),
    ...(extrasCard ? [["기타", 0]] : []),
    ...(!current && suggestionCount > 0 ? [["제안", suggestionCount]] : []),
    ...(!current && rootFolders.length ? [["폴더", rootFolders.length]] : []),
  ] as [string, number][];
  const cards: ReactNode[] = [
    ...(lift?.kind === "character" && current ? [<article key="take-out" className="series-character folder-shelf__card shelf-take-out" data-take-out data-over={over.takeOut || undefined} aria-hidden="true">
      <div className="shelf-take-out__face"><ArrowUturnLeftIcon aria-hidden="true" /><span>그룹에서 빼기</span></div>
    </article>] : []),
    ...rootGroups.map(group => <CharacterGroupCard key={group.id} seriesId={seriesId} group={group} members={members} extrasPreviewApi={extrasPreviewApi} extrasPreviewVersion={extrasPreviewVersion} memberCounts={memberCounts} privacyMode={privacyMode} intoFace={over.groupId === group.id} orderItems={MOVE_ITEMS.map(item => ({ id: `move-${item.move}`, label: item.label, shortcut: item.shortcut, disabled: !canMove(groupIds, group.id, item.move), onSelect: () => moveCard("group", group.id, item.move) }))} onOpen={() => onOpenGroup?.(group.id)} onEdit={() => setDraft({ ...group, targetIds: [...group.targetIds] })} />),
    ...(visibleMembers.length > 0 ? [<Fragment key="members">{children(visibleMembers, shelfApi)}</Fragment>] : []),
    ...(extrasCard ? [<Fragment key="extras">{extrasCard}</Fragment>] : []),
    ...suggestionCards,
    ...rootFolders.map((card, index) => {
      const id = folderIds[index];
      if (id === undefined) return card;
      return <ContextMenu key={id} items={MOVE_ITEMS.map(item => ({ id: `move-${item.move}`, label: item.label, shortcut: item.shortcut, disabled: !canMove(folderIds, id, item.move), onSelect: () => moveCard("folder", id, item.move) }))}>{card as ReactElement}</ContextMenu>;
    }),
  ];

  async function save(remove = false) {
    if (!draft || busy) return;
    setBusy(true); setError(null);
    try {
      if (!remove && !draft.id && draft.targetIds.length === 0) {
        // A group that only has a 기타: its members come later, by 캐릭터로 or by adding characters.
        await characterExtrasApi.createGroup(seriesId, draft.name.trim());
        setDraft(null);
        setRevision(value => value + 1);
        onGroupsChanged?.();
        return;
      }
      await invoke("save_character_group", { request: {
        id: draft.id || null, seriesId, expectedRevision: draft.id ? draft.revision : null,
        name: draft.name, targetIds: draft.targetIds, delete: remove,
      } });
      // A group whose 기타 still holds images stays when its last member leaves.
      const editing = groups.find(group => group.id === draft.id);
      const keeps = Boolean(editing?.extrasTargetId) && (memberCounts[editing!.extrasTargetId!] ?? 0) > 0;
      const removedId = remove || (!draft.targetIds.length && !keeps) ? draft.id : null;
      setDraft(null);
      if (removedId && activeGroupId === removedId) onOpenGroup?.(null);
      setRevision(value => value + 1);
      onGroupsChanged?.();
    } catch (error) {
      setError(commandErrorMessage(error, "그룹을 저장하지 못했습니다."));
    } finally { setBusy(false); }
  }

  const onShelfKeyDown = (event: ReactKeyboardEvent) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const move = KEY_MOVES[event.key];
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-order-id]") : null;
    if (!move || !card || !rootRef.current?.contains(card)) return;
    // Alt+Left/Right/Home/End would otherwise walk the browser history.
    event.preventDefault();
    moveCard(card.dataset.orderKind as OrderKind, card.dataset.orderId!, move, true);
  };

  return <div ref={rootRef} className="shelf-reorder-root" onKeyDown={onShelfKeyDown}>
    {/* A group view starts with its member tiles: the breadcrumb returns to the series and 그룹 편집 lives in the titlebar menu. */}
    {(labelParts.length > 0 || headerAccessory) && <ShelfBridgeContext.Provider value={bridge}><FolderShelf
      label={labelParts.map(([kind, count]) => count > 0 ? `${kind} ${count.toLocaleString()}` : kind).join(" · ")}
      appearanceKey="classification-characters"
      entrance={false}
      cards={cards}
      accessory={headerAccessory}
      className="series-characters"
      labelClassName="character-group-heading"
      ariaLabel={current ? `${current.name} 그룹 캐릭터` : folderCards?.length ? "캐릭터와 일반 폴더" : "등록 캐릭터"}
    /></ShelfBridgeContext.Provider>}
    <span className="shelf-order-live" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    {notice && <Toast tone={notice.tone} actionLabel={notice.actionLabel} onAction={notice.run} onDismiss={() => setNotice(null)}>{notice.text}</Toast>}
    {!labelParts.length && !cards.length && <p className="series-empty">캐릭터를 등록하고 레퍼런스를 선택하세요.</p>}
    {error && <p className="character-message" role="alert">{error}<Button size="sm" onClick={() => setRevision(value => value + 1)}>다시 시도</Button></p>}
    {draft && <Dialog open title={draft.id ? "캐릭터 그룹 편집" : "캐릭터 그룹 만들기"} onClose={() => { if (!busy) setDraft(null); }}>
      <TextField label="그룹 이름" value={draft.name} maxLength={100} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} />
      <p>탐색 목록만 묶습니다. 시리즈 소속, 이미지 분류와 분석 범위는 바뀌지 않습니다.</p>
      <p>소속 캐릭터가 모두 빠져도 기타에 이미지가 있으면 그룹은 남습니다. 둘 다 비면 자동으로 해제됩니다.</p>
      <div className="character-group-members">{members.filter(target => !grouped.has(target.id) || groups.find(group => group.id === draft.id)?.targetIds.includes(target.id)).map(target => <label key={target.id}>
        <input type="checkbox" disabled={busy} checked={draft.targetIds.includes(target.id)} onChange={event => setDraft({ ...draft, targetIds: event.target.checked ? [...draft.targetIds, target.id] : draft.targetIds.filter(id => id !== target.id) })} />
        {target.displayName}
      </label>)}</div>
      {error && <p role="alert">{error}</p>}
      <div className="character-actions"><Button disabled={busy || !draft.name.trim()} onClick={() => void save()}>{!draft.id && !draft.targetIds.length ? "기타만 있는 그룹 만들기" : draft.id && !draft.targetIds.length && !(draftGroup?.extrasTargetId && (memberCounts[draftGroup.extrasTargetId] ?? 0) > 0) ? "빈 그룹 해제" : "저장"}</Button>{draft.id && <Button variant="ghost" disabled={busy} onClick={() => void save(true)}>그룹 해제 · 캐릭터 유지</Button>}</div>
    </Dialog>}
  </div>;
}

const GROUP_MOSAIC_SLOTS = 4;

function CharacterGroupCard({ seriesId, group, members, extrasPreviewApi, extrasPreviewVersion, memberCounts, privacyMode, intoFace, orderItems, onOpen, onEdit }: { intoFace: boolean; orderItems: ContextMenuItem[]; seriesId: string; group: Group; extrasPreviewApi?: Pick<CharacterHubApi, "browse">; extrasPreviewVersion: number; members: CharacterTarget[]; memberCounts: Record<string, number | undefined>; privacyMode: boolean; onOpen: () => void; onEdit: () => void }) {
  const { groupMembers, previews } = groupPreviewMembers(group, members);
  // Members first; the free slots (if any) are filled with the group's own 기타 images. At most one read per card and refresh.
  const wantsExtras = Boolean(extrasPreviewApi && group.extrasTargetId && previews.length < GROUP_MOSAIC_SLOTS);
  const extrasRead = useExtrasPreviews(seriesId, wantsExtras ? group.extrasTargetId! : null, extrasPreviewVersion, extrasPreviewApi);
  const extrasPreviews = wantsExtras ? (extrasRead ?? []).slice(0, GROUP_MOSAIC_SLOTS - previews.length) : [];
  const slotCount = previews.length + extrasPreviews.length;
  const pending = wantsExtras && extrasRead === undefined && previews.length === 0;
  const count = [...groupMembers.map(member => member.id), ...(group.extrasTargetId ? [group.extrasTargetId] : [])].reduce<number | undefined>((sum, id) => {
    const next = memberCounts[id];
    return next === undefined ? sum : (sum ?? 0) + next;
  }, undefined);
  return <ContextMenu items={[...orderItems, { id: "edit-group", label: "그룹 편집", separatorBefore: true, onSelect: onEdit }]}><article className="series-character folder-shelf__card series-character--group" data-order-id={group.id} data-order-kind="group">
    <button className="series-character__open" aria-label={`${group.name} 그룹 열기`} aria-description={`${group.targetIds.length.toLocaleString()}명${groupMembers.length ? ` · ${groupMembers.map(member => member.displayName).join(" · ")}` : ""}${group.extrasTargetId ? " · 기타" : ""}`} onClick={onOpen}>
      <span className="character-group-card__mosaic" data-count={Math.max(1, slotCount)}>
        {previews.map(target => {
          const image = groupMemberImage(target);
          return privacyMode ? <span key={target.id} className="character-group-card__slot privacy-mask" aria-label="비공개 모드"/> : image ? <AssetImage key={target.id} draggable={false} loading="lazy" src={image} alt="" /> : <span key={target.id} className="character-group-card__slot"><PhotoIcon aria-hidden="true" /></span>;
        })}
        {extrasPreviews.map(preview => privacyMode
          ? <span key={`extras:${preview.id}`} className="character-group-card__slot privacy-mask" aria-label="비공개 모드"/>
          : <AssetImage key={`extras:${preview.id}`} draggable={false} loading="lazy" src={preview.src} alt="" />)}
        {slotCount === 0 && <span className="character-group-card__slot">{!pending && <UserGroupIcon aria-hidden="true" />}</span>}
      </span>
      <strong><UserGroupIcon className="character-group-card__icon" aria-hidden="true" /><span className="series-character__name">{group.name}</span></strong>
      <small className="folder-shelf__meta" aria-hidden={count === undefined || undefined}>{count === undefined ? null : `${count.toLocaleString("ko-KR")}장`}</small>
    </button>
    {intoFace && <span className="shelf-into-face" data-into-face aria-hidden="true"><UserPlusIcon aria-hidden="true" />그룹에 넣기</span>}
    <Button className="series-character__info" size="icon" variant="ghost" aria-label={`${group.name} 그룹 편집`} aria-description="그룹 편집" onClick={onEdit}><PencilIcon aria-hidden="true" /></Button>
  </article></ContextMenu>;
}
