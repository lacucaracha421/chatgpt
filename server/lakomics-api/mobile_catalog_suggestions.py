"""Tag autocomplete for the mobile catalog, mirroring the PC suggestion list.

The PC counts every tag in the catalog, orders it by use, and matches a
case-insensitive substring of `namespace:value` or its Korean label. Mobile
returns at most 10 and also accepts a short namespace (`a:asa`). The same list is built here once per publication revision (a
visibility-only republication is a new revision, so the blocked flags follow
it) and filtered in memory for each keystroke.
"""
from __future__ import annotations

import threading

from mobile_catalog_query import expand_namespace

MAX_LIMIT = 10
MAX_TEXT_BYTES = 200

# One entry per (namespace, value): display text, lowered display, lowered label,
# label, use count and whether the publication's policy blocks this exact tag.
_INDEX_SQL = """SELECT t.Namespace,t.Value,COUNT(*) AS uses,
  (SELECT tr.label FROM catalog.Translations tr WHERE tr.namespace=t.Namespace AND tr.value=t.Value) AS label,
  EXISTS(SELECT 1 FROM online_catalog_blocked_tags b WHERE b.namespace=t.Namespace AND b.value=t.Value) AS blocked
FROM catalog.Tags t GROUP BY t.Namespace,t.Value"""


def build_index(db):
    """Every tag of the attached publication, ordered by use count then text."""
    entries = []
    for namespace, value, uses, label, blocked in db.execute(_INDEX_SQL):
        text = f"{namespace}:{value}"
        entries.append((text, text.lower(), label.lower() if label else "", label or None, int(uses), bool(blocked)))
    entries.sort(key=lambda entry: (-entry[4], entry[0]))
    return tuple(entries)


def match(index, text, limit, reveal_blocked=False):
    """Case-insensitive substring over `namespace:value` and the Korean label.

    A blocked tag is only suggested when the caller reveals blocked content,
    exactly as search only admits works carrying it under `revealBlocked`.
    """
    needle = text.strip().lower()
    namespace, separator, rest = needle.partition(":")
    if separator and namespace:
        # `a:asa` means `artist:asa`; a full or unknown namespace is unchanged.
        needle = expand_namespace(namespace) + ":" + rest
    result = []
    for display, lowered, label_lowered, label, uses, blocked in index:
        if blocked and not reveal_blocked:
            continue
        if needle in lowered or (label_lowered and needle in label_lowered):
            result.append({"value": display, "label": label, "count": uses})
            if len(result) >= limit:
                break
    return result


class SuggestionCache:
    """The index of one publication revision, rebuilt when the revision changes.

    Building is serialized so concurrent first requests share one build; a reader
    of the current revision never waits once it is built.
    """

    def __init__(self):
        self._lock = threading.Lock()
        # (revision, index) is replaced as one reference, so a lock-free reader can
        # never pair one revision with another revision's index.
        self._entry = (None, None)
        self.builds = 0

    def index(self, revision, db):
        cached_revision, cached = self._entry
        if cached_revision == revision and cached is not None:
            return cached
        with self._lock:
            cached_revision, cached = self._entry
            if cached_revision == revision and cached is not None:
                return cached
            index = build_index(db)
            self._entry = (revision, index)
            self.builds += 1
            return index
