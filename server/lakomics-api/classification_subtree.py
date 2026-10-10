"""Folder subtree helpers for the Asset listing and the folder cards.

A folder's *direct* count (``asset_count``) is how many Assets are filed under that node
alone. Its *subtree* count is how many distinct Assets are filed under the node or any
descendant. They are separate numbers: the direct count keeps its meaning for every shipped
reader, and the subtree count travels beside it as ``total_asset_count`` only when asked for.

Plain Python on purpose: the parent map comes from either the authority state or the legacy
published snapshot, and the callers own that read.
"""


def children_of(parents):
    """``{parent_id: [child_id, ...]}`` for a ``{id: parent_id | None}`` map."""
    children = {}
    for node, parent in parents.items():
        if parent is not None:
            children.setdefault(parent, []).append(node)
    return children


def subtree_ids(parents, root, children=None):
    """``root`` and every descendant, root first and breadth first.

    An id the map does not know is its own one-node subtree, so a request for an unknown
    folder lists nothing instead of failing. ``seen`` bounds a malformed parent cycle.
    """
    children = children if children is not None else children_of(parents)
    found, seen, level = [root], {root}, [root]
    while level:
        following = []
        for node in level:
            for child in sorted(children.get(node, ())):
                if child not in seen:
                    seen.add(child)
                    found.append(child)
                    following.append(child)
        level = following
    return found


def subtree_totals_single(parents, direct):
    """Subtree totals when every Asset is filed under at most one node (authority state).

    Counts add up without double counting because an Asset has a single assignment.
    """
    children = children_of(parents)
    totals = {}
    for node in parents:
        totals[node] = sum(direct.get(member, 0) for member in subtree_ids(parents, node, children))
    return totals


def subtree_totals_distinct(parents, pairs):
    """Subtree totals from ``(classification_id, asset_id)`` pairs (legacy multi-link rows).

    A legacy Asset can be linked to several nodes, so members are counted as a set: an Asset
    linked both to a folder and to its subfolder counts once toward the folder.
    """
    by_node = {}
    for node, asset in pairs:
        by_node.setdefault(node, set()).add(asset)
    children = children_of(parents)
    totals = {}
    for node in parents:
        members = set()
        for member in subtree_ids(parents, node, children):
            members |= by_node.get(member, set())
        totals[node] = len(members)
    return totals
