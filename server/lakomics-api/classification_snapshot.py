"""Classification snapshot staging: version 1 (legacy) and version 2 (authority-ready).

This is the server-first half of the Classification rolling upgrade. The server begins
accepting an authority-ready snapshot **while still accepting the shipped publisher
unchanged**, so a new PC build can never publish a shape an older deployed server would
reject. The PC publisher is deliberately not changed by this batch.

# What staging is, and is not

Staging stores a **validated source**, not activated authority state. A version-2
publication is fully validated and stored deterministically so a later activation can
bind itself to the exact stored state; it does **not** create an ``authority_domains``
row, does not populate ``classification_authority_*`` canonical state, and does not
fence the legacy writer by itself. The 2A.2 activation route consumes this stored v2
source explicitly and atomically; the PC replica and Android slices remain later work.

The staging table is the shipped ``classification_snapshots`` singleton, so the legacy
readers (``GET /v1/classifications``, ``/meta``, the extension bootstrap and the mobile
Classification readers) keep working against the same row without being taught anything
new.

# Versions differ in how strictly they are validated

* **Version 1** is the shape the shipped PC publisher sends: ``entries`` +
  ``published_at``. An absent ``snapshotVersion`` means 1, so old publishers keep working
  with no field added. Version-1 entries are stored **verbatim and opaque**, exactly as
  they are today: the deployed publisher is the source of truth for its own version, and
  the legacy store has never validated them. Validating them now would be a behavior
  change to a shipped client — the PC legitimately publishes values this server's
  canonical contract does not accept, such as the display-only ``assetCount`` field that
  ``ClassificationEntry`` always serializes, or an appearance key predating the current
  UI. Those bytes are a display/publication representation, not canonical staging input.
* **Version 2** is the authority-ready shape and is **fully validated**: it is the input a
  future activation derives canonical state from, so being strict here is what keeps
  activation from having to re-litigate the hierarchy.

# Canonical staging rules (version 2)

Entry ``kind`` is taken from the publisher and validated, never derived from the parent
structure: ``work`` is a legal schema kind that cannot be reconstructed uniquely from the
parent alone. Everything else the PC database could hold is enforced too — id
validity/uniqueness, trimmed non-empty bounded names, kind/parent compatibility, parent
existence, no self-parent or cycle, case-insensitive sibling-name uniqueness, and
appearance keys the UI can actually render — so a structurally invalid snapshot is
rejected rather than silently normalized into a different hierarchy.

``assignments`` and ``roles`` must each be stated explicitly in version 2. An absent
collection is **not** an empty one: defaulting it would let a publisher silently stage
"no assignment" or "no protected role", which activation would then treat as real user
state.

Assignment is single-valued per Asset (``assetId -> classificationId``), matching the
authority model rather than Album's independent relation, so each Asset may appear at
most once and every referenced Classification must exist in the staged set. Duplicates
are a coded staging error; picking one silently would discard a real disagreement.

A staged assignment deliberately does **not** require the Asset to exist or be committed
on the server. The PC snapshot is trusted, and Classification assignment must survive for
Assets that are locally trashed or otherwise outside the server Asset projection — the
same reasoning Album activation uses. The ordinary post-activation
``setAssetClassification`` command keeps its committed-Asset requirement; this module
does not weaken that.

``roles`` must carry exactly one supported ``originals`` role naming a staged
Classification. The role is immutable authority state with no mutation API.

# Digest

The stored payload is re-serialized deterministically. Version 2 keeps a
``legacyEntries`` display sidecar so old readers/revision semantics retain fields such as
``assetCount`` and publisher order, while activation uses the normalized canonical
``entries``/``assignments``/``roles``. The digest is recomputed from those canonical
collections only; it excludes both ``published_at`` and ``legacyEntries`` so publication
bookkeeping or display-only count changes cannot alter authority identity.
"""
import datetime
import hashlib
import json

from fastapi import HTTPException

# Reusing the authority module's validators is deliberate: staging must accept exactly
# what the authority contract can later hold, and a second definition of "valid name" or
# "renderable appearance" would be free to drift from it.
from classification_authority import (
    KINDS, normalize_name, valid_appearance, valid_asset_id, valid_classification_id,
)

