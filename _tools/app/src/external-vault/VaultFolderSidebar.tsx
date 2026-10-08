import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRightIcon, FolderIcon, InboxIcon, PlusIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import { buildTree, type TreeNode } from "../classification/buildTree";
import type { EncryptedVaultFolder } from "../library/types";
import { Button } from "../shared/ui/Button";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { Dialog } from "../shared/ui/Dialog";
import "../classification/ClassificationSidebar.css";

/** What the vault gallery shows: everything, items in no folder, or one folder with its descendants. */
export type VaultScope = { kind: "all" } | { kind: "unfiled" } | { kind: "folder"; folderId: string };

/** Drop target of a vault drag: a folder id, or `null` for "take out of every folder". */
export type VaultDropTarget = { folderId: string | null } | null;

type FolderEntry = EncryptedVaultFolder & { parentId: string | null };
type FolderNode = TreeNode<FolderEntry>;
type InlineEdit = { type: "create"; parentId: string | null } | { type: "rename"; folderId: string };

type Props = {
  folders: EncryptedVaultFolder[];
  scope: VaultScope;
  onScopeChange: (scope: VaultScope) => void;
  totalCount: number | null;
  readOnly: boolean;
  dropTarget: VaultDropTarget;
  /** Each returns an error message, or null on success. */
  onCreate: (name: string, parentId: string | null) => Promise<string | null>;
  onRename: (folderId: string, name: string) => Promise<string | null>;
  onDelete: (folder: EncryptedVaultFolder) => void;
  onMove: (folder: EncryptedVaultFolder) => void;
};

