"""Offline staging diagnostics; no app startup, credentials, network or real DB.

Each row is parsed with the real parser, then all safely reachable relationship
checks run on valid rows. Malformed rows report their first parser failure; checks
depending on rejected rows may consequently report missing references. The final
verify report always uses the original document, never the filtered diagnostic one.
"""
import argparse
from collections import defaultdict
import copy
import datetime
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import authority
import collection_authority as ca
import collection_bindings
import collection_personal_edits
import collection_releases
import mobile_collections as mobile

SECTIONS = (*ca.SECTIONS, "people")


def empty_db():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(authority.AUTHORITY_DDL)
    ca.startup_db(db)
    collection_bindings.startup_db(db)
    collection_releases.startup_db(db)
    db.executescript(collection_personal_edits.DDL)
    # Empty legacy read-side tables only; never import app.py or its workers.
    db.executescript("""
        CREATE TABLE mobile_collection_replica(singleton INTEGER PRIMARY KEY, revision TEXT, published_at TEXT);
        CREATE TABLE mobile_collections(id TEXT PRIMARY KEY, type TEXT, name TEXT, showcase INTEGER, showcase_order INTEGER, payload TEXT);
        CREATE TABLE mobile_collection_artwork(sha256 TEXT PRIMARY KEY, size_bytes INTEGER, content_type TEXT);
        CREATE TABLE mobile_collection_people(id TEXT PRIMARY KEY, payload TEXT);
        CREATE TABLE assets(id TEXT PRIMARY KEY, kind TEXT, committed INTEGER);
    """)
    db.commit()
    return db


def collect_problems(db, body):
    problems = []
    if not isinstance(body, dict):
        return [{"kind": "staging", "code": "invalidCollectionBaseline", "message": "Expected an object"}]
    try:
        ca._exact(body, ca.STAGING_V2_KEYS, "staging")
    except ca.HTTPException as error:
        problems.append({"kind": "staging", **error.detail})
    skeleton = {**body, **{section: [] for section in SECTIONS}}
    try:
        ca.parse_staging(skeleton, verify=True)
    except ca.HTTPException as error:
        problems.append({"kind": "staging", **error.detail})
        return problems
    valid = copy.deepcopy(skeleton)
    for section in SECTIONS:
        rows = body.get(section)
        if not isinstance(rows, list):
            problems.append({"kind": section, "code": "invalidCollectionBaseline", "message": "Expected an array"})
            continue
        # Check collection limits as well as individual rows.
        try:
            ca._staged_list(body, section, ca.MAX_WORKS if section == "works" else
                            mobile.MAX_PEOPLE if section == "people" else ca.MAX_STAGED_ROWS)
        except ca.HTTPException as error:
            problems.append({"kind": section, **error.detail})
        for index, row in enumerate(rows):
            probe = {**skeleton, section: [row]}
            try:
                ca.parse_staging(probe, verify=True)
                valid[section].append(row)
            except ca.HTTPException as error:
                ids = {key: row[key] for key in ("workId", "artworkId", "volumeId", "personId", "assetId", "provider")
                       if isinstance(row, dict) and isinstance(row.get(key), str)}
                problems.append({"kind": section, "index": index, **error.detail, **ids})
    try:
        doc = ca.parse_staging(valid, verify=True)
    except ca.HTTPException as error:
        # Cross-row parser checks (e.g. multiple selected backs). Parse sections
        # independently to retain the remaining relationship diagnostics.
        problems.append({"kind": "crossRow", **error.detail})
        doc = ca.parse_staging(skeleton, verify=True)
        for section in SECTIONS:
            for row in valid[section]:
                doc[section].extend(ca.parse_staging({**skeleton, section: [row]}, verify=True)[section])
    relations = []
    ca.validate_staging(db, doc, verify=True, problems=relations)
    problems.extend({"kind": problem.get("reason", "relation"), **problem} for problem in relations)
    return problems


