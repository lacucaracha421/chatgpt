"""Dormant, serial Kakao bind executor. Importing this module needs only stdlib.

OFF is a hard stop: pinned requests remain pending for restart with ON. Schema
additions run only with ON; legacy rows default to PC and are never reassigned.
"""
import json
import logging
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone

ENV = "LAKOMICS_KAKAO_BINDS"
FEATURE = "serverKakaoBinds"
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://lakomics.invalid/serverKakaoBind")
_current = None


def enabled():
    return os.environ.get(ENV, "").strip().lower() in ("1", "true", "yes", "on")


def has_metadata(db):
    return any(row[1] == "executor" for row in db.execute("PRAGMA table_info(collection_binding_requests)"))


def startup_db(db):
    if not enabled():
        return
    columns = {row[1] for row in db.execute("PRAGMA table_info(collection_binding_requests)")}
    additions = {"executor": "TEXT NOT NULL DEFAULT 'pc'", "library_id": "TEXT", "authority_epoch": "INTEGER",
                 "binding_precondition": "TEXT", "retry_count": "INTEGER NOT NULL DEFAULT 0",
                 "next_attempt_at": "TEXT"}
    for name, declaration in additions.items():
        if name not in columns:
            db.execute(f"ALTER TABLE collection_binding_requests ADD COLUMN {name} {declaration}")


def pc_clause(db):
    # Retain the delivery fence even after an ON -> OFF rollback.
    return " AND executor='pc'" if has_metadata(db) else ""


def features(db=None):
    worker = _current
    if not enabled() or worker is None or not worker.alive():
        return []
    if db is not None:
        return [FEATURE] if worker.ready(db) else []
    with worker.get_db() as connection:
        return [FEATURE] if worker.ready(connection) else []


def wake():
    if _current is not None and enabled():
        _current.wake_event.set()


def supersede(db, work_id, now):
    if has_metadata(db):
        db.execute("UPDATE collection_binding_requests SET state='superseded',updated_at=?,resolved_at=?"
                   " WHERE collection_id=? AND provider='kakao' AND executor='server' AND state='pending'",
                   (now, now, work_id))


def observation(binding, cursor):
    return {"bound": bool(binding and binding["bound"]),
            "revision": binding["entity_revision"] if binding is not None else 0,
            "externalId": binding["external_id"] if binding is not None else None,
            "config": json.loads(binding["config"]) if binding is not None and binding["config"] else None,
            "digest": binding["snapshot_digest"] if binding is not None else None, "cursor": cursor}


def capture(db, work_id, expected):
    """Enqueue-time fence, in the request transaction; replay runs before this."""
    worker = _current
    if worker is None or not worker.alive() or not worker.ready(db):
        raise Refused("kakaoApplyUnavailable", "서버 연결을 준비 중입니다. 잠시 후 다시 시도해 주세요.")
    domain = worker.domain(db)
    binding = worker.ca.binding_row(db, domain["libraryId"], work_id, "kakao")
    pre = observation(binding, domain["cursor"])
    if expected is not None and expected["externalId"] != (pre["externalId"] if pre["bound"] else None):
        worker.ca.fail(409, "bindingChanged", "연결 정보가 변경되었습니다. 다시 선택해 주세요.")
    return domain["libraryId"], domain["epoch"], json.dumps(pre, sort_keys=True)


