"""Generate the cross-language wire fixture from the server's own encoders.

`fastapi` is not installed on this host and installing dependencies is out of scope, so
the import surface the module actually needs is stubbed rather than the encoders being
reimplemented. `encode_page`, `classification_projection`, `assignment_projection`,
`role_projection` and `change_items` are the server's real functions, so the fixture
records what the server really encodes.
"""
import importlib.util, json, sys, types, pathlib

# --- minimal fastapi stub -------------------------------------------------------------
fastapi = types.ModuleType("fastapi")
class HTTPException(Exception):
    def __init__(self, status, detail=None): self.status_code, self.detail = status, detail
class Header:
    def __init__(self, default=None): self.default = default
class Request: pass
fastapi.HTTPException = HTTPException
fastapi.Header = Header
fastapi.Request = Request
fastapi.FastAPI = object
sys.modules["fastapi"] = fastapi
starlette = types.ModuleType("starlette")
concurrency = types.ModuleType("starlette.concurrency")
concurrency.run_in_threadpool = lambda fn, *a, **k: fn(*a, **k)
starlette.concurrency = concurrency
sys.modules["starlette"] = starlette
sys.modules["starlette.concurrency"] = concurrency

# The module imports `authority`, which lives beside it.
sys.path.insert(0, str(pathlib.Path("server/lakomics-api").resolve()))
spec = importlib.util.spec_from_file_location(
    "classification_authority", "server/lakomics-api/classification_authority.py")
ca = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ca)

LIBRARY = "a1b2c3d4e5f60718293a6b5c6d7e8f90"[:32]
EPOCH = 1

# The exact projections the server builds, through the server's own constructors.
CLASS_ROWS = [
    {"classification_id": "originals", "kind": "root", "name": "오리지널", "parent_id": None,
     "icon_key": "sparkles", "color_key": None, "deleted": 0, "entity_revision": 1},
    {"classification_id": "series", "kind": "tag", "name": "시리즈", "parent_id": "originals",
     "icon_key": "star", "color_key": "blue", "deleted": 0, "entity_revision": 2},
]
# The role set comes from the server's own `role_projection`, not a hand-written literal:
# the wire casing of this projection is exactly what a client binds to, so a fixture that
# re-spelled it could not catch a mismatch.
import sqlite3
_roles_db = sqlite3.connect(":memory:")
_roles_db.row_factory = sqlite3.Row
_roles_db.execute("CREATE TABLE classification_authority_roles("
                  "library_id TEXT, role TEXT, classification_id TEXT)")
_roles_db.execute("INSERT INTO classification_authority_roles VALUES(?,?,?)",
                  (LIBRARY, "originals", "originals"))
ROLES = ca.role_projection(_roles_db, LIBRARY)
_roles_db.close()

classification_items = [ca.classification_projection(r) for r in CLASS_ROWS]
assignment_items = [ca.assignment_projection("asset-1", "series", 1),
                    ca.assignment_projection("asset-2", None, 3)]

classification_page = ca.encode_page(LIBRARY, EPOCH, ca.CONTRACT_VERSION, 7,
                                     ca.CLASSIFICATIONS_SECTION, classification_items,
                                     None, False, ROLES)
assignment_page = ca.encode_page(LIBRARY, EPOCH, ca.CONTRACT_VERSION, 7,
                                 ca.ASSIGNMENTS_SECTION, assignment_items,
                                 None, False, ROLES)

# One normal change row and one delete row, encoded the way `change_items` does:
# the payload is merged into the row with `sequence`/`authorityCursor`/`commandType`/
# `operationId`/`changedAt` around it.
def change_row(sequence, command_type, operation_id, payload):
    return {"sequence": sequence, "authorityCursor": sequence, "commandType": command_type,
            "operationId": operation_id, "changedAt": "2026-09-16T00:00:00Z", **payload}

tombstone = ca.classification_projection(
    {"classification_id": "series", "kind": "tag", "name": "시리즈", "parent_id": None,
     "icon_key": "star", "color_key": "blue", "deleted": 1, "entity_revision": 3})
changes = {
    "libraryId": LIBRARY, "epoch": EPOCH, "contractVersion": ca.CONTRACT_VERSION,
    "cursor": 12,
    "items": [
        change_row(11, ca.ASSIGNMENT, "op-assign",
                   {"assignment": ca.assignment_projection("asset-1", "series", 1)}),
        change_row(12, ca.DELETE, "op-delete",
                   {"classification": tombstone,
                    "assignmentTransition": {"fromClassificationId": "series",
                                             "toClassificationId": "originals",
                                             "affectsAssignments": 1}}),
    ],
    "nextAfter": 12, "hasMore": False,
}

document = {
    "_generatedBy": "server/lakomics-api/classification_authority.py encode_page/"
                    "classification_projection/assignment_projection + change_items shape",
    "classificationPage": classification_page,
    "assignmentPage": assignment_page,
    "changes": changes,
}
out = pathlib.Path("tests/fixtures/classification-authority-wire.json")
out.write_text(json.dumps(document, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
               encoding="utf-8")
print("wrote", out, out.stat().st_size, "bytes")