#: Version of the unversioned legacy publisher. An absent field means this.
SNAPSHOT_VERSION = 1

#: The first authority-ready shape: it carries canonical assignments and roles.
AUTHORITY_READY_VERSION = 2

SUPPORTED_VERSIONS = (SNAPSHOT_VERSION, AUTHORITY_READY_VERSION)

#: The only role the product has. Declared as the accepted set so an unknown role is a
#: coded rejection rather than an ignored extra.
SUPPORTED_ROLES = ("originals",)

#: Staging bound, matching Album's shared publisher-only bound. This route carries a
#: complete library structure plus every canonical assignment, and the shipped 512 KiB
#: could not hold the measured 8,907 assignments.
#:
#: The figures below are measured by ``test_classification_snapshot_staging`` from the
#: real encoded shape at maximum row width (128-char ids, 200-char names), not estimated:
#: the measured active library encodes to ~2.57 MiB, and 20,000 classifications plus
#: 100,000 assignments encode to ~57.5 MiB. 96 MiB therefore admits that shape with room
#: to spare while staying a bound; a larger library is rejected with a coded 413 rather
#: than truncated, and would need an explicit bound decision.
MAX_STAGING_BYTES = 96 * 1024 * 1024


def fail(status=422, code="invalidClassificationSnapshot",
         message="분류 스냅샷이 올바르지 않습니다.", **extra):
    raise HTTPException(status, detail={"code": code, "message": message, **extra})


