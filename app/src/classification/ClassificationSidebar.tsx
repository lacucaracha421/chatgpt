import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, FolderIcon, PhotoIcon, InboxIcon, PlusIcon, Cog6ToothIcon, StarIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useLayoutEffect, useEffect, useRef, useState, type CSSProperties } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { useLibrary } from "../library/LibraryContext";
import type { AlbumEntry, AssetView, ClassificationEntry } from "../library/types";
import { clampSidebarWidth } from "../layout/sidebarWidth";
import { Button } from "../shared/ui/Button";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { Dialog } from "../shared/ui/Dialog";
import type { MenuItem } from "../shared/ui/Menu";
import { Select } from "../shared/ui/Select";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import type { ClassificationDropTarget, InternalDragPayload } from "../shared/interaction/pointerDrag";
import { buildTree, type TreeNode } from "./buildTree";
import { ClassificationAppearanceDialog } from "./ClassificationAppearanceDialog";
import { ClassificationIcon, classificationColor } from "./classificationAppearance";

type ClassificationSidebarProps = {
  entries: ClassificationEntry[];
  albums?: AlbumEntry[];
  view: AssetView;
  expandedIds: string[];
  expandedAlbumIds?: string[];
  sidebarWidth: number;
  reviewCount: number;
  createClassificationRequest?: number;
  onViewChange: (view: AssetView) => void;
  onExpandedIdsChange: (ids: string[]) => void;
  onExpandedAlbumIdsChange?: (ids: string[]) => void;
  onSidebarWidthChange: (width: number) => void;
  onChanged: () => void;
  onAlbumsChanged?: () => void;
  dragTarget?: ClassificationDropTarget | null;
  onPointerDragStart?: (payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragMove?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragEnd?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragCancel?: (event: React.PointerEvent<HTMLElement>) => void;
};

type SidebarTreeEntry = {
  treeKind: "classification" | "album";
  id: string;
  name: string;
  parentId: string | null;
  iconKey: string | null;
  colorKey: string | null;
  kind: ClassificationEntry["kind"];
};

type SidebarTreeNode = TreeNode<SidebarTreeEntry>;

type DialogState =
  { type: "move" | "delete"; entry: SidebarTreeEntry };

type InlineEdit =
  | { type: "create"; treeKind: "classification" | "album"; parentId: string | null; kind: "root" | "tag" }
  | { type: "rename"; entry: SidebarTreeEntry };

export function ClassificationSidebar({
  entries,
  albums = [],
  expandedIds,
  expandedAlbumIds = [],
  onChanged,
  onAlbumsChanged = onChanged,
  onExpandedIdsChange,
  onExpandedAlbumIdsChange = () => undefined,
  onSidebarWidthChange,
  onViewChange,
  dragTarget,
  onPointerDragStart,
  onPointerDragMove,
  onPointerDragEnd,
  onPointerDragCancel,
  sidebarWidth,
  reviewCount,
  view,
  createClassificationRequest = 0,
}: ClassificationSidebarProps) {
  const { gateway } = useLibrary();
  const classificationEntries: SidebarTreeEntry[] = entries.map((entry) => ({ ...entry, treeKind: "classification" }));
  const albumEntries: SidebarTreeEntry[] = albums.map((entry) => ({ ...entry, treeKind: "album", kind: "tag" }));
  const tree = buildTree(classificationEntries);
  const albumTree = buildTree(albumEntries);
  const visibleNodes = visibleTreeNodes(tree, expandedIds);
  const visibleAlbumNodes = visibleTreeNodes(albumTree, expandedAlbumIds);
  const selected = view.kind === "classification" && view.classificationId
    ? classificationEntries.find((entry) => entry.id === view.classificationId) ?? null
    : view.kind === "album"
      ? albumEntries.find((entry) => entry.id === view.albumId) ?? null
      : null;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [appearanceEntry, setAppearanceEntry] = useState<SidebarTreeEntry | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [name, setName] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [parentId, setParentId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [foldersOpen, setFoldersOpen] = useState(true);
  const [albumsOpen, setAlbumsOpen] = useState(true);
  useAutoDismiss(message, setMessage);
  const resize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const allEntries = [...classificationEntries, ...albumEntries];
  const allVisibleNodes = [...visibleNodes, ...visibleAlbumNodes];
  const activeRowId = nearestVisibleTreeRowId(focusedId, allEntries, allVisibleNodes);

  useLayoutEffect(() => {
    if (focusedId && activeRowId && focusedId !== activeRowId) {
      setFocusedId(activeRowId);
      rowRefs.current.get(activeRowId)?.focus();
    }
  }, [activeRowId, focusedId]);

  function closeDialog() {
    setDialog(null);
  }

  function completeMutation(treeKind: SidebarTreeEntry["treeKind"]) {
    setMessage(null);
    closeDialog();
    treeKind === "album" ? onAlbumsChanged() : onChanged();
  }

  function beginInlineEdit(edit: InlineEdit, initialName = "") {
    setInlineEdit(edit);
    setEditError(null);
    setName(initialName);
  }

  function openTopLevelCreate(treeKind: SidebarTreeEntry["treeKind"] = "classification") {
    beginInlineEdit({ type: "create", treeKind, parentId: null, kind: treeKind === "album" ? "tag" : "root" });
  }

  function openChildCreate(entry: SidebarTreeEntry) {
    const expanded = entry.treeKind === "album" ? expandedAlbumIds : expandedIds;
    const setExpanded = entry.treeKind === "album" ? onExpandedAlbumIdsChange : onExpandedIdsChange;
    if (!expanded.includes(entry.id)) setExpanded([...expanded, entry.id]);
    beginInlineEdit({ type: "create", treeKind: entry.treeKind, parentId: entry.id, kind: "tag" });
  }

  function openRename(entry: SidebarTreeEntry) {
    beginInlineEdit({ type: "rename", entry }, entry.name);
  }

  function openDelete(entry: SidebarTreeEntry) {
    const siblings = entry.treeKind === "album" ? albumEntries : classificationEntries;
    if (siblings.some((candidate) => candidate.parentId === entry.id)) {
      setMessage("하위 폴더가 있어 삭제할 수 없습니다.");
      return;
    }
    setDialog({ type: "delete", entry });
  }

  function cancelInlineEdit() {
    setInlineEdit(null);
    setEditError(null);
    setName("");
  }

  useEffect(() => {
    if (createClassificationRequest > 0) openTopLevelCreate("classification");
  }, [createClassificationRequest]);

  async function saveInlineEdit() {
    if (!inlineEdit) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setEditError("폴더 이름을 입력해 주세요.");
      return;
    }
    try {
      if (inlineEdit.type === "create") {
        if (inlineEdit.treeKind === "album") {
          await gateway.createAlbum({ name: trimmedName, parentId: inlineEdit.parentId });
        } else {
          await gateway.createClassification({ kind: inlineEdit.kind, name: trimmedName, parentId: inlineEdit.parentId });
        }
      } else {
        if (inlineEdit.entry.treeKind === "album") await gateway.renameAlbum(inlineEdit.entry.id, trimmedName);
        else await gateway.renameClassification(inlineEdit.entry.id, trimmedName);
      }
      const changedKind = inlineEdit.type === "create" ? inlineEdit.treeKind : inlineEdit.entry.treeKind;
      cancelInlineEdit();
      changedKind === "album" ? onAlbumsChanged() : onChanged();
    } catch (error) {
      setEditError(commandErrorMessage(error, "폴더를 변경하지 못했습니다."));
    }
  }

  async function move() {
    if (!dialog || dialog.type !== "move") return;
    try {
      const isAlbum = dialog.entry.treeKind === "album";
      if (isAlbum) await gateway.moveAlbum(dialog.entry.id, parentId || null);
      else await gateway.moveClassification(dialog.entry.id, parentId || null);
      const expanded = isAlbum ? expandedAlbumIds : expandedIds;
      const setExpanded = isAlbum ? onExpandedAlbumIdsChange : onExpandedIdsChange;
      if (parentId && !expanded.includes(parentId)) setExpanded([...expanded, parentId]);
      completeMutation(dialog.entry.treeKind);
    } catch (error) {
      setMessage(commandErrorMessage(error, "분류를 변경하지 못했습니다."));
    }
  }

  async function remove() {
    if (!dialog || dialog.type !== "delete") return;
    try {
      const isAlbum = dialog.entry.treeKind === "album";
      if (isAlbum) await gateway.deleteAlbum(dialog.entry.id);
      else await gateway.deleteClassification(dialog.entry.id);
      setMessage(null);
      closeDialog();
      if (isAlbum) {
        onExpandedAlbumIdsChange(expandedAlbumIds.filter((id) => id !== dialog.entry.id));
        onViewChange(dialog.entry.parentId ? { kind: "album", albumId: dialog.entry.parentId } : { kind: "classification", classificationId: null });
        onAlbumsChanged();
      } else {
        onExpandedIdsChange(expandedIds.filter((id) => id !== dialog.entry.id));
        onViewChange({ kind: "classification", classificationId: dialog.entry.parentId });
        onChanged();
      }
    } catch (error) {
      setMessage(commandErrorMessage(error, "분류를 변경하지 못했습니다."));
    }
  }

  function toggleExpanded(entry: SidebarTreeEntry) {
    const expanded = entry.treeKind === "album" ? expandedAlbumIds : expandedIds;
    const setExpanded = entry.treeKind === "album" ? onExpandedAlbumIdsChange : onExpandedIdsChange;
    setExpanded(expanded.includes(entry.id) ? expanded.filter((id) => id !== entry.id) : [...expanded, entry.id]);
  }

  function registerTreeRow(id: string, element: HTMLDivElement | null) {
    if (element) {
      rowRefs.current.set(id, element);
      return;
    }
    rowRefs.current.delete(id);
  }

  function focusTreeRow(id: string) {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }

  function handleSidebarKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (inlineEdit || dialog) return;
    const key = event.key.toLowerCase();
    if (key === "n" && event.ctrlKey && event.shiftKey && !event.altKey) {
      event.preventDefault();
      openTopLevelCreate("classification");
    } else if (key === "n" && event.altKey && !event.ctrlKey && selected) {
      event.preventDefault();
      openChildCreate(selected);
    } else if (event.key === "F2" && selected) {
      event.preventDefault();
      openRename(selected);
    } else if (event.key === "Delete" && selected) {
      event.preventDefault();
      openDelete(selected);
    }
  }

  function handleTreeKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
    node: SidebarTreeNode,
  ) {
    const scopedVisibleNodes = node.entry.treeKind === "album" ? visibleAlbumNodes : visibleNodes;
    const scopedExpandedIds = node.entry.treeKind === "album" ? expandedAlbumIds : expandedIds;
    const index = scopedVisibleNodes.indexOf(node);
    const parentId = node.entry.parentId;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusTreeRow(scopedVisibleNodes[Math.min(index + 1, scopedVisibleNodes.length - 1)]?.entry.id ?? node.entry.id);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusTreeRow(scopedVisibleNodes[Math.max(index - 1, 0)]?.entry.id ?? node.entry.id);
        break;
      case "Home":
        event.preventDefault();
        focusTreeRow(scopedVisibleNodes[0]?.entry.id ?? node.entry.id);
        break;
      case "End":
        event.preventDefault();
        focusTreeRow(scopedVisibleNodes[scopedVisibleNodes.length - 1]?.entry.id ?? node.entry.id);
        break;
      case "ArrowRight":
        if (node.children.length === 0) return;
        event.preventDefault();
        if (scopedExpandedIds.includes(node.entry.id)) {
          focusTreeRow(node.children[0].entry.id);
        } else {
          toggleExpanded(node.entry);
        }
        break;
      case "ArrowLeft":
        if (node.children.length > 0 && scopedExpandedIds.includes(node.entry.id)) {
          event.preventDefault();
          toggleExpanded(node.entry);
        } else if (parentId) {
          event.preventDefault();
          focusTreeRow(parentId);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        onViewChange(node.entry.treeKind === "album" ? { kind: "album", albumId: node.entry.id } : { kind: "classification", classificationId: node.entry.id });
        break;
    }
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    resize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeSidebar(event: React.PointerEvent<HTMLDivElement>) {
    const activeResize = resize.current;
    if (!activeResize || activeResize.pointerId !== event.pointerId) return;
    onSidebarWidthChange(
      clampSidebarWidth(Math.round(activeResize.startWidth + event.clientX - activeResize.startX)),
    );
  }

  function stopResize(event: React.PointerEvent<HTMLDivElement>) {
    if (resize.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    resize.current = null;
  }

  return (
    <aside className="classification-sidebar" aria-label="분류" style={{ width: sidebarWidth }} onKeyDown={handleSidebarKeyDown}>
      <div className="classification-sidebar__heading" data-tauri-drag-region>
        <h2>분류</h2>
        <Button type="button" size="icon" variant="ghost" aria-label="새 폴더" onClick={() => openTopLevelCreate("classification")}>
          <PlusIcon aria-hidden="true" />
        </Button>
      </div>
      <nav className="classification-sidebar__quick-views" aria-label="빠른 보기">
        <QuickViewButton icon={<FolderIcon aria-hidden="true" />} label="저장소" selected={view.kind === "classification" && view.classificationId === null} onClick={() => onViewChange({ kind: "classification", classificationId: null })} />
        <QuickViewButton icon={<InboxIcon aria-hidden="true" />} label="미분류" selected={view.kind === "unsorted"} onClick={() => onViewChange({ kind: "unsorted" })} />
        <QuickViewButton icon={<ClockIcon aria-hidden="true" />} label="최근" selected={view.kind === "recent"} onClick={() => onViewChange({ kind: "recent" })} />
        <QuickViewButton icon={<StarIcon aria-hidden="true" />} label="즐겨찾기" selected={view.kind === "favorites"} onClick={() => onViewChange({ kind: "favorites" })} />
        <QuickViewButton icon={<PhotoIcon aria-hidden="true" />} label="유사 검토" count={reviewCount} selected={view.kind === "similarity_review"} onClick={() => onViewChange({ kind: "similarity_review" })} />
        <QuickViewButton icon={<BookOpenIcon aria-hidden="true" />} label="망가" selected={view.kind === "manga"} onClick={() => onViewChange({ kind: "manga" })} />
      </nav>
      {tree.hasOrphans && <p className="classification-sidebar__warning" role="alert">연결되지 않은 분류는 숨겨집니다.</p>}
      <button type="button" className="classification-sidebar__tree-heading" aria-expanded={foldersOpen} aria-label={`폴더 ${foldersOpen ? "접기" : "펼치기"}`} onClick={() => setFoldersOpen((open) => !open)}>
        {foldersOpen ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
        <span>폴더 ({tree.length})</span>
      </button>
      <ContextMenu items={[{ id: "create-root", label: "새 폴더", onSelect: () => openTopLevelCreate("classification") }]}>
        <ul className="classification-sidebar__tree" role="tree" aria-label="폴더" hidden={!foldersOpen}>
          {tree.map((node, index) => (
            <TreeItem
              key={node.entry.id}
              node={node}
              hasNextSibling={index < tree.length - 1}
              view={view}
              expandedIds={expandedIds}
              activeRowId={activeRowId}
              inlineEdit={inlineEdit}
              editName={name}
              editError={editError}
              onViewChange={onViewChange}
              onToggleExpanded={toggleExpanded}
              onRowFocus={setFocusedId}
              onRowKeyDown={handleTreeKeyDown}
              registerTreeRow={registerTreeRow}
              onCreateChild={openChildCreate}
              onRename={openRename}
              onAppearance={setAppearanceEntry}
              onEditNameChange={(nextName) => { setName(nextName); setEditError(null); }}
              onEditSave={() => void saveInlineEdit()}
              onEditCancel={cancelInlineEdit}
              onMove={(entry) => { setParentId(entry.parentId ?? ""); setDialog({ type: "move", entry }); }}
              onDelete={openDelete}
              dragTarget={dragTarget}
              onPointerDragStart={onPointerDragStart}
              onPointerDragMove={onPointerDragMove}
              onPointerDragEnd={onPointerDragEnd}
              onPointerDragCancel={onPointerDragCancel}
            />
          ))}
          {inlineEdit?.type === "create" && inlineEdit.treeKind === "classification" && inlineEdit.parentId === null && (
            <InlineFolderEditor name={name} error={editError} onNameChange={(nextName) => { setName(nextName); setEditError(null); }} onSave={() => void saveInlineEdit()} onCancel={cancelInlineEdit} />
          )}
        </ul>
      </ContextMenu>
      {albumTree.hasOrphans && <p className="classification-sidebar__warning" role="alert">연결되지 않은 앨범을 숨겼습니다.</p>}
      <ContextMenu items={[{ id: "create-album", label: "새 앨범", onSelect: () => openTopLevelCreate("album") }]}>
        <div>
          <button type="button" className="classification-sidebar__tree-heading" aria-expanded={albumsOpen} aria-label={`앨범 ${albumsOpen ? "접기" : "펼치기"}`} onClick={() => setAlbumsOpen((open) => !open)}>
            {albumsOpen ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
            <span>앨범 ({albumTree.length})</span>
          </button>
          <ul className="classification-sidebar__tree" role="tree" aria-label="앨범" hidden={!albumsOpen}>
            {albumTree.map((node, index) => (
              <TreeItem
                key={node.entry.id}
                node={node}
                hasNextSibling={index < albumTree.length - 1}
                view={view}
                expandedIds={expandedAlbumIds}
                activeRowId={activeRowId}
                inlineEdit={inlineEdit}
                editName={name}
                editError={editError}
                onViewChange={onViewChange}
                onToggleExpanded={toggleExpanded}
                onRowFocus={setFocusedId}
                onRowKeyDown={handleTreeKeyDown}
                registerTreeRow={registerTreeRow}
                onCreateChild={openChildCreate}
                onRename={openRename}
                onAppearance={setAppearanceEntry}
                onEditNameChange={(nextName) => { setName(nextName); setEditError(null); }}
                onEditSave={() => void saveInlineEdit()}
                onEditCancel={cancelInlineEdit}
                onMove={(entry) => { setParentId(entry.parentId ?? ""); setDialog({ type: "move", entry }); }}
                onDelete={openDelete}
                dragTarget={dragTarget}
                onPointerDragStart={onPointerDragStart}
                onPointerDragMove={onPointerDragMove}
                onPointerDragEnd={onPointerDragEnd}
                onPointerDragCancel={onPointerDragCancel}
              />
            ))}
            {inlineEdit?.type === "create" && inlineEdit.treeKind === "album" && inlineEdit.parentId === null && (
              <InlineFolderEditor name={name} error={editError} onNameChange={(nextName) => { setName(nextName); setEditError(null); }} onSave={() => void saveInlineEdit()} onCancel={cancelInlineEdit} />
            )}
          </ul>
        </div>
      </ContextMenu>
      <div className="classification-sidebar__footer">
        <QuickViewButton icon={<TrashIcon aria-hidden="true" />} label="휴지통" selected={view.kind === "trash"} onClick={() => onViewChange({ kind: "trash" })} />
        <QuickViewButton icon={<Cog6ToothIcon aria-hidden="true" />} label="설정" selected={view.kind === "settings"} onClick={() => onViewChange({ kind: "settings" })} />
      </div>
      <div
        aria-label="사이드바 너비 조절"
        className="classification-sidebar__resize-handle"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startResize}
        onPointerMove={resizeSidebar}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
      <ClassificationAppearanceDialog
        entry={appearanceEntry ? { ...appearanceEntry, scope: appearanceEntry.treeKind } : null}
        onClose={() => setAppearanceEntry(null)}
        onSaved={() => {
          setAppearanceEntry(null);
          appearanceEntry?.treeKind === "album" ? onAlbumsChanged() : onChanged();
        }}
      />
      {dialog?.type === "move" && (
        <Dialog open title={dialog.entry.treeKind === "album" ? "앨범 이동" : "폴더 이동"} onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => { event.preventDefault(); void move(); }}>
            <Select label={dialog.entry.treeKind === "album" ? "상위 앨범" : "상위 폴더"} value={parentId} onChange={(event) => setParentId(event.target.value)}>
              {moveParents(dialog.entry, dialog.entry.treeKind === "album" ? albumEntries : classificationEntries).map((parent) => <option key={parent?.id ?? "root"} value={parent?.id ?? ""}>{parent?.name ?? "최상위"}</option>)}
            </Select>
            <DialogActions onClose={closeDialog} submitLabel="이동" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "delete" && (
        <Dialog open title={dialog.entry.treeKind === "album" ? "앨범 삭제" : "폴더 삭제"} onClose={closeDialog}>
          <div className="classification-sidebar__form">
            <p>{dialog.entry.name} {dialog.entry.treeKind === "album" ? "앨범" : "폴더"}을 삭제할까요?</p>
            <p>{dialog.entry.treeKind === "album"
              ? "앨범 연결만 제거되며 원본 파일과 일반 폴더는 유지됩니다."
              : dialog.entry.parentId
                ? `이 폴더의 자산은 ${entries.find((entry) => entry.id === dialog.entry.parentId)?.name ?? "상위"} 폴더로 이동합니다.`
                : "자산은 보존되고 이 폴더 연결만 제거됩니다."}</p>
            <div className="ui-dialog__actions">
              <Button type="button" onClick={closeDialog}>취소</Button>
              <Button type="button" variant="danger" onClick={() => void remove()}>삭제</Button>
            </div>
          </div>
        </Dialog>
      )}
    </aside>
  );
}

function QuickViewButton({ icon, label, count, onClick, selected }: { icon: React.ReactNode; label: string; count?: number; onClick: () => void; selected: boolean }) {
  return (
    <button type="button" className="classification-sidebar__quick-view" aria-label={count === undefined ? undefined : `${label} ${count}개`} aria-current={selected ? "page" : undefined} onClick={onClick}>
      <span className="classification-sidebar__quick-view-surface">
        {icon}
        <span className="classification-sidebar__quick-view-label">{label}</span>
        {count !== undefined && <span className="classification-sidebar__badge" aria-hidden="true">{count}</span>}
      </span>
    </button>
  );
}

function TreeItem({ activeRowId, editError, editName, expandedIds, hasNextSibling, inlineEdit, node, onAppearance, onCreateChild, onDelete, onEditCancel, onEditNameChange, onEditSave, onMove, onRename, onRowFocus, onRowKeyDown, onToggleExpanded, onViewChange, registerTreeRow, view, dragTarget, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: {
  activeRowId: string | null;
  editError: string | null;
  editName: string;
  expandedIds: string[];
  hasNextSibling: boolean;
  inlineEdit: InlineEdit | null;
  node: SidebarTreeNode;
  onAppearance: (entry: SidebarTreeEntry) => void;
  onCreateChild: (entry: SidebarTreeEntry) => void;
  onDelete: (entry: SidebarTreeEntry) => void;
  onEditCancel: () => void;
  onEditNameChange: (name: string) => void;
  onEditSave: () => void;
  onMove: (entry: SidebarTreeEntry) => void;
  onRename: (entry: SidebarTreeEntry) => void;
  onRowFocus: (id: string) => void;
  onRowKeyDown: (event: React.KeyboardEvent<HTMLDivElement>, node: SidebarTreeNode) => void;
  onToggleExpanded: (entry: SidebarTreeEntry) => void;
  onViewChange: (view: AssetView) => void;
  registerTreeRow: (id: string, element: HTMLDivElement | null) => void;
  view: AssetView;
  dragTarget?: ClassificationDropTarget | null;
  onPointerDragStart?: (payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragMove?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragEnd?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragCancel?: (event: React.PointerEvent<HTMLElement>) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const hasChildren = node.children.length > 0;
  const expanded = expandedIds.includes(node.entry.id);
  const selected = node.entry.treeKind === "album"
    ? view.kind === "album" && view.albumId === node.entry.id
    : view.kind === "classification" && view.classificationId === node.entry.id;
  const editingName = inlineEdit?.type === "rename" && inlineEdit.entry.id === node.entry.id;
  const creatingChild = inlineEdit?.type === "create" && inlineEdit.treeKind === node.entry.treeKind && inlineEdit.parentId === node.entry.id;
  const actions: MenuItem[] = [
    { id: "create-child", label: node.entry.treeKind === "album" ? "하위 앨범 만들기" : "하위 폴더 만들기", onSelect: () => onCreateChild(node.entry) },
    { id: "rename", label: "이름 변경", onSelect: () => onRename(node.entry) },
    { id: "appearance", label: "아이콘 및 색상", onSelect: () => onAppearance(node.entry) },
    {
      id: "move",
      label: node.entry.treeKind === "album" ? "앨범 이동" : "폴더 이동",
      onSelect: () => onMove(node.entry),
    },
    {
      id: "delete",
      label: hasChildren ? "삭제 — 하위 폴더 있음" : "삭제",
      destructive: true,
      disabled: hasChildren,
      onSelect: () => onDelete(node.entry),
    },
  ];

  return (
    <li className="classification-sidebar__tree-item" data-has-next-sibling={hasNextSibling ? "true" : undefined}>
      <ContextMenu items={actions}>
        <div
          ref={(element) => {
            rowRef.current = element;
            registerTreeRow(node.entry.id, element);
          }}
          className="classification-sidebar__tree-row"
          data-classification-id={node.entry.treeKind === "classification" ? node.entry.id : undefined}
          data-album-id={node.entry.treeKind === "album" ? node.entry.id : undefined}
          data-drop-state={dragTarget?.kind === node.entry.treeKind && dragTarget.entryId === node.entry.id ? (dragTarget.valid ? "valid" : "invalid") : undefined}
          data-drop-position={dragTarget?.kind === node.entry.treeKind && dragTarget.entryId === node.entry.id ? dragTarget.position : undefined}
          role="treeitem"
          aria-label={node.entry.name}
          aria-selected={selected}
          aria-expanded={hasChildren ? expanded : undefined}
          tabIndex={node.entry.id === activeRowId ? 0 : -1}
          onClick={() => onViewChange(node.entry.treeKind === "album" ? { kind: "album", albumId: node.entry.id } : { kind: "classification", classificationId: node.entry.id })}
          onFocus={() => onRowFocus(node.entry.id)}
          onKeyDown={(event) => {
            if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
                bubbles: true,
                clientX: rect.left + 8,
                clientY: rect.top + 8,
              }));
              return;
            }
            onRowKeyDown(event, node);
          }}
          onPointerDown={(event) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button")) onPointerDragStart?.({ kind: node.entry.treeKind, entryId: node.entry.id }, event); }}
          onPointerMove={onPointerDragMove}
          onPointerUp={onPointerDragEnd}
          onPointerCancel={onPointerDragCancel}
        >
          {hasChildren ? (
            <Button type="button" size="icon" variant="ghost" className="classification-sidebar__tree-toggle" aria-label={`${node.entry.name} ${expanded ? "접기" : "펼치기"}`} onClick={(event) => { event.stopPropagation(); onToggleExpanded(node.entry); }} onKeyDown={(event) => event.stopPropagation()}>
              <span className="classification-sidebar__tree-toggle-mark" data-state={expanded ? "expanded" : "collapsed"} aria-hidden="true" />
            </Button>
          ) : <span className="classification-sidebar__tree-spacer" aria-hidden="true" />}
          <span className="classification-sidebar__tree-surface">
            <ClassificationIcon
              className="classification-sidebar__tree-folder"
              kind={node.entry.kind}
              iconKey={node.entry.iconKey}
              style={{ color: classificationColor(node.entry.colorKey) }}
            />
            {editingName ? (
              <InlineFolderInput name={editName} error={editError} onNameChange={onEditNameChange} onSave={onEditSave} onCancel={onEditCancel} />
            ) : <span className="classification-sidebar__tree-label">{node.entry.name}</span>}
          </span>
        </div>
      </ContextMenu>
      {expanded && (hasChildren || creatingChild) && (
        <ul
          role="group"
          style={{
            "--classification-branch-color": node.entry.colorKey
              ? classificationColor(node.entry.colorKey)
              : "var(--color-sidebar-connector)",
          } as CSSProperties}
        >
          {node.children.map((child, index) => <TreeItem key={child.entry.id} node={child} hasNextSibling={index < node.children.length - 1} view={view} expandedIds={expandedIds} activeRowId={activeRowId} inlineEdit={inlineEdit} editName={editName} editError={editError} onViewChange={onViewChange} onToggleExpanded={onToggleExpanded} onRowFocus={onRowFocus} onRowKeyDown={onRowKeyDown} registerTreeRow={registerTreeRow} onAppearance={onAppearance} onCreateChild={onCreateChild} onRename={onRename} onEditNameChange={onEditNameChange} onEditSave={onEditSave} onEditCancel={onEditCancel} onMove={onMove} onDelete={onDelete} dragTarget={dragTarget} onPointerDragStart={onPointerDragStart} onPointerDragMove={onPointerDragMove} onPointerDragEnd={onPointerDragEnd} onPointerDragCancel={onPointerDragCancel} />)}
          {creatingChild && <InlineFolderEditor name={editName} error={editError} onNameChange={onEditNameChange} onSave={onEditSave} onCancel={onEditCancel} />}
        </ul>
      )}
    </li>
  );
}

function InlineFolderEditor({ error, name, onCancel, onNameChange, onSave }: {
  error: string | null;
  name: string;
  onCancel: () => void;
  onNameChange: (name: string) => void;
  onSave: () => void;
}) {
  return (
    <li className="classification-sidebar__tree-item">
      <div className="classification-sidebar__tree-row classification-sidebar__tree-row--editing">
        <span className="classification-sidebar__tree-spacer" aria-hidden="true" />
        <span className="classification-sidebar__tree-surface">
          <FolderIcon className="classification-sidebar__tree-folder" aria-hidden="true" />
          <InlineFolderInput name={name} error={error} onNameChange={onNameChange} onSave={onSave} onCancel={onCancel} />
        </span>
      </div>
    </li>
  );
}

function InlineFolderInput({ error, name, onCancel, onNameChange, onSave }: {
  error: string | null;
  name: string;
  onCancel: () => void;
  onNameChange: (name: string) => void;
  onSave: () => void;
}) {
  return (
    <span className="classification-sidebar__inline-edit" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      <input
        autoFocus
        aria-label="폴더 이름"
        aria-invalid={Boolean(error)}
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            onSave();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      {error && <span className="classification-sidebar__inline-error" role="alert">{error}</span>}
    </span>
  );
}

function visibleTreeNodes(
  nodes: SidebarTreeNode[],
  expandedIds: string[],
): SidebarTreeNode[] {
  const visible: SidebarTreeNode[] = [];
  const append = (node: SidebarTreeNode) => {
    visible.push(node);
    if (expandedIds.includes(node.entry.id)) {
      node.children.forEach(append);
    }
  };
  nodes.forEach(append);
  return visible;
}

function nearestVisibleTreeRowId(
  focusedId: string | null,
  entries: SidebarTreeEntry[],
  visibleNodes: SidebarTreeNode[],
): string | null {
  const visibleIds = new Set(visibleNodes.map((node) => node.entry.id));
  if (focusedId && visibleIds.has(focusedId)) return focusedId;
  let entry = entries.find((candidate) => candidate.id === focusedId);
  while (entry?.parentId) {
    if (visibleIds.has(entry.parentId)) return entry.parentId;
    entry = entries.find((candidate) => candidate.id === entry?.parentId);
  }
  return visibleNodes[0]?.entry.id ?? null;
}

function DialogActions({ onClose, submitLabel }: { onClose: () => void; submitLabel: string }) {
  return <div className="ui-dialog__actions"><Button type="button" onClick={onClose}>취소</Button><Button type="submit">{submitLabel}</Button></div>;
}

function moveParents(entry: SidebarTreeEntry, entries: SidebarTreeEntry[]): Array<SidebarTreeEntry | null> {
  if (entry.treeKind === "album") {
    return [null, ...entries.filter((candidate) => candidate.id !== entry.id && !isDescendant(candidate.id, entry.id, entries))];
  }
  if (entry.kind === "work") {
    return entries.filter((candidate) => candidate.kind === "root" && candidate.id !== entry.id);
  }
  const parents = entries.filter((candidate) =>
    candidate.id !== entry.id
    && !isDescendant(candidate.id, entry.id, entries),
  );
  return entry.kind === "tag" ? [null, ...parents] : parents;
}

function isDescendant(candidateId: string, ancestorId: string, entries: SidebarTreeEntry[]): boolean {
  let current = entries.find((entry) => entry.id === candidateId);
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    current = entries.find((entry) => entry.id === current?.parentId);
  }
  return false;
}
