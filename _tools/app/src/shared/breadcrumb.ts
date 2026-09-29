export type BreadcrumbNode = { id: string; name: string; parentId: string | null };

/** Root-to-node labels for a parent-linked tree. Cycles stop at the first repeated node. */
export function breadcrumbPath(node: BreadcrumbNode, nodes: readonly BreadcrumbNode[]): string {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const names: string[] = [];
  const seen = new Set<string>();
  let current: BreadcrumbNode | undefined = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(" › ");
}