def canonical_text(value):
    """The exact bytes a digest and the stored payload are computed over."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _digest(value):
    return hashlib.sha256(canonical_text(value).encode("utf-8")).hexdigest()


def _parse_published_at(value):
    """An aware UTC datetime, or a coded rejection.

    Normalizing to UTC is what makes comparison order correct rather than
    string-lexicographic: ``2026-08-31T00:00:00+00:00`` and ``2026-08-30T17:00:00-07:00``
    are the same instant but sort differently as text.
    """
    if not isinstance(value, str) or not value.strip():
        fail(422, "invalidClassificationSnapshot", "게시 시각이 올바르지 않습니다.")
    try:
        moment = datetime.datetime.fromisoformat(value)
    except ValueError:
        fail(422, "invalidClassificationSnapshot", "게시 시각을 해석할 수 없습니다.")
    if moment.tzinfo is None:
        fail(422, "invalidClassificationSnapshot", "게시 시각에 시간대가 필요합니다.")
    return moment.astimezone(datetime.timezone.utc)


def _stored_published_at(value):
    """The stored publication instant, or ``None`` when it cannot be interpreted.

    An unparseable legacy value yields ``None``, which the caller treats as "no ordering
    information" rather than as staleness. Refusing a real publication because an old row
    predates the timestamp contract would block the publisher for a server-side data
    problem it cannot fix.
    """
    try:
        moment = datetime.datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return moment.astimezone(datetime.timezone.utc)


def entry_canonical(raw):
    """Read one wire entry's canonical fields.

    Keys are read by their wire names (camelCase, matching ``ClassificationEntry``'s
    serialization) and unknown keys are ignored rather than rejected: the shipped
    publisher always sends display-only fields such as ``assetCount``, which is derived
    state the server already ignores and must not treat as a contract violation.
    """
    if not isinstance(raw, dict):
        fail(422, "invalidClassificationEntry", "분류 항목의 형식이 올바르지 않습니다.")
    missing = [key for key in ("id", "kind", "name") if key not in raw]
    if missing:
        fail(422, "invalidClassificationEntry", "분류 항목에 필수 필드가 없습니다.",
             missing=missing)
    classification_id = raw["id"]
    if not valid_classification_id(classification_id):
        fail(422, "invalidClassificationEntry", "분류 ID가 올바르지 않습니다.",
             classificationId=classification_id if isinstance(classification_id, str)
             else None)
    kind = raw["kind"]
    if kind not in KINDS:
        fail(422, "invalidClassificationKind", "지원하지 않는 분류 종류입니다.",
             classificationId=classification_id,
             kind=kind if isinstance(kind, str) else None)
    parent_id = raw.get("parentId")
    if parent_id is not None and not valid_classification_id(parent_id):
        fail(422, "invalidClassificationEntry", "상위 분류 ID가 올바르지 않습니다.",
             classificationId=classification_id)
    icon_key, color_key = raw.get("iconKey"), raw.get("colorKey")
    if not valid_appearance(icon_key, color_key):
        fail(422, "invalidClassificationAppearance",
             "분류 아이콘 또는 색상을 사용할 수 없습니다.",
             classificationId=classification_id)
    return {"id": classification_id, "kind": kind, "name": normalize_name(raw["name"]),
            "parentId": parent_id, "iconKey": icon_key, "colorKey": color_key}


def validate_entries(entries):
    """Validate and normalize the Classification set, preserving publisher `kind`s."""
    rows = []
    seen = set()
    for raw in entries:
        row = entry_canonical(raw)
        if row["id"] in seen:
            fail(422, "duplicateClassificationId", "분류 ID가 중복되었습니다.",
                 classificationId=row["id"])
        seen.add(row["id"])
        rows.append(row)
    validate_hierarchy(rows)
    return sorted(rows, key=lambda row: row["id"])


def validate_hierarchy(rows):
    """Reject a hierarchy the PC database could not hold.

    Every rule the PC schema and ``library/classification.rs`` enforce is checked here,
    so a structurally invalid snapshot is refused instead of being normalized into a
    different tree: the server never invents a hierarchy the user did not publish.
    """
    by_id = {row["id"]: row for row in rows}
    for row in rows:
        parent_id = row["parentId"]
        # Kind/parent compatibility for *every* entry, including a parentless one: a
        # `root` must have no parent, a `work` must hang directly under a root, and a
        # `tag` must have some parent. Checking this only for entries that have a parent
        # would accept a top-level `tag` or `work`, which the PC schema cannot hold.
        if parent_id is None:
            if row["kind"] != "root":
                fail(422, "invalidClassificationParent",
                     "루트가 아닌 분류에는 상위 분류가 필요합니다.",
                     classificationId=row["id"], kind=row["kind"])
            continue
        if parent_id == row["id"]:
            fail(422, "invalidClassificationParent",
                 "분류가 자기 자신을 상위로 가질 수 없습니다.", classificationId=row["id"])
        parent = by_id.get(parent_id)
        if parent is None:
            fail(422, "invalidClassificationParent", "상위 분류를 찾을 수 없습니다.",
                 classificationId=row["id"], parentId=parent_id)
        if row["kind"] == "work" and parent["kind"] != "root":
            fail(422, "invalidClassificationParent",
                 "작품 분류의 상위는 루트여야 합니다.",
                 classificationId=row["id"], parentId=parent_id, kind=row["kind"])
    # Cycle detection over the whole set, so a cycle closed by any member is caught even
    # when the entry that completes it appears first.
    for row in rows:
        seen = {row["id"]}
        current = row["parentId"]
        while current is not None:
            if current in seen:
                fail(422, "classificationCycle", "분류 계층에 순환이 있습니다.",
                     classificationId=row["id"])
            seen.add(current)
            ancestor = by_id.get(current)
            if ancestor is None:
                break
            current = ancestor["parentId"]
    siblings = {}
    for row in rows:
        key = (row["parentId"] or "", row["name"].casefold())
        if key in siblings:
            fail(422, "duplicateClassificationName",
                 "같은 위치에 같은 이름의 분류가 있습니다.", name=row["name"])
        siblings[key] = row["id"]


def validate_assignments(assignments, entries):
    """Validate the single-valued Asset -> Classification assignment set."""
    known = {row["id"] for row in entries}
    rows = []
    seen = set()
    for raw in assignments:
        if not isinstance(raw, dict) or set(raw) != {"assetId", "classificationId"}:
            fail(422, "invalidClassificationAssignment",
                 "배정 항목의 형식이 올바르지 않습니다.")
        asset_id = raw["assetId"]
        if not valid_asset_id(asset_id):
            fail(422, "invalidClassificationAssignment", "자산 ID가 올바르지 않습니다.",
                 assetId=asset_id if isinstance(asset_id, str) else None)
        # Single-valued: a second row for the same Asset is a real disagreement about
        # which Classification it belongs to, so it is refused rather than collapsed.
        if asset_id in seen:
            fail(422, "duplicateClassificationAssignment",
                 "같은 자산이 두 번 배정되었습니다.", assetId=asset_id)
        seen.add(asset_id)
        classification_id = raw["classificationId"]
        if not valid_classification_id(classification_id):
            fail(422, "invalidClassificationAssignment", "분류 ID가 올바르지 않습니다.",
                 assetId=asset_id)
        if classification_id not in known:
            fail(422, "invalidClassificationAssignment",
                 "스냅샷에 없는 분류로 자산이 배정되었습니다.",
                 assetId=asset_id, classificationId=classification_id)
        # The Asset itself is deliberately *not* checked against the server `assets`
        # table: the PC snapshot is trusted, and an assignment must survive for a locally
        # trashed or otherwise unmaterialized Asset.
        rows.append({"assetId": asset_id, "classificationId": classification_id})
    return sorted(rows, key=lambda row: row["assetId"])


def validate_roles(roles, entries):
    """Validate the immutable role set: supported, unique, and naming a staged node."""
    known = {row["id"] for row in entries}
    rows = []
    seen = set()
    for raw in roles:
        if not isinstance(raw, dict) or set(raw) != {"role", "classificationId"}:
            fail(422, "invalidClassificationRole", "역할 항목의 형식이 올바르지 않습니다.")
        name = raw["role"]
        if name not in SUPPORTED_ROLES:
            fail(422, "unsupportedClassificationRole", "지원하지 않는 역할입니다.",
                 role=name if isinstance(name, str) else None)
        if name in seen:
            fail(422, "duplicateClassificationRole", "역할이 중복되었습니다.", role=name)
        seen.add(name)
        classification_id = raw["classificationId"]
        if not valid_classification_id(classification_id):
            fail(422, "invalidClassificationRole", "역할 대상 ID가 올바르지 않습니다.",
                 role=name)
        if classification_id not in known:
            fail(422, "invalidClassificationRole", "스냅샷에 없는 분류가 역할 대상입니다.",
                 role=name, classificationId=classification_id)
        target = next(row for row in entries if row["id"] == classification_id)
        if name == "originals" and (target["kind"] != "root" or target["parentId"] is not None):
            fail(422, "invalidClassificationRole",
                 "보호 역할(originals)은 최상위 루트 분류여야 합니다.",
                 role=name, classificationId=classification_id)
        rows.append({"role": name, "classificationId": classification_id})
    # An authority-ready snapshot must state the protected role, because a fresh replica
    # has no other source for it and the authority enforces it by id.
    if "originals" not in seen:
        fail(422, "missingClassificationOriginalsRole",
             "보호 역할(originals)이 스냅샷에 필요합니다.")
    return sorted(rows, key=lambda row: row["role"])


def resolve_version(body):
    """The snapshot version a publication body declares, or a coded rejection."""
    if not isinstance(body, dict):
        fail(422, "invalidClassificationSnapshot", "분류 스냅샷을 읽을 수 없습니다.")
    version = body.get("snapshotVersion", SNAPSHOT_VERSION)
    # JSON booleans and floats compare equal to ints in Python; reject them explicitly
    # so the wire contract remains the integer versions 1 and 2 only.
    if type(version) is not int or version not in SUPPORTED_VERSIONS:
        fail(422, "unsupportedClassificationSnapshotVersion",
             "지원하지 않는 분류 스냅샷 버전입니다.", supported=list(SUPPORTED_VERSIONS))
    return version


def validate_body(body):
    """Validate the publication envelope, shared by both versions."""
    if not isinstance(body, dict):
        fail(422, "invalidClassificationSnapshot", "분류 스냅샷을 읽을 수 없습니다.")
    version = resolve_version(body)
    published_at = _parse_published_at(body.get("published_at"))
    entries = body.get("entries")
    if not isinstance(entries, list):
        fail(422, "invalidClassificationSnapshot", "분류 목록이 필요합니다.")
    if version >= AUTHORITY_READY_VERSION:
        if "assignments" not in body:
            fail(422, "missingClassificationAssignments",
                 "분류 스냅샷에 canonical 배정 목록이 필요합니다.", snapshotVersion=version)
        if "roles" not in body:
            fail(422, "missingClassificationRoles",
                 "분류 스냅샷에 보호 역할 목록이 필요합니다.", snapshotVersion=version)
        if not isinstance(body["assignments"], list) or not isinstance(body["roles"], list):
            fail(422, "invalidClassificationSnapshot",
                 "배정·역할 목록의 형식이 올바르지 않습니다.", snapshotVersion=version)
    else:
        # Version 1 predates both collections, so a version-1 body carrying them is
        # stating something its contract does not define; it is rejected rather than
        # half-honoured, which would store canonical state the version cannot express.
        if body.get("assignments") is not None or body.get("roles") is not None:
            fail(422, "invalidClassificationSnapshot",
                 "1버전 스냅샷에는 배정·역할 목록을 포함할 수 없습니다.",
                 snapshotVersion=version)
    return version, published_at, entries


def stage(body):
    """Validate one publication and derive its canonical staging form.

    Returns ``(version, payload_text, digest)``. Version-1 entries are stored verbatim;
    version-2 entries are normalized into canonical staging input. Every rejection here
    is coded, because the publisher has to be able to tell a contract error from a
    transport failure.
    """
    version, published_at, entries = validate_body(body)
    stored = {"snapshotVersion": version, "published_at": body["published_at"]}
    if version >= AUTHORITY_READY_VERSION:
        canonical_entries = validate_entries(entries)
        stored["entries"] = canonical_entries
        # Authority staging intentionally strips display-only fields such as assetCount,
        # but the legacy snapshot route/revision still owns that exact display projection.
        # Keep it as a sidecar excluded from the authority digest so the server-first
        # upgrade does not silently change the old reader contract.
        stored["legacyEntries"] = entries
        stored["assignments"] = validate_assignments(body["assignments"], canonical_entries)
        stored["roles"] = validate_roles(body["roles"], canonical_entries)
    else:
        # Opaque and verbatim: the legacy store has never interpreted these entries, and
        # the deployed publisher is authoritative for the shape of its own version.
        stored["entries"] = entries
    # `published_at` is publication bookkeeping, not staging state, so it is excluded from
    # the digest: a retry that only restamps the instant describes the same state.
    digest_source = {key: value for key, value in stored.items()
                     if key not in ("published_at", "legacyEntries")}
    return version, canonical_text(stored), _digest(digest_source)



def authority_ready_state(payload_text):
    """Revalidate and return the canonical collections a cutover may activate.

    Publication already validates version 2, but activation re-runs the contract from
    the bytes actually stored in SQLite. This keeps a manually corrupted/stale staging
    row from becoming authority merely because a caller can name its digest.
    """
    try:
        payload = json.loads(payload_text)
    except (TypeError, ValueError, json.JSONDecodeError):
        fail(422, "invalidClassificationSnapshot", "저장된 분류 스냅샷을 읽을 수 없습니다.")
    version = payload.get("snapshotVersion", SNAPSHOT_VERSION) if isinstance(payload, dict) else None
    if version != AUTHORITY_READY_VERSION:
        fail(409, "classificationSnapshotNotAuthorityReady",
             "분류 스냅샷이 서버 권위 활성화에 필요한 버전이 아닙니다.",
             snapshotVersion=version, requiredVersion=AUTHORITY_READY_VERSION)
    entries_raw = payload.get("entries")
    assignments_raw = payload.get("assignments")
    roles_raw = payload.get("roles")
    if not isinstance(entries_raw, list) or not isinstance(assignments_raw, list) or not isinstance(roles_raw, list):
        fail(422, "invalidClassificationSnapshot", "저장된 분류 canonical 상태가 올바르지 않습니다.")
    entries = validate_entries(entries_raw)
    assignments = validate_assignments(assignments_raw, entries)
    roles = validate_roles(roles_raw, entries)
    return entries, assignments, roles, version

def stored_digest(payload_text):
    """The digest of a stored staging payload.

    Recomputed from the stored bytes rather than returned from a value passed in, so the
    digest a publisher receives provably identifies what the server holds. Version-1
    payloads are digested over their opaque entries, since they carry no canonical
    collections to bind to.
    """
    payload = json.loads(payload_text)
    version = payload.get("snapshotVersion", SNAPSHOT_VERSION)
    source = {"snapshotVersion": version, "entries": payload.get("entries", [])}
    if version >= AUTHORITY_READY_VERSION:
        source["assignments"] = payload.get("assignments", [])
        source["roles"] = payload.get("roles", [])
    return _digest(source)


def legacy_entries(payload_text):
    """The Classification entries a legacy reader understands, from any stored version.

    Version-2 storage keeps its canonical collections inside the same payload, so a
    legacy reader must never be handed `assignments`/`roles` and must never be required to
    understand `snapshotVersion`. Returning only `entries` is what keeps
    ``GET /v1/classifications``, the extension bootstrap and the mobile readers working
    unchanged while the domain is inactive.
    """
    payload = json.loads(payload_text)
    if payload.get("snapshotVersion", SNAPSHOT_VERSION) >= AUTHORITY_READY_VERSION:
        return payload.get("legacyEntries", payload.get("entries", []))
    return payload.get("entries", [])


def display_order(entries):
    """Display position per Classification id, extracted from one legacy display list.

    This is the **only** thing the frozen snapshot still contributes to an
    authority-backed tree. Only ordering metadata is read — never the entry itself — so
    no field of the frozen projection (name, parent, kind, appearance, `assetCount`,
    existence) can reach a reader once the domain is active and override canonical
    authority state.

    Each value is ``(position, parentId)``: the index in the display list, and the parent
    that position was observed under. The parent rides along because a flat index is only
    meaningful inside the sibling set it described; a node that has since moved is an
    arrival in its new set, not an existing member of it.

    ``entries`` is therefore the list each consumer historically shipped before cutover —
    the mobile tree route iterated the stored ``entries``, the extension bootstrap iterated
    ``legacy_entries`` — so each reader keeps the order it already had.

    An id absent from the list — one created after activation — gets no position, and the
    projection orders it after every ranked node.
    """
    positions = {}
    for index, entry in enumerate(entries if isinstance(entries, list) else []):
        if isinstance(entry, dict) and isinstance(entry.get("id"), str) and entry["id"]:
            # `or None` matches what every consumer already does with the field: a legacy
            # entry may carry a missing, empty or non-string parent, and all of those mean
            # "root" to the readers that re-parent this list. Normalizing here keeps the
            # rank comparable with the authority's own NULL parent instead of silently
            # demoting such a node to an arrival.
            parent = entry.get("parentId")
            positions.setdefault(entry["id"],
                                 (index, parent if isinstance(parent, str) and parent else None))
    return positions


def stale_check(stored_published_at, stored_payload_text, incoming_published_at,
                incoming_digest):
    """Whether an incoming publication may replace the stored one.

    Returns ``"accept"``, ``"identical"`` (an idempotent retry of the same state) or
    raises the coded stale error. Rules:

    * a strictly newer instant always wins;
    * an equal instant is accepted only when the canonical staging state is identical,
      which is the safe reading of "retry" — the publisher restamps on every real
      publication, so an equal instant carrying different content is a replay or a bug
      and must not overwrite newer accepted state;
    * an uninterpretable stored instant imposes no ordering, so a publisher is never
      blocked by a legacy row it cannot fix.
    """
    stored = _stored_published_at(stored_published_at)
    if stored is None:
        return "accept"
    if incoming_published_at > stored:
        return "accept"
    if incoming_published_at == stored and stored_digest(stored_payload_text) == incoming_digest:
        return "identical"
    fail(409, "staleClassificationSnapshot",
         "더 최신 분류 스냅샷이 이미 게시되어 있습니다.",
         publishedAt=stored_published_at)


def entries_changed(stored_payload_text, entries):
    """Whether the display entries differ, preserving the legacy revision semantics.

    The legacy `revision` counts *display* changes, so it is deliberately compared on the
    raw entries rather than on the canonical digest: canonical assignment or role state
    changing without the tree changing must not bump the revision existing readers use.
    """
    try:
        previous = legacy_entries(stored_payload_text)
    except (TypeError, ValueError, AttributeError):
        return True
    return previous != entries


__all__ = [
    "AUTHORITY_READY_VERSION", "MAX_STAGING_BYTES", "SNAPSHOT_VERSION", "SUPPORTED_ROLES",
    "SUPPORTED_VERSIONS", "authority_ready_state", "display_order", "entries_changed", "fail",
    "legacy_entries", "stage",
    "stale_check", "stored_digest", "validate_assignments", "validate_body",
    "validate_entries", "validate_hierarchy", "validate_roles",
]
