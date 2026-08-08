import { ChevronDown, ChevronRight, Clock3, Ellipsis, FolderTree, Inbox, Plus, Settings, Star, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { useLibrary } from "../library/LibraryContext";
import type { AssetView, ClassificationEntry, ClassificationKind } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Menu, type MenuItem } from "../shared/ui/Menu";
import { Select } from "../shared/ui/Select";
import { TextField } from "../shared/ui/TextField";
import { Toast } from "../shared/ui/Toast";
import { buildClassificationTree, type ClassificationTreeNode } from "./buildTree";

type ClassificationSidebarProps = {
  entries: ClassificationEntry[];
  view: AssetView;
  expandedIds: string[];
  sidebarWidth: number;
  onViewChange: (view: AssetView) => void;
  onExpandedIdsChange: (ids: string[]) => void;
  onSidebarWidthChange: (width: number) => void;
  onChanged: () => void;
  onOpenSafety?: () => void;
};

type DialogState =
  | { type: "create"; parentId: string | null; kinds: ClassificationKind[] }
  | { type: "rename" | "move" | "delete"; entry: ClassificationEntry };

const MIN_SIDEBAR_WIDTH = 184;
const MAX_SIDEBAR_WIDTH = 360;

export function ClassificationSidebar({
  entries,
  expandedIds,
  onChanged,
  onExpandedIdsChange,
  onSidebarWidthChange,
  onViewChange,
  onOpenSafety,
  sidebarWidth,
  view,
}: ClassificationSidebarProps) {
  const { gateway } = useLibrary();
  const tree = buildClassificationTree(entries);
  const visibleNodes = visibleTreeNodes(tree, expandedIds);
  const selected = view.kind === "classification" && view.classificationId
    ? entries.find((entry) => entry.id === view.classificationId) ?? null
    : null;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ClassificationKind>("root");
  const [parentId, setParentId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
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

  function openCreate() {
    const kinds = createKinds(selected);
    setName("");
    setKind(kinds[0]);
    setDialog({ type: "create", parentId: selected?.id ?? null, kinds });
  }

  async function create() {
    if (!dialog || dialog.type !== "create") return;
    try {
      await gateway.createClassification({ kind, name, parentId: dialog.parentId });
      completeMutation();
    } catch (error) {
      setMessage(commandErrorMessage(error, "분류를 변경하지 못했습니다."));
    }
  }

  async function rename() {
    if (!dialog || dialog.type !== "rename") return;
    try {
      await gateway.renameClassification(dialog.entry.id, name);
      completeMutation();
    } catch (error) {
      setMessage(commandErrorMessage(error, "분류를 변경하지 못했습니다."));
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
      Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, activeResize.startWidth + event.clientX - activeResize.startX))),
    );
  }

  function stopResize(event: React.PointerEvent<HTMLDivElement>) {
    if (resize.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    resize.current = null;
  }

  return (
    <aside className="classification-sidebar" aria-label="분류" style={{ width: sidebarWidth }}>
      <div className="classification-sidebar__heading">
        <h2>분류</h2>
        <Button type="button" size="icon" variant="ghost" aria-label="분류 추가" onClick={openCreate}>
          <Plus aria-hidden="true" />
        </Button>
      </div>
      <nav className="classification-sidebar__quick-views" aria-label="빠른 보기">
        <QuickViewButton icon={<FolderTree aria-hidden="true" />} label="전체 자산" selected={view.kind === "classification" && view.classificationId === null} onClick={() => onViewChange({ kind: "classification", classificationId: null })} />
        <QuickViewButton icon={<Inbox aria-hidden="true" />} label="미분류함" selected={view.kind === "unsorted"} onClick={() => onViewChange({ kind: "unsorted" })} />
        <QuickViewButton icon={<Clock3 aria-hidden="true" />} label="최근" selected={view.kind === "recent"} onClick={() => onViewChange({ kind: "recent" })} />
        <QuickViewButton icon={<Star aria-hidden="true" />} label="즐겨찾기" selected={view.kind === "favorites"} onClick={() => onViewChange({ kind: "favorites" })} />
      </nav>
      {tree.orphans.length > 0 && <p className="classification-sidebar__warning" role="alert">연결되지 않은 분류는 숨겨집니다.</p>}
      <ul className="classification-sidebar__tree" role="tree">
        {tree.map((node) => (
          <TreeItem
            key={node.entry.id}
            node={node}
            view={view}
            expandedIds={expandedIds}
            activeRowId={activeRowId}
            onViewChange={onViewChange}
            onToggleExpanded={toggleExpanded}
            onRowFocus={setFocusedId}
            onRowKeyDown={handleTreeKeyDown}
            registerTreeRow={registerTreeRow}
            onRename={(entry) => { setName(entry.name); setDialog({ type: "rename", entry }); }}
            onMove={(entry) => { setParentId(entry.parentId ?? ""); setDialog({ type: "move", entry }); }}
            onDelete={(entry) => setDialog({ type: "delete", entry })}
          />
        ))}
      </ul>
      <div className="classification-sidebar__footer">
        <QuickViewButton icon={<Trash2 aria-hidden="true" />} label="휴지통" selected={view.kind === "trash"} onClick={() => onViewChange({ kind: "trash" })} />
        {onOpenSafety && (
          <Button type="button" onClick={onOpenSafety}>
            <Settings aria-hidden="true" />
            라이브러리 안전 설정
          </Button>
        )}
      </div>
      <div
        aria-label="사이드바 크기 조절"
        className="classification-sidebar__resize-handle"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startResize}
        onPointerMove={resizeSidebar}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
      />
      {message && <Toast>{message}</Toast>}
      {dialog?.type === "create" && (
        <Dialog open title="분류 추가" onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            {dialog.kinds.length === 1 ? <p>{kindLabel(dialog.kinds[0])}</p> : (
              <Select label="유형" value={kind} onChange={(event) => setKind(event.target.value as ClassificationKind)}>
                {dialog.kinds.map((option) => <option key={option} value={option}>{kindLabel(option)}</option>)}
              </Select>
            )}
            <TextField autoFocus label="이름" required value={name} onChange={(event) => setName(event.target.value)} />
            <DialogActions onClose={closeDialog} submitLabel="추가" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "rename" && (
        <Dialog open title="분류 이름 변경" onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
            <TextField autoFocus label="이름" required value={name} onChange={(event) => setName(event.target.value)} />
            <DialogActions onClose={closeDialog} submitLabel="저장" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "move" && (
        <Dialog open title="분류 이동" onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => { event.preventDefault(); void move(); }}>
            <Select label="상위 분류" value={parentId} onChange={(event) => setParentId(event.target.value)}>
              {moveParents(dialog.entry, entries).map((parent) => <option key={parent?.id ?? "root"} value={parent?.id ?? ""}>{parent?.name ?? "최상위"}</option>)}
            </Select>
            <DialogActions onClose={closeDialog} submitLabel="이동" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "delete" && (
        <Dialog open title="분류 삭제" onClose={closeDialog}>
          <div className="classification-sidebar__form">
            <p>{dialog.entry.name} 분류를 삭제할까요?</p>
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

function QuickViewButton({ icon, label, onClick, selected }: { icon: React.ReactNode; label: string; onClick: () => void; selected: boolean }) {
  return <button type="button" className="classification-sidebar__quick-view" aria-current={selected ? "page" : undefined} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function TreeItem({ activeRowId, expandedIds, node, onDelete, onMove, onRename, onRowFocus, onRowKeyDown, onToggleExpanded, onViewChange, registerTreeRow, view }: {
  activeRowId: string | null;
  expandedIds: string[];
  node: ClassificationTreeNode;
  onDelete: (entry: ClassificationEntry) => void;
  onMove: (entry: ClassificationEntry) => void;
  onRename: (entry: ClassificationEntry) => void;
  onRowFocus: (id: string) => void;
  onRowKeyDown: (event: React.KeyboardEvent<HTMLDivElement>, node: ClassificationTreeNode) => void;
  onToggleExpanded: (id: string) => void;
  onViewChange: (view: AssetView) => void;
  registerTreeRow: (id: string, element: HTMLDivElement | null) => void;
  view: AssetView;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const hasChildren = node.children.length > 0;
  const expanded = expandedIds.includes(node.entry.id);
  const selected = view.kind === "classification" && view.classificationId === node.entry.id;
  const actions: MenuItem[] = [
    { id: "rename", label: "이름 변경", onSelect: () => onRename(node.entry) },
    { id: "move", label: "이동", onSelect: () => onMove(node.entry) },
    { id: "delete", label: "삭제", destructive: true, onSelect: () => onDelete(node.entry) },
  ];

  return (
    <li className="classification-sidebar__tree-item">
      <div
        ref={(element) => {
          rowRef.current = element;
          registerTreeRow(node.entry.id, element);
        }}
        className="classification-sidebar__tree-row"
        role="treeitem"
        aria-label={node.entry.name}
        aria-selected={selected}
        aria-expanded={hasChildren ? expanded : undefined}
        tabIndex={node.entry.id === activeRowId ? 0 : -1}
        onClick={() => onViewChange({ kind: "classification", classificationId: node.entry.id })}
        onFocus={() => onRowFocus(node.entry.id)}
        onKeyDown={(event) => onRowKeyDown(event, node)}
      >
        {hasChildren ? (
          <Button type="button" size="icon" variant="ghost" aria-label={`${node.entry.name} ${expanded ? "접기" : "펼치기"}`} onClick={(event) => { event.stopPropagation(); onToggleExpanded(node.entry.id); }} onKeyDown={(event) => event.stopPropagation()}>
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </Button>
        ) : <span className="classification-sidebar__tree-spacer" aria-hidden="true" />}
        <span className="classification-sidebar__tree-label">{node.entry.name}</span>
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Menu label={`${node.entry.name} 추가 작업`} items={actions} trigger={<Ellipsis aria-hidden="true" />} contextTarget={rowRef} />
        </span>
      </div>
      {hasChildren && expanded && <ul role="group">{node.children.map((child) => <TreeItem key={child.entry.id} node={child} view={view} expandedIds={expandedIds} activeRowId={activeRowId} onViewChange={onViewChange} onToggleExpanded={onToggleExpanded} onRowFocus={onRowFocus} onRowKeyDown={onRowKeyDown} registerTreeRow={registerTreeRow} onRename={onRename} onMove={onMove} onDelete={onDelete} />)}</ul>}
    </li>
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

function createKinds(selected: ClassificationEntry | null): ClassificationKind[] {
  if (!selected) return ["root"];
  if (selected.kind === "root") return ["work", "tag"];
  return ["tag"];
}

function moveParents(entry: ClassificationEntry, entries: ClassificationEntry[]): Array<ClassificationEntry | null> {
  if (entry.kind === "root") return [null];
  const allowedKinds: ClassificationKind[] = entry.kind === "work" ? ["root"] : ["root", "work", "tag"];
  return entries.filter((candidate) => candidate.id !== entry.id && allowedKinds.includes(candidate.kind));
}

function kindLabel(kind: ClassificationKind): string {
  return ({ root: "최상위 분류", work: "작품", tag: "태그" })[kind];
}
