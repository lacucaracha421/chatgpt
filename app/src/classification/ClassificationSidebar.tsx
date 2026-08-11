import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, EllipsisHorizontalIcon, FolderIcon, PhotoIcon, InboxIcon, PlusIcon, Cog6ToothIcon, StarIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useLayoutEffect, useEffect, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { useLibrary } from "../library/LibraryContext";
import type { AssetView, ClassificationEntry } from "../library/types";
import { clampSidebarWidth } from "../layout/sidebarWidth";
import { Button } from "../shared/ui/Button";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { Dialog } from "../shared/ui/Dialog";
import { Menu, type MenuItem } from "../shared/ui/Menu";
import { Select } from "../shared/ui/Select";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import type { ClassificationDropTarget, InternalDragPayload } from "../shared/interaction/pointerDrag";
import { buildClassificationTree, type ClassificationTreeNode } from "./buildTree";

type ClassificationSidebarProps = {
  entries: ClassificationEntry[];
  view: AssetView;
  expandedIds: string[];
  sidebarWidth: number;
  reviewCount: number;
  createClassificationRequest?: number;
  onViewChange: (view: AssetView) => void;
  onExpandedIdsChange: (ids: string[]) => void;
  onSidebarWidthChange: (width: number) => void;
  onChanged: () => void;
  dragTarget?: ClassificationDropTarget | null;
  onPointerDragStart?: (payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragMove?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragEnd?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragCancel?: (event: React.PointerEvent<HTMLElement>) => void;
};

type DialogState =
  { type: "move" | "delete"; entry: ClassificationEntry };

type InlineEdit =
  | { type: "create"; parentId: string | null; kind: "root" | "tag" }
  | { type: "rename"; entry: ClassificationEntry };

export function ClassificationSidebar({
  entries,
  expandedIds,
  onChanged,
  onExpandedIdsChange,
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
  const tree = buildClassificationTree(entries);
  const visibleNodes = visibleTreeNodes(tree, expandedIds);
  const selected = view.kind === "classification" && view.classificationId
    ? entries.find((entry) => entry.id === view.classificationId) ?? null
    : null;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [name, setName] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [parentId, setParentId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useAutoDismiss(message, setMessage);
  const resize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const activeRowId = nearestVisibleTreeRowId(focusedId, entries, visibleNodes);

  useLayoutEffect(() => {
    if (focusedId && activeRowId && focusedId !== activeRowId) {
      setFocusedId(activeRowId);
      rowRefs.current.get(activeRowId)?.focus();
    }
  }, [activeRowId, focusedId]);

  function closeDialog() {
    setDialog(null);
  }

  function completeMutation() {
    setMessage(null);
    closeDialog();
    onChanged();
  }

  function beginInlineEdit(edit: InlineEdit, initialName = "") {
    setInlineEdit(edit);
    setEditError(null);
    setName(initialName);
  }

  function openTopLevelCreate() {
    beginInlineEdit({ type: "create", parentId: null, kind: "root" });
  }

  function openChildCreate(entry: ClassificationEntry) {
    if (!expandedIds.includes(entry.id)) onExpandedIdsChange([...expandedIds, entry.id]);
    beginInlineEdit({ type: "create", parentId: entry.id, kind: "tag" });
  }

  function openRename(entry: ClassificationEntry) {
    beginInlineEdit({ type: "rename", entry }, entry.name);
  }

  function cancelInlineEdit() {
    setInlineEdit(null);
    setEditError(null);
    setName("");
  }

  useEffect(() => {
    if (createClassificationRequest > 0) openTopLevelCreate();
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
        await gateway.createClassification({
          kind: inlineEdit.kind,
          name: trimmedName,
          parentId: inlineEdit.parentId,
        });
      } else {
        await gateway.renameClassification(inlineEdit.entry.id, trimmedName);
      }
      cancelInlineEdit();
      onChanged();
    } catch (error) {
      setEditError(commandErrorMessage(error, "폴더를 변경하지 못했습니다."));
    }
  }

  async function move() {
    if (!dialog || dialog.type !== "move") return;
    try {
      await gateway.moveClassification(dialog.entry.id, parentId || null);
      completeMutation();
    } catch (error) {
      setMessage(commandErrorMessage(error, "분류를 변경하지 못했습니다."));
    }
  }

  async function remove() {
    if (!dialog || dialog.type !== "delete") return;
    try {
      await gateway.deleteClassification(dialog.entry.id);
      completeMutation();
    } catch (error) {
      setMessage(commandErrorMessage(error, "분류를 변경하지 못했습니다."));
    }
  }

  function toggleExpanded(id: string) {
    onExpandedIdsChange(
      expandedIds.includes(id)
        ? expandedIds.filter((expandedId) => expandedId !== id)
        : [...expandedIds, id],
    );
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
      openTopLevelCreate();
    } else if (key === "n" && event.altKey && !event.ctrlKey && selected) {
      event.preventDefault();
      openChildCreate(selected);
    } else if (event.key === "F2" && selected) {
      event.preventDefault();
      openRename(selected);
    } else if (event.key === "Delete" && selected) {
      event.preventDefault();
      setDialog({ type: "delete", entry: selected });
    }
  }

  function handleTreeKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
    node: ClassificationTreeNode,
  ) {
    const index = visibleNodes.indexOf(node);
    const parentId = node.entry.parentId;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusTreeRow(visibleNodes[Math.min(index + 1, visibleNodes.length - 1)]?.entry.id ?? node.entry.id);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusTreeRow(visibleNodes[Math.max(index - 1, 0)]?.entry.id ?? node.entry.id);
        break;
      case "Home":
        event.preventDefault();
        focusTreeRow(visibleNodes[0]?.entry.id ?? node.entry.id);
        break;
      case "End":
        event.preventDefault();
        focusTreeRow(visibleNodes[visibleNodes.length - 1]?.entry.id ?? node.entry.id);
        break;
      case "ArrowRight":
        if (node.children.length === 0) return;
        event.preventDefault();
        if (expandedIds.includes(node.entry.id)) {
          focusTreeRow(node.children[0].entry.id);
        } else {
          toggleExpanded(node.entry.id);
        }
        break;
      case "ArrowLeft":
        if (node.children.length > 0 && expandedIds.includes(node.entry.id)) {
          event.preventDefault();
          toggleExpanded(node.entry.id);
        } else if (parentId) {
          event.preventDefault();
          focusTreeRow(parentId);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        onViewChange({ kind: "classification", classificationId: node.entry.id });
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
        <Button type="button" size="icon" variant="ghost" aria-label="새 폴더" onClick={openTopLevelCreate}>
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
      <ContextMenu items={[{ id: "create-root", label: "새 폴더", onSelect: openTopLevelCreate }]}>
        <ul className="classification-sidebar__tree" role="tree">
          {tree.map((node) => (
            <TreeItem
              key={node.entry.id}
              node={node}
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
              onEditNameChange={(nextName) => { setName(nextName); setEditError(null); }}
              onEditSave={() => void saveInlineEdit()}
              onEditCancel={cancelInlineEdit}
              onMove={(entry) => { setParentId(entry.parentId ?? ""); setDialog({ type: "move", entry }); }}
              onDelete={(entry) => setDialog({ type: "delete", entry })}
              dragTarget={dragTarget}
              onPointerDragStart={onPointerDragStart}
              onPointerDragMove={onPointerDragMove}
              onPointerDragEnd={onPointerDragEnd}
              onPointerDragCancel={onPointerDragCancel}
            />
          ))}
          {inlineEdit?.type === "create" && inlineEdit.parentId === null && (
            <InlineFolderEditor name={name} error={editError} onNameChange={(nextName) => { setName(nextName); setEditError(null); }} onSave={() => void saveInlineEdit()} onCancel={cancelInlineEdit} />
          )}
        </ul>
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
      {message && <Toast>{message}</Toast>}
      {dialog?.type === "move" && (
        <Dialog open title="폴더 이동" onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => { event.preventDefault(); void move(); }}>
            <Select label="상위 폴더" value={parentId} onChange={(event) => setParentId(event.target.value)}>
              {moveParents(dialog.entry, entries).map((parent) => <option key={parent?.id ?? "root"} value={parent?.id ?? ""}>{parent?.name ?? "최상위"}</option>)}
            </Select>
            <DialogActions onClose={closeDialog} submitLabel="이동" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "delete" && (
        <Dialog open title="폴더 삭제" onClose={closeDialog}>
          <div className="classification-sidebar__form">
            <p>{dialog.entry.name} 폴더를 삭제할까요?</p>
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
  return <button type="button" className="classification-sidebar__quick-view" aria-label={count === undefined ? undefined : `${label} ${count}개`} aria-current={selected ? "page" : undefined} onClick={onClick}>{icon}<span>{label}</span>{count !== undefined && <span className="classification-sidebar__badge" aria-hidden="true">{count}</span>}</button>;
}

function TreeItem({ activeRowId, editError, editName, expandedIds, inlineEdit, node, onCreateChild, onDelete, onEditCancel, onEditNameChange, onEditSave, onMove, onRename, onRowFocus, onRowKeyDown, onToggleExpanded, onViewChange, registerTreeRow, view, dragTarget, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: {
  activeRowId: string | null;
  editError: string | null;
  editName: string;
  expandedIds: string[];
  inlineEdit: InlineEdit | null;
  node: ClassificationTreeNode;
  onCreateChild: (entry: ClassificationEntry) => void;
  onDelete: (entry: ClassificationEntry) => void;
  onEditCancel: () => void;
  onEditNameChange: (name: string) => void;
  onEditSave: () => void;
  onMove: (entry: ClassificationEntry) => void;
  onRename: (entry: ClassificationEntry) => void;
  onRowFocus: (id: string) => void;
  onRowKeyDown: (event: React.KeyboardEvent<HTMLDivElement>, node: ClassificationTreeNode) => void;
  onToggleExpanded: (id: string) => void;
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
  const selected = view.kind === "classification" && view.classificationId === node.entry.id;
  const editingName = inlineEdit?.type === "rename" && inlineEdit.entry.id === node.entry.id;
  const creatingChild = inlineEdit?.type === "create" && inlineEdit.parentId === node.entry.id;
  const actions: MenuItem[] = [
    { id: "create-child", label: "하위 폴더 만들기", onSelect: () => onCreateChild(node.entry) },
    { id: "rename", label: "이름 변경", onSelect: () => onRename(node.entry) },
    { id: "move", label: "폴더 이동", onSelect: () => onMove(node.entry) },
    { id: "delete", label: "삭제", destructive: true, onSelect: () => onDelete(node.entry) },
  ];

  return (
    <li className="classification-sidebar__tree-item">
      <ContextMenu items={actions}>
        <div
          ref={(element) => {
            rowRef.current = element;
            registerTreeRow(node.entry.id, element);
          }}
          className="classification-sidebar__tree-row"
          data-classification-id={node.entry.id}
          data-drop-state={dragTarget?.entryId === node.entry.id ? (dragTarget.valid ? "valid" : "invalid") : undefined}
          data-drop-position={dragTarget?.entryId === node.entry.id ? dragTarget.position : undefined}
          role="treeitem"
          aria-label={node.entry.name}
          aria-selected={selected}
          aria-expanded={hasChildren ? expanded : undefined}
          tabIndex={node.entry.id === activeRowId ? 0 : -1}
          onClick={() => onViewChange({ kind: "classification", classificationId: node.entry.id })}
          onFocus={() => onRowFocus(node.entry.id)}
          onKeyDown={(event) => onRowKeyDown(event, node)}
          onPointerDown={(event) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button")) onPointerDragStart?.({ kind: "classification", entryId: node.entry.id }, event); }}
          onPointerMove={onPointerDragMove}
          onPointerUp={onPointerDragEnd}
          onPointerCancel={onPointerDragCancel}
        >
          {hasChildren ? (
            <Button type="button" size="icon" variant="ghost" aria-label={`${node.entry.name} ${expanded ? "접기" : "펼치기"}`} onClick={(event) => { event.stopPropagation(); onToggleExpanded(node.entry.id); }} onKeyDown={(event) => event.stopPropagation()}>
              {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
            </Button>
          ) : <span className="classification-sidebar__tree-spacer" aria-hidden="true" />}
          <FolderIcon className="classification-sidebar__tree-folder" aria-hidden="true" />
          {editingName ? (
            <InlineFolderInput name={editName} error={editError} onNameChange={onEditNameChange} onSave={onEditSave} onCancel={onEditCancel} />
          ) : <span className="classification-sidebar__tree-label">{node.entry.name}</span>}
          <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <Menu label={`${node.entry.name} 추가 작업`} items={actions} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} />
          </span>
        </div>
      </ContextMenu>
      {expanded && (hasChildren || creatingChild) && (
        <ul role="group">
          {node.children.map((child) => <TreeItem key={child.entry.id} node={child} view={view} expandedIds={expandedIds} activeRowId={activeRowId} inlineEdit={inlineEdit} editName={editName} editError={editError} onViewChange={onViewChange} onToggleExpanded={onToggleExpanded} onRowFocus={onRowFocus} onRowKeyDown={onRowKeyDown} registerTreeRow={registerTreeRow} onCreateChild={onCreateChild} onRename={onRename} onEditNameChange={onEditNameChange} onEditSave={onEditSave} onEditCancel={onEditCancel} onMove={onMove} onDelete={onDelete} dragTarget={dragTarget} onPointerDragStart={onPointerDragStart} onPointerDragMove={onPointerDragMove} onPointerDragEnd={onPointerDragEnd} onPointerDragCancel={onPointerDragCancel} />)}
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
        <FolderIcon className="classification-sidebar__tree-folder" aria-hidden="true" />
        <InlineFolderInput name={name} error={error} onNameChange={onNameChange} onSave={onSave} onCancel={onCancel} />
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
  nodes: ClassificationTreeNode[],
  expandedIds: string[],
): ClassificationTreeNode[] {
  const visible: ClassificationTreeNode[] = [];
  const append = (node: ClassificationTreeNode) => {
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
  entries: ClassificationEntry[],
  visibleNodes: ClassificationTreeNode[],
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

function moveParents(entry: ClassificationEntry, entries: ClassificationEntry[]): Array<ClassificationEntry | null> {
  if (entry.kind === "root") return [null];
  const allowedKinds = entry.kind === "work" ? ["root"] : ["root", "work", "tag"];
  return entries.filter((candidate) =>
    candidate.id !== entry.id
    && allowedKinds.includes(candidate.kind)
    && !isDescendant(candidate.id, entry.id, entries),
  );
}

function isDescendant(candidateId: string, ancestorId: string, entries: ClassificationEntry[]): boolean {
  let current = entries.find((entry) => entry.id === candidateId);
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    current = entries.find((entry) => entry.id === current?.parentId);
  }
  return false;
}
