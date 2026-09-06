import type { ClassificationEntry } from "../library/types";

export type TreeEntry = {
  id: string;
  name: string;
  parentId: string | null;
};

export type TreeNode<T extends TreeEntry> = {
  entry: T;
  children: TreeNode<T>[];
};

export type Tree<T extends TreeEntry> = TreeNode<T>[] & {
  hasOrphans: boolean;
};

export type ClassificationTreeNode = {
  entry: ClassificationEntry;
  children: ClassificationTreeNode[];
};

export type ClassificationTree = ClassificationTreeNode[] & {
  hasOrphans: boolean;
};

export function buildTree<T extends TreeEntry>(entries: T[], orderedIds: string[] = []): Tree<T> {
  const order = new Map(orderedIds.map((id, index) => [id, index]));
  const nodes = new Map<string, TreeNode<T>>(
    entries.map((entry) => [entry.id, { entry, children: [] }]),
  );
  const roots: TreeNode<T>[] = [];

  for (const node of nodes.values()) {
    if (node.entry.parentId === null) {
      roots.push(node);
      continue;
    }
    nodes.get(node.entry.parentId)?.children.push(node);
  }

  const visible = new Set<string>();
  const sort = (items: TreeNode<T>[]) => {
    items.sort((left, right) =>
      (order.get(left.entry.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.entry.id) ?? Number.MAX_SAFE_INTEGER)
      || left.entry.name.localeCompare(right.entry.name, "ko"),
    );
    for (const item of items) {
      visible.add(item.entry.id);
      sort(item.children);
    }
  };
  sort(roots);

  return Object.assign(roots, {
    hasOrphans: visible.size !== entries.length,
  });
}

export function buildClassificationTree(entries: ClassificationEntry[]): ClassificationTree {
  return buildTree(entries);
}