def simulate_publication(db, body, replica):
    """Synthetic local assumptions, explicitly not server receipt/drain evidence."""
    for value in replica["collections"]:
        item = mobile.stored(mobile.Collection.model_validate(value))
        db.execute("INSERT INTO mobile_collections VALUES(?,?,?,?,?,?)", [item["id"], item["type"], item["name"],
                   int(item["showcase"]), item.get("showcaseOrder"), ca.encode(item)])
    for person in replica.get("people") or []:
        value = mobile.Person.model_validate(person).model_dump()
        db.execute("INSERT INTO mobile_collection_people VALUES(?,?)", [value["id"], ca.encode(value)])
    db.execute("INSERT INTO mobile_collection_replica VALUES(1,?,?)", [body["legacyRevision"], "offline"])
    db.execute("INSERT INTO mobile_collection_edit_state VALUES(1,?,?,?,3)",
               [body["libraryId"], body["personalEditCursor"], body["personalEditCursor"]])
    db.execute("UPDATE collection_binding_state SET sequence=? WHERE singleton=1", [body["bindingRequestSequence"]])
    db.execute("UPDATE collection_release_state SET read_sequence=?,generation=? WHERE singleton=1",
               [body["releaseReadCursor"], body["releaseGeneration"]])
    blobs = [blob for art in body["artworks"] for blob in (art["original"], art["thumbnail"]) if blob]
    blobs.extend(p["portraitImage"] for p in body["people"] if p["portraitImage"])
    for blob in blobs:
        db.execute("INSERT OR REPLACE INTO mobile_collection_artwork VALUES(?,?,?)",
                   [blob["sha256"], blob["sizeBytes"], blob["contentType"]])
    assets = {m["assetId"] for m in body["memberships"]}
    assets.update(w["fields"]["coverAssetId"] for w in body["works"] if w["fields"]["coverAssetId"])
    db.executemany("INSERT INTO assets VALUES(?,'image',1)", [(asset,) for asset in assets])
    db.commit()


def run(body, replica=None):
    if not isinstance(body, dict):
        raise ValueError("Baseline must be a JSON object")
    db = empty_db()
    try:
        # Default diagnostics run against an entirely empty server.
        problems = collect_problems(db, body)
        simulation_failed = False
        if replica is not None:
            try:
                simulate_publication(db, body, replica)
            except (KeyError, TypeError, ValueError, sqlite3.Error):
                db.rollback()
                simulation_failed = True
                problems.append({"kind": "simulation", "code": "invalidSimulationInput",
                                 "message": "Could not seed the companion replica; comparison uses the empty server."})
            else:
                problems = collect_problems(db, body)
        db.execute("BEGIN")
        report = ca.verify_staging(db, body, datetime.datetime.now(datetime.timezone.utc).isoformat())
        groups = defaultdict(lambda: {"count": 0, "samples": []})
        for problem in problems:
            key = problem["kind"] + ":" + problem["code"] + ":" + problem["message"]
            group = groups[key]
            group["count"] += 1
            if len(group["samples"]) < 5:
                group["samples"].append({k: v for k, v in problem.items() if k not in ("kind", "code", "message")})
        return {"mode": "simulationFailed" if simulation_failed else
                        "simulatedPublication" if replica is not None else "emptyServer",
                "problemCount": len(problems), "problemsByKind": dict(groups), "verification": report,
                "limitations": ["No live server, library, uploads, pending requests or drain barriers are verified.",
                                "One parser failure per malformed row; relationship checks continue on valid rows.",
                                "Simulation assumes referenced Assets are visible and blobs/drain barriers are confirmed."]}
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("--simulate-publication", type=Path, metavar="LEGACY_JSON",
                        help="Seed a synthetic in-memory legacy publication and assumed receipts/barriers")
    args = parser.parse_args()
    body = json.loads(args.baseline.read_text(encoding="utf-8"))
    replica = json.loads(args.simulate_publication.read_text(encoding="utf-8")) if args.simulate_publication else None
    result = run(body, replica)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["problemCount"] or result["verification"]["verdict"] != "lossless" else 0


if __name__ == "__main__":
    raise SystemExit(main())
