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

/** The sidebar and plain-folder shelf share explicit ranks, then the Korean name fallback. */
export function sortFolders<T extends TreeEntry>(entries: readonly T[], orderedIds: readonly string[]): T[] {
  return [...entries].sort(folderComparator(orderedIds));
}

function folderComparator(orderedIds: readonly string[]) {
  const order = new Map(orderedIds.map((id, index) => [id, index]));
  return (left: TreeEntry, right: TreeEntry) =>
    (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    || left.name.localeCompare(right.name, "ko");
}

export function buildTree<T extends TreeEntry>(entries: T[], orderedIds: string[] = []): Tree<T> {
  const compare = folderComparator(orderedIds);
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
    items.sort((left, right) => compare(left.entry, right.entry));
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
