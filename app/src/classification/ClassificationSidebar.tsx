import { ChevronDown, ChevronRight, Clock3, Ellipsis, FolderTree, Plus, Star } from "lucide-react";
import { useRef, useState } from "react";
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
  sidebarWidth,
  view,
}: ClassificationSidebarProps) {
  const { gateway } = useLibrary();
  const tree = buildClassificationTree(entries);
  const selected = view.kind === "classification" && view.classificationId
    ? entries.find((entry) => entry.id === view.classificationId) ?? null
    : null;
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ClassificationKind>("root");
  const [parentId, setParentId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const resize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

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
    <aside className="classification-sidebar" aria-label="Classification" style={{ width: sidebarWidth }}>
      <div className="classification-sidebar__heading">
        <h2>Classification</h2>
        <Button type="button" size="icon" variant="ghost" aria-label="Add classification" onClick={openCreate}>
          <Plus aria-hidden="true" />
        </Button>
      </div>
      <nav className="classification-sidebar__quick-views" aria-label="Quick views">
        <QuickViewButton icon={<FolderTree aria-hidden="true" />} label="All assets" selected={view.kind === "classification" && view.classificationId === null} onClick={() => onViewChange({ kind: "classification", classificationId: null })} />
        <QuickViewButton icon={<Star aria-hidden="true" />} label="Favorites" selected={view.kind === "favorites"} onClick={() => onViewChange({ kind: "favorites" })} />
        <QuickViewButton icon={<Clock3 aria-hidden="true" />} label="Recent" selected={view.kind === "recent"} onClick={() => onViewChange({ kind: "recent" })} />
      </nav>
      {tree.orphans.length > 0 && <p className="classification-sidebar__warning" role="alert">Orphaned classifications are hidden.</p>}
      <ul className="classification-sidebar__tree" role="tree">
        {tree.map((node) => (
          <TreeItem
            key={node.entry.id}
            node={node}
            view={view}
            expandedIds={expandedIds}
            onViewChange={onViewChange}
            onToggleExpanded={toggleExpanded}
            onRename={(entry) => { setName(entry.name); setDialog({ type: "rename", entry }); }}
            onMove={(entry) => { setParentId(entry.parentId ?? ""); setDialog({ type: "move", entry }); }}
            onDelete={(entry) => setDialog({ type: "delete", entry })}
          />
        ))}
      </ul>
      <div
        aria-label="Resize sidebar"
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
        <Dialog open title="Add classification" onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            {dialog.kinds.length === 1 ? <p>{kindLabel(dialog.kinds[0])}</p> : (
              <Select label="Type" value={kind} onChange={(event) => setKind(event.target.value as ClassificationKind)}>
                {dialog.kinds.map((option) => <option key={option} value={option}>{kindLabel(option)}</option>)}
              </Select>
            )}
            <TextField autoFocus label="Name" required value={name} onChange={(event) => setName(event.target.value)} />
            <DialogActions onClose={closeDialog} submitLabel="Add" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "rename" && (
        <Dialog open title="Rename classification" onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
            <TextField autoFocus label="Name" required value={name} onChange={(event) => setName(event.target.value)} />
            <DialogActions onClose={closeDialog} submitLabel="Save" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "move" && (
        <Dialog open title="Move classification" onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => { event.preventDefault(); void move(); }}>
            <Select label="Parent" value={parentId} onChange={(event) => setParentId(event.target.value)}>
              {moveParents(dialog.entry, entries).map((parent) => <option key={parent?.id ?? "root"} value={parent?.id ?? ""}>{parent?.name ?? "Top level"}</option>)}
            </Select>
            <DialogActions onClose={closeDialog} submitLabel="Move" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "delete" && (
        <Dialog open title="Delete classification" onClose={closeDialog}>
          <div className="classification-sidebar__form">
            <p>Delete {dialog.entry.name}?</p>
            <div className="ui-dialog__actions">
              <Button type="button" onClick={closeDialog}>Cancel</Button>
              <Button type="button" variant="danger" onClick={() => void remove()}>Delete</Button>
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

function TreeItem({ expandedIds, node, onDelete, onMove, onRename, onToggleExpanded, onViewChange, view }: {
  expandedIds: string[];
  node: ClassificationTreeNode;
  onDelete: (entry: ClassificationEntry) => void;
  onMove: (entry: ClassificationEntry) => void;
  onRename: (entry: ClassificationEntry) => void;
  onToggleExpanded: (id: string) => void;
  onViewChange: (view: AssetView) => void;
  view: AssetView;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const hasChildren = node.children.length > 0;
  const expanded = expandedIds.includes(node.entry.id);
  const selected = view.kind === "classification" && view.classificationId === node.entry.id;
  const actions: MenuItem[] = [
    { id: "rename", label: "Rename", onSelect: () => onRename(node.entry) },
    { id: "move", label: "Move", onSelect: () => onMove(node.entry) },
    { id: "delete", label: "Delete", destructive: true, onSelect: () => onDelete(node.entry) },
  ];

  return (
    <li className="classification-sidebar__tree-item">
      <div
        ref={rowRef}
        className="classification-sidebar__tree-row"
        role="treeitem"
        aria-label={node.entry.name}
        aria-selected={selected}
        aria-expanded={hasChildren ? expanded : undefined}
        tabIndex={0}
        onClick={() => onViewChange({ kind: "classification", classificationId: node.entry.id })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onViewChange({ kind: "classification", classificationId: node.entry.id });
          }
        }}
      >
        {hasChildren ? (
          <Button type="button" size="icon" variant="ghost" aria-label={`${expanded ? "Collapse" : "Expand"} ${node.entry.name}`} onClick={(event) => { event.stopPropagation(); onToggleExpanded(node.entry.id); }}>
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </Button>
        ) : <span className="classification-sidebar__tree-spacer" aria-hidden="true" />}
        <span className="classification-sidebar__tree-label">{node.entry.name}</span>
        <span onClick={(event) => event.stopPropagation()}>
          <Menu label={`More actions for ${node.entry.name}`} items={actions} trigger={<Ellipsis aria-hidden="true" />} contextTarget={rowRef} />
        </span>
      </div>
      {hasChildren && expanded && <ul role="group">{node.children.map((child) => <TreeItem key={child.entry.id} node={child} view={view} expandedIds={expandedIds} onViewChange={onViewChange} onToggleExpanded={onToggleExpanded} onRename={onRename} onMove={onMove} onDelete={onDelete} />)}</ul>}
    </li>
  );
}

function DialogActions({ onClose, submitLabel }: { onClose: () => void; submitLabel: string }) {
  return <div className="ui-dialog__actions"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit">{submitLabel}</Button></div>;
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
  return ({ root: "Top-level classification", work: "Work", tag: "Tag" })[kind];
}