/** The vault's index: 전체, 미분류 and the folder tree, styled like the Assets folder tree. */
export function VaultFolderSidebar({ folders, scope, onScopeChange, totalCount, readOnly, dropTarget, onCreate, onRename, onDelete, onMove }: Props) {
  const tree = useMemo(() => buildTree(folders), [folders]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState(true);
  const [edit, setEdit] = useState<InlineEdit | null>(null);
  const [name, setName] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const filed = tree.reduce((sum, node) => sum + node.entry.totalItemCount, 0);
  const unfiledCount = totalCount === null ? undefined : Math.max(0, totalCount - filed);

  function toggle(folderId: string, value?: boolean) {
    setExpanded((current) => {
      const next = new Set(current);
      if (value ?? !next.has(folderId)) next.add(folderId); else next.delete(folderId);
      return next;
    });
  }

  function startCreate(parentId: string | null) {
    if (readOnly) return;
    if (parentId) toggle(parentId, true);
    setOpen(true);
    setEdit({ type: "create", parentId });
    setName("");
    setEditError(null);
  }

  function startRename(folder: EncryptedVaultFolder) {
    if (readOnly) return;
    setEdit({ type: "rename", folderId: folder.id });
    setName(folder.name);
    setEditError(null);
  }

  async function save() {
    if (!edit) return;
    const trimmed = name.trim();
    if (!trimmed) { cancel(); return; }
    const error = edit.type === "create" ? await onCreate(trimmed, edit.parentId) : await onRename(edit.folderId, trimmed);
    if (error) { setEditError(error); return; }
    cancel();
  }

  function cancel() {
    setEdit(null);
    setName("");
    setEditError(null);
  }

  const editor = { edit, name, error: editError, onNameChange: (value: string) => { setName(value); setEditError(null); }, onSave: () => void save(), onCancel: cancel };
  const dropState = (folderId: string | null) => dropTarget && dropTarget.folderId === folderId ? "valid" : undefined;

  return <div className="classification-sidebar vault-folder-sidebar">
    <nav className="classification-sidebar__quick-views" aria-label="빠른 보기">
      <QuickView icon={<Squares2X2Icon aria-hidden="true" />} label="전체" count={totalCount ?? undefined} selected={scope.kind === "all"} onClick={() => onScopeChange({ kind: "all" })} />
      <QuickView icon={<InboxIcon aria-hidden="true" />} label="미분류" count={unfiledCount} selected={scope.kind === "unfiled"} dropState={dropState(null)} dropFolderId="" onClick={() => onScopeChange({ kind: "unfiled" })} />
    </nav>
    <section className="classification-sidebar__folder-section" aria-label="폴더 탐색">
      <div className="chrome-tree-heading">
        <button type="button" className="classification-sidebar__tree-heading" aria-expanded={open} aria-label={`폴더 ${open ? "접기" : "펼치기"}`} onClick={() => setOpen((value) => !value)}>
          <ChevronRightIcon aria-hidden="true" />
          <span>폴더</span>
        </button>
        <Button type="button" size="icon" variant="ghost" aria-label="새 폴더" disabled={readOnly} onClick={() => startCreate(null)}><PlusIcon aria-hidden="true" /></Button>
      </div>
      <ContextMenu items={readOnly ? [] : [{ id: "create-root", label: "새 폴더", onSelect: () => startCreate(null) }]}>
        <div className="classification-sidebar__reveal" data-open={open} aria-hidden={!open} inert={!open || undefined}>
          <ul className="classification-sidebar__tree" role="tree" aria-label="폴더">
            {tree.map((node, index) => <FolderItem key={node.entry.id} node={node} hasNextSibling={index < tree.length - 1} scope={scope} expanded={expanded} readOnly={readOnly}
              editor={editor} dropState={dropState} onSelect={(folderId) => onScopeChange({ kind: "folder", folderId })} onToggle={toggle}
              onCreateChild={startCreate} onRename={startRename} onDelete={onDelete} onMove={onMove} />)}
            {edit?.type === "create" && edit.parentId === null && <InlineEditor {...editor} />}
          </ul>
          {tree.length === 0 && edit === null && <p className="vault-folder-sidebar__empty">폴더를 만들어 항목을 끌어다 놓으세요.</p>}
        </div>
      </ContextMenu>
    </section>
  </div>;
}

type Editor = { edit: InlineEdit | null; name: string; error: string | null; onNameChange: (value: string) => void; onSave: () => void; onCancel: () => void };

function FolderItem({ node, hasNextSibling, scope, expanded, readOnly, editor, dropState, onSelect, onToggle, onCreateChild, onRename, onDelete, onMove }: {
  node: FolderNode;
  hasNextSibling: boolean;
  scope: VaultScope;
  expanded: ReadonlySet<string>;
  readOnly: boolean;
  editor: Editor;
  dropState: (folderId: string | null) => "valid" | undefined;
  onSelect: (folderId: string) => void;
  onToggle: (folderId: string, value?: boolean) => void;
  onCreateChild: (parentId: string) => void;
  onRename: (folder: EncryptedVaultFolder) => void;
  onDelete: (folder: EncryptedVaultFolder) => void;
  onMove: (folder: EncryptedVaultFolder) => void;
}) {
  const folder = node.entry;
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(folder.id);
  const selected = scope.kind === "folder" && scope.folderId === folder.id;
  const renaming = editor.edit?.type === "rename" && editor.edit.folderId === folder.id;
  const creatingChild = editor.edit?.type === "create" && editor.edit.parentId === folder.id;
  const actions: ContextMenuItem[] = readOnly ? [] : [
    { id: "create-child", label: "하위 폴더 만들기", onSelect: () => onCreateChild(folder.id) },
    { id: "rename", label: "이름 변경", onSelect: () => onRename(folder) },
    { id: "move", label: "폴더 이동", onSelect: () => onMove(folder) },
    { id: "delete", label: hasChildren ? "삭제 — 하위 폴더 있음" : "삭제", destructive: true, disabled: hasChildren, onSelect: () => onDelete(folder) },
  ];
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(folder.id); }
    else if (event.key === "ArrowRight" && hasChildren) { event.preventDefault(); onToggle(folder.id, true); }
    else if (event.key === "ArrowLeft" && hasChildren) { event.preventDefault(); onToggle(folder.id, false); }
    else if (event.key === "F2") { event.preventDefault(); onRename(folder); }
  }
  return <li className="classification-sidebar__tree-item" data-has-next-sibling={hasNextSibling ? "true" : undefined}>
    <ContextMenu items={actions}>
      <div className="classification-sidebar__tree-row" role="treeitem" tabIndex={0} aria-label={folder.name} aria-selected={selected}
        aria-expanded={hasChildren ? isOpen : undefined} data-vault-folder-id={folder.id} data-drop-state={dropState(folder.id)} data-drop-position={dropState(folder.id) ? "inside" : undefined}
        onClick={() => onSelect(folder.id)} onKeyDown={keyDown}>
        {hasChildren
          ? <Button type="button" size="icon" variant="ghost" className="classification-sidebar__tree-toggle" aria-label={`${folder.name} ${isOpen ? "접기" : "펼치기"}`}
            onClick={(event) => { event.stopPropagation(); onToggle(folder.id); }} onKeyDown={(event) => event.stopPropagation()}>
            <span className="classification-sidebar__tree-toggle-mark" data-state={isOpen ? "expanded" : "collapsed"} aria-hidden="true" />
          </Button>
          : <span className="classification-sidebar__tree-spacer" aria-hidden="true" />}
        <span className="classification-sidebar__tree-surface">
          <FolderIcon className="classification-sidebar__tree-folder" aria-hidden="true" />
          {renaming ? <InlineInput {...editor} /> : <span className="classification-sidebar__tree-label">{folder.name}</span>}
          {folder.totalItemCount ? <span className="classification-sidebar__badge classification-sidebar__hover-count" aria-hidden="true">{folder.totalItemCount.toLocaleString("ko-KR")}</span> : null}
        </span>
      </div>
    </ContextMenu>
    {(hasChildren || creatingChild) && <div className="classification-sidebar__reveal" data-open={isOpen || creatingChild} aria-hidden={!(isOpen || creatingChild)} inert={!(isOpen || creatingChild) || undefined}>
      <ul role="group">
        {(isOpen || creatingChild) && node.children.map((child, index) => <FolderItem key={child.entry.id} node={child} hasNextSibling={index < node.children.length - 1} scope={scope} expanded={expanded}
          readOnly={readOnly} editor={editor} dropState={dropState} onSelect={onSelect} onToggle={onToggle} onCreateChild={onCreateChild} onRename={onRename} onDelete={onDelete} onMove={onMove} />)}
        {creatingChild && <InlineEditor {...editor} />}
      </ul>
    </div>}
  </li>;
}

