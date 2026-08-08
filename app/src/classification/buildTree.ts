import type { ClassificationEntry } from "../library/types";

export type ClassificationTreeNode = {
  entry: ClassificationEntry;
  children: ClassificationTreeNode[];
};

export type ClassificationTree = ClassificationTreeNode[] & {
  orphans: ClassificationEntry[];
};

export function buildClassificationTree(
  entries: ClassificationEntry[],
): ClassificationTree {
  const nodes = new Map<string, ClassificationTreeNode>(
    entries.map((entry) => [entry.id, { entry, children: [] }]),
  );
  const roots: ClassificationTreeNode[] = [];

  for (const node of nodes.values()) {
    if (node.entry.parentId === null) {
      roots.push(node);
      continue;
    }
    nodes.get(node.entry.parentId)?.children.push(node);
  }

  const visible = new Set<string>();
  const sort = (items: ClassificationTreeNode[]) => {
    items.sort((left, right) =>
      left.entry.name.localeCompare(right.entry.name, "ko"),
    );
    for (const item of items) {
      visible.add(item.entry.id);
      sort(item.children);
    }
  };
  sort(roots);

  return Object.assign(roots, {
    orphans: [...nodes.values()]
      .filter((node) => !visible.has(node.entry.id))
      .map((node) => node.entry)
      .sort((left, right) => left.name.localeCompare(right.name, "ko")),
  });
}