class Refused(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


class Worker:
    def __init__(self, get_db, *, bindings=None, planner=None, ca=None,
                 now=lambda: datetime.now(timezone.utc)):
        # Injection lets the core run in standard-library-only fixtures.
        if bindings is None:
            import collection_bindings as bindings
        if planner is None:
            import collection_release_checks as planner
        if ca is None:
            import collection_authority as ca
        self.get_db, self.bindings, self.planner, self.ca, self.now = get_db, bindings, planner, ca, now
        self.stop_event, self.wake_event = threading.Event(), threading.Event()
        self.lane = threading.Lock()
        self.thread = None

    def ready(self, db):
        return self.domain(db) is not None and self.bindings.kakao_key() is not None

    def domain(self, db):
        return self.ca.authority.active_domain(db, self.ca.DOMAIN)

    def alive(self):
        return self.thread is not None and self.thread.is_alive() and not self.stop_event.is_set()

    def start(self):
        if not enabled() or self.alive():
            return
        with self.get_db() as db:
            startup_db(db)
            db.commit()
        self.stop_event.clear()
        self.thread = threading.Thread(target=self.run, name="kakao-binds", daemon=True)
        self.thread.start()

    def drain(self):
        self.stop_event.set()
        self.wake_event.set()

    def stop(self):
        self.drain()
        if self.thread is not None:
            from app_lifecycle import join_worker
            join_worker(self.thread, 6, lambda: setattr(self, "thread", None))

    def run(self):
        while not self.stop_event.is_set():
            self.wake_event.clear()
            wait = 30
            try:
                wait = self.run_once()
            except Exception:
                # Do not log provider bodies, URLs, queries or exception strings.
                logging.getLogger(__name__).warning("Kakao bind cycle deferred")
            self.wake_event.wait(wait)

    def run_once(self):
        if not enabled() or self.stop_event.is_set() or not self.lane.acquire(blocking=False):
            return 30
        try:
            with self.get_db() as db:
                rows = db.execute("SELECT sequence,next_attempt_at FROM collection_binding_requests"
                                  " WHERE executor='server' AND provider='kakao' AND state='pending'"
                                  " ORDER BY sequence").fetchall()
            for row in rows:
                retry = self.planner.parse_time(row["next_attempt_at"])
                if retry is None or retry <= self.now():
                    self.execute(row["sequence"])
                    return 1
            waits = [(self.planner.parse_time(row["next_attempt_at"]) - self.now()).total_seconds() for row in rows]
            return max(1, min([30, *waits]))
        finally:
            self.lane.release()

    def preflight(self, db, sequence):
        row = db.execute("SELECT * FROM collection_binding_requests WHERE sequence=?", (sequence,)).fetchone()
        if row is None or row["state"] != "pending" or row["executor"] != "server":
            return None
        domain = self.domain(db)
        if domain is None or (domain["libraryId"], domain["epoch"]) != (row["library_id"], row["authority_epoch"]):
            raise Refused("bindingChanged", "라이브러리 연결 정보가 변경되었습니다. 다시 선택해 주세요.")
        work_id = row["collection_id"]
        work = self.ca.work_row(db, domain["libraryId"], work_id)
        if work is None or work["lifecycle"] != "live" or work["type"] != "manga":
            raise Refused("collectionUnavailable", "연결할 만화 작품을 찾을 수 없습니다.")
        latest = db.execute("SELECT MAX(sequence) FROM collection_binding_requests WHERE collection_id=?"
                            " AND provider='kakao'", (work_id,)).fetchone()[0]
        if latest != sequence:
            raise Refused("bindingChanged", "더 새로운 연결 요청이 있습니다. 다시 확인해 주세요.")
        binding = self.ca.binding_row(db, domain["libraryId"], work_id, "kakao")
        stored = json.loads(row["binding_precondition"])
        current = observation(binding, domain["cursor"])
        if {k: v for k, v in stored.items() if k != "cursor"} != {k: v for k, v in current.items() if k != "cursor"}:
            # Only proven, contiguous review-only revisions can be merged. This
            # refuses snapshot races conservatively and never waives an ABA cycle.
            revisions = []
            for change in db.execute("SELECT command_type,payload FROM collection_authority_changes"
                                     " WHERE library_id=? AND epoch=? AND sequence>? ORDER BY sequence",
                                     (domain["libraryId"], domain["epoch"], stored["cursor"])):
                for value in json.loads(change["payload"]).get("entities", {}).get("bindings", []):
                    if value["workId"] == work_id and value["provider"] == "kakao":
                        if change["command_type"] != "setKakaoPartialDismissed":
                            raise Refused("bindingChanged", "연결 정보가 변경되었습니다. 다시 선택해 주세요.")
                        revisions.append(value["entityRevision"])
            clean = lambda config: {k: v for k, v in (config or {}).items() if k != "reviewDismissedVolumes"}
            if (not revisions or revisions != list(range(stored["revision"] + 1, current["revision"] + 1))
                    or stored["bound"] != current["bound"] or stored["externalId"] != current["externalId"]
                    or stored["digest"] != current["digest"] or clean(stored["config"]) != clean(current["config"])):
                raise Refused("bindingChanged", "연결 정보가 변경되었습니다. 다시 선택해 주세요.")
        batch = str(uuid.uuid5(NAMESPACE, f"{domain['libraryId']}:{domain['epoch']}:{row['operation_id']}"))
        payload = {"origin": "serverKakaoBind", "workId": work_id, "requestOperationId": row["operation_id"],
                   "payloadDigest": row["payload_digest"]}
        _, _, cached = self.ca.command_batch_receipt(db, library_id=domain["libraryId"], epoch=domain["epoch"],
                                                    operation_id=batch, request_payload=payload)
        return {"row": row, "domain": domain, "work": work, "binding": binding,
                "batch": batch, "payload": payload, "cached": cached}

    def execute(self, sequence):
        if not enabled() or self.stop_event.is_set():
            return
        try:
            with self.get_db() as db:
                db.execute("BEGIN")
                try:
                    pre = self.preflight(db, sequence)
                finally:
                    db.rollback()
            if pre is None:
                return
            if pre["cached"] is not None:
                items = None
            else:
                key = self.bindings.kakao_key()
                if key is None:
                    raise self.planner.RefreshError(self.planner.NO_CREDENTIAL, "kakaoKeyMissing", "credential")
                # Same outbound slot/page admission as interactive searches; no DB
                # transaction survives this point. Daily checks share page budgets.
                slot = self.bindings.gate.provider_locks["kakao"]
                if not slot.acquire(timeout=self.bindings.PROVIDER_WAIT):
                    raise self.bindings.PageBudget(3)
                try:
                    items, _ = self.bindings.search_kakao_items(key, json.loads(pre["row"]["choice_json"])["query"],
                                                              stop=self.stop_event.is_set)
                finally:
                    slot.release()
            if self.stop_event.is_set() or not enabled():
                return
            with self.get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    current = self.preflight(db, sequence)
                    if current is None or self.stop_event.is_set() or not enabled():
                        db.rollback()
                        return
                    now = self.planner.iso(self.now())
                    if current["cached"] is None:
                        self.apply(db, current, items, now)
                    db.execute("UPDATE collection_binding_requests SET state='applied',reason_code=NULL,reason_message=NULL,"
                               "updated_at=?,resolved_at=?,next_attempt_at=NULL WHERE sequence=?", (now, now, sequence))
                    db.commit()
                except BaseException:
                    db.rollback()
                    raise
        except self.bindings.SearchCancelled:
            return
        except Exception as error:
            self.remember(sequence, error)

    def apply(self, db, pre, items, now):
        ca = self.ca
        library_id, epoch, work_id = pre["domain"]["libraryId"], pre["domain"]["epoch"], pre["row"]["collection_id"]
        sources = db.execute("SELECT * FROM collection_authority_volume_sources WHERE library_id=? AND work_id=?"
                             " AND provider='kakao'", (library_id, work_id)).fetchall()
        revisions = {row["volume_number"]: row["entity_revision"] for row in sources}
        existing = {row["volume_number"]: {"volumeNumber": row["volume_number"], "providerItemId": row["provider_item_id"],
                    "title": row["title"], "author": row["author"], "publisher": row["publisher"], "isbn13": row["isbn13"],
                    "publicationDate": row["publication_date"], "itemUrl": row["item_url"], "data": json.loads(row["data"])}
                    for row in sources if not row["deleted"]}
        slot_rows = db.execute("SELECT * FROM collection_authority_volumes WHERE library_id=? AND work_id=?"
                               " AND edition_index=0", (library_id, work_id)).fetchall()
        slots = {row["volume_number"] for row in slot_rows if not row["deleted"]}
        binding = pre["binding"]
        config = json.loads(binding["config"]) if binding is not None and binding["config"] else None
        plan = self.planner.plan_bind(choice=json.loads(pre["row"]["choice_json"]), items=items, checked_at=now,
                                      stored_config=config, existing_sources=existing, existing_slots=slots)
        def command(kind, key, **fields):
            return {"libraryId": library_id, "epoch": epoch, "contractVersion": ca.CONTRACT_VERSION,
                    "operationId": str(uuid.uuid5(uuid.UUID(pre["batch"]), f"{kind}:{key}")), "commandType": kind,
                    "workId": work_id, **fields}
        commands = []
        for source in plan["sources"]:
            number = source["volumeNumber"]
            if existing.get(number) != source:
                fields = {key: value for key, value in source.items() if key != "volumeNumber"}
                commands.append(command(ca.UPSERT_VOLUME_SOURCE, number, volumeNumber=number, provider="kakao",
                                        **fields, deleted=False, expectedRevision=revisions.get(number, 0)))
            if number in plan["newSlots"]:
                old = [row for row in slot_rows if row["volume_number"] == number]
                if len(old) > 1:
                    raise Refused("volumeConflict", "기존 권 정보와 충돌합니다. 연결을 다시 확인해 주세요.")
                old = old[0] if old else None
                ident = old["volume_id"] if old is not None else str(uuid.uuid5(
                    self.planner.NAMESPACE, f"{work_id}:{number}:0:volume"))
                # Revive the original tombstone, preserving manual presentation.
                # A deterministic id may belong to a moved slot; never overwrite it.
                if old is None and db.execute("SELECT 1 FROM collection_authority_volumes WHERE library_id=? AND volume_id=?",
                                              (library_id, ident)).fetchone():
                    raise Refused("volumeConflict", "기존 권 정보와 충돌합니다. 연결을 다시 확인해 주세요.")
                commands.append(command(ca.UPSERT_VOLUME, number, volumeId=ident, volumeNumber=number,
                    editionIndex=0, sortOrder=old["sort_order"] if old is not None else number,
                    displayLabel=old["display_label"] if old is not None else None,
                    coverArtworkId=old["cover_artwork_id"] if old is not None else None,
                    sourceProvider=old["source_provider"] if old is not None else None,
                    sourceCoverId=old["source_cover_id"] if old is not None else None,
                    deleted=False, expectedRevision=old["entity_revision"] if old is not None else 0))
        if binding is None or not binding["bound"] or binding["external_id"] != plan["externalId"] or config != plan["config"]:
            commands.append(command(ca.BIND, "bind", provider="kakao", externalId=plan["externalId"], config=plan["config"],
                                    expectedRevision=binding["entity_revision"] if binding is not None and binding["bound"] else 0))
        commands.append(command(ca.APPLY_SNAPSHOT, "snapshot", provider="kakao", externalId=plan["externalId"],
                                snapshot=plan["snapshot"], values={}, details=None,
                                baseSnapshotDigest=binding["snapshot_digest"] if binding is not None and binding["bound"] else None))
        ca.apply_command_batch(db, library_id=library_id, epoch=epoch, operation_id=pre["batch"],
                               request_payload=pre["payload"], commands=commands, now=now)

    def remember(self, sequence, error):
        if self.stop_event.is_set() or not enabled():
            return
        permanent = isinstance(error, (Refused, self.planner.Ambiguous))
        failure = self.planner.classify(error)
        code, message = "bindApplyFailed", "연결을 적용할 수 없습니다. 선택한 작품을 다시 확인해 주세요."
        if isinstance(error, Refused):
            code, message = error.code, error.message
        elif isinstance(error, self.planner.Ambiguous):
            code, message = "ambiguousBinding", "선택한 검색 결과를 찾거나 구분할 수 없습니다. 다시 선택해 주세요."
        elif failure.reason == self.planner.INVALID_RESPONSE or failure.work_error or failure.kind == "authority":
            permanent = True
            code = failure.code
            if code == "providerIdentityTaken":
                message = "다른 작품에 이미 연결된 검색 결과입니다. 다시 선택해 주세요."
        with self.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT retry_count,state,executor FROM collection_binding_requests WHERE sequence=?",
                             (sequence,)).fetchone()
            if row is None or row["state"] != "pending" or row["executor"] != "server":
                db.rollback()
                return
            now = self.now()
            if permanent:
                db.execute("UPDATE collection_binding_requests SET state='failed',reason_code=?,reason_message=?,"
                           "updated_at=?,resolved_at=?,next_attempt_at=NULL WHERE sequence=?",
                           (code, message, self.planner.iso(now), self.planner.iso(now), sequence))
            else:
                count = min(row["retry_count"] + 1, 1000)
                seconds = (error.wait if isinstance(error, self.bindings.PageBudget) else
                           self.planner.retry_seconds(failure.reason, failure.http_status, failure.retry_after, count))
                db.execute("UPDATE collection_binding_requests SET retry_count=?,next_attempt_at=?,updated_at=?"
                           " WHERE sequence=?", (count, self.planner.iso(now + timedelta(seconds=max(1, seconds))),
                                                  self.planner.iso(now), sequence))
            db.commit()


def register(app, get_db):
    from app_lifecycle import lifecycle
    global _current
    # Construction imports providers but performs no I/O; OFF never starts a thread
    # or migrates request metadata.
    worker = Worker(get_db)
    _current = worker
    hooks = lifecycle(app)
    hooks.on_startup(worker.start)
    hooks.on_drain(worker.drain)
    hooks.on_shutdown(worker.stop)
    return worker