function QuickView({ icon, label, count, selected, onClick, dropState, dropFolderId }: { icon: ReactNode; label: string; count?: number; selected: boolean; onClick: () => void; dropState?: "valid"; dropFolderId?: string }) {
  return <button type="button" className="classification-sidebar__quick-view" aria-current={selected ? "page" : undefined} onClick={onClick}
    aria-label={count === undefined ? undefined : `${label} ${count.toLocaleString("ko-KR")}개`} data-vault-folder-id={dropFolderId} data-drop-state={dropState}>
    <span className="classification-sidebar__quick-view-surface">
      {icon}
      <span className="classification-sidebar__quick-view-label">{label}</span>
      {count !== undefined && <span className="classification-sidebar__badge classification-sidebar__hover-count" aria-hidden="true">{count.toLocaleString("ko-KR")}</span>}
    </span>
  </button>;
}

function InlineEditor(editor: Editor) {
  return <li className="classification-sidebar__tree-item">
    <div className="classification-sidebar__tree-row classification-sidebar__tree-row--editing">
      <span className="classification-sidebar__tree-spacer" aria-hidden="true" />
      <span className="classification-sidebar__tree-surface">
        <FolderIcon className="classification-sidebar__tree-folder" aria-hidden="true" />
        <InlineInput {...editor} />
      </span>
    </div>
  </li>;
}

function InlineInput({ name, error, onNameChange, onSave, onCancel }: Editor) {
  return <span className="classification-sidebar__inline-edit" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
    <input autoFocus aria-label="폴더 이름" aria-invalid={Boolean(error)} maxLength={100} value={name} onChange={(event) => onNameChange(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") { event.preventDefault(); onSave(); }
        else if (event.key === "Escape") { event.preventDefault(); onCancel(); }
      }} />
    {error && <span className="classification-sidebar__inline-error" role="alert">{error}</span>}
  </span>;
}

/**
 * Picks a destination folder. `excludeId` hides a folder and its descendants (moving a folder
 * into itself); `noneLabel` names the "no folder" choice (unfiled for items, top level for folders).
 */
export function VaultFolderPicker({ title, folders, currentId, excludeId, noneLabel, busy, error, onPick, onClose }: {
  title: string;
  folders: EncryptedVaultFolder[];
  currentId: string | null;
  excludeId?: string;
  noneLabel: string;
  busy: boolean;
  error: string | null;
  onPick: (folderId: string | null) => void;
  onClose: () => void;
}) {
  const rows = useMemo(() => {
    const flat: Array<{ folder: EncryptedVaultFolder; depth: number }> = [];
    const walk = (nodes: FolderNode[], depth: number) => {
      for (const node of nodes) {
        if (node.entry.id === excludeId) continue;
        flat.push({ folder: node.entry, depth });
        walk(node.children, depth + 1);
      }
    };
    walk(buildTree(folders), 0);
    return flat;
  }, [folders, excludeId]);
  const [picked, setPicked] = useState<string | null>(currentId);
  return <Dialog open title={title} onClose={() => { if (!busy) onClose(); }}>
    <div className="vault-folder-picker" role="radiogroup" aria-label="대상 폴더">
      <label className="vault-folder-picker__row">
        <input type="radio" name="vault-folder-target" checked={picked === null} onChange={() => setPicked(null)} />
        <InboxIcon aria-hidden="true" /><span>{noneLabel}</span>
      </label>
      {rows.map(({ folder, depth }) => <label key={folder.id} className="vault-folder-picker__row" style={{ paddingInlineStart: `calc(${depth} * var(--space-4, 16px))` }}>
        <input type="radio" name="vault-folder-target" checked={picked === folder.id} onChange={() => setPicked(folder.id)} />
        <FolderIcon aria-hidden="true" /><span>{folder.name}</span>
      </label>)}
    </div>
    {error && <p className="external-vault-editor__error" role="alert">{error}</p>}
    <div className="ui-dialog__actions">
      <Button disabled={busy} onClick={onClose}>취소</Button>
      <Button variant="primary" disabled={busy || picked === currentId} onClick={() => onPick(picked)}>이동</Button>
    </div>
  </Dialog>;
}
