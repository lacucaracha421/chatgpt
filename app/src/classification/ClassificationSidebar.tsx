import { useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { ClassificationEntry, ClassificationKind } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { TextField } from "../shared/ui/TextField";
import { Toast } from "../shared/ui/Toast";
import { buildClassificationTree, type ClassificationTreeNode } from "./buildTree";

type ClassificationSidebarProps = {
  entries: ClassificationEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
};

type DialogState =
  | {
      type: "create";
      parentId: string | null;
      kinds: ClassificationKind[];
    }
  | { type: "rename" | "move" | "delete"; entry: ClassificationEntry };

export function ClassificationSidebar({
  entries,
  selectedId,
  onChanged,
  onSelect,
}: ClassificationSidebarProps) {
  const { gateway } = useLibrary();
  const tree = buildClassificationTree(entries);
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ClassificationKind>("root");
  const [parentId, setParentId] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  function closeDialog() {
    setDialog(null);
  }

  function openCreate() {
    const kinds = createKinds(selected);
    setName("");
    setKind(kinds[0]);
    setDialog({ type: "create", parentId: selected?.id ?? null, kinds });
  }

  function openRename() {
    if (!selected) return;
    setName(selected.name);
    setDialog({ type: "rename", entry: selected });
  }

  function openMove() {
    if (!selected) return;
    setParentId(selected.parentId ?? "");
    setDialog({ type: "move", entry: selected });
  }

  async function create() {
    if (!dialog || dialog.type !== "create") return;
    try {
      await gateway.createClassification({
        kind,
        name,
        parentId: dialog.parentId,
      });
      closeDialog();
      onChanged();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function rename() {
    if (!dialog || dialog.type !== "rename") return;
    try {
      await gateway.renameClassification(dialog.entry.id, name);
      closeDialog();
      onChanged();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function move() {
    if (!dialog || dialog.type !== "move") return;
    try {
      await gateway.moveClassification(dialog.entry.id, parentId || null);
      closeDialog();
      onChanged();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function remove() {
    if (!dialog || dialog.type !== "delete") return;
    try {
      await gateway.deleteClassification(dialog.entry.id);
      closeDialog();
      onChanged();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  return (
    <aside className="classification-sidebar" aria-label="분류">
      <div className="classification-sidebar__heading">
        <h2>분류</h2>
        <Button type="button" onClick={openCreate}>
          {selected ? "하위 항목 추가" : "최상위 분류 추가"}
        </Button>
      </div>
      {tree.orphans.length > 0 && (
        <p className="classification-sidebar__warning" role="alert">
          고아 분류 항목이 있어 표시하지 않았습니다.
        </p>
      )}
      <ul className="classification-sidebar__tree" role="tree">
        {tree.map((node) => (
          <TreeItem
            key={node.entry.id}
            node={node}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
      {selected && (
        <div className="classification-sidebar__actions">
          <Button type="button" onClick={openRename}>
            이름 변경
          </Button>
          <Button type="button" onClick={openMove}>
            이동
          </Button>
          <Button type="button" onClick={() => setDialog({ type: "delete", entry: selected })}>
            삭제
          </Button>
        </div>
      )}
      {message && <Toast>{message}</Toast>}
      {dialog?.type === "create" && (
        <Dialog open title="분류 추가" onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}>
            {dialog.kinds.length === 1 ? (
              <p>{kindLabel(dialog.kinds[0])}</p>
            ) : (
              <label>
                종류
                <select value={kind} onChange={(event) => setKind(event.target.value as ClassificationKind)}>
                  {dialog.kinds.map((option) => (
                    <option key={option} value={option}>
                      {kindLabel(option)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <TextField autoFocus label="이름" required value={name} onChange={(event) => setName(event.target.value)} />
            <DialogActions onClose={closeDialog} submitLabel="추가" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "rename" && (
        <Dialog open title="이름 변경" onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}>
            <TextField autoFocus label="이름" required value={name} onChange={(event) => setName(event.target.value)} />
            <DialogActions onClose={closeDialog} submitLabel="저장" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "move" && (
        <Dialog open title="분류 이동" onClose={closeDialog}>
          <form className="classification-sidebar__form" onSubmit={(event) => {
            event.preventDefault();
            void move();
          }}>
            <label>
              부모
              <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                {moveParents(dialog.entry, entries).map((parent) => (
                  <option key={parent?.id ?? "root"} value={parent?.id ?? ""}>
                    {parent?.name ?? "최상위"}
                  </option>
                ))}
              </select>
            </label>
            <DialogActions onClose={closeDialog} submitLabel="이동" />
          </form>
        </Dialog>
      )}
      {dialog?.type === "delete" && (
        <Dialog open title="분류 삭제" onClose={closeDialog}>
          <div className="classification-sidebar__form">
            <p>{dialog.entry.name} 항목을 삭제할까요?</p>
            <div className="ui-dialog__actions">
              <Button type="button" onClick={closeDialog}>
                취소
              </Button>
              <Button type="button" onClick={() => void remove()}>
                삭제 확인
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </aside>
  );
}

function TreeItem({
  node,
  onSelect,
  selectedId,
}: {
  node: ClassificationTreeNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <li role="treeitem" aria-selected={node.entry.id === selectedId}>
      <button type="button" onClick={() => onSelect(node.entry.id)}>
        {node.entry.name} 선택
      </button>
      {node.children.length > 0 && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeItem key={child.entry.id} node={child} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

function DialogActions({ onClose, submitLabel }: { onClose: () => void; submitLabel: string }) {
  return (
    <div className="ui-dialog__actions">
      <Button type="button" onClick={onClose}>
        취소
      </Button>
      <Button type="submit">{submitLabel}</Button>
    </div>
  );
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "분류를 변경하지 못했습니다.";
}
