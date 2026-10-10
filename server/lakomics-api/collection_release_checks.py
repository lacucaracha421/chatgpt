"""Server-owned daily new-volume checks of Kakao-bound manga Collections (SERVER-INDEP-001, slice 1).

Design: ``docs/research/server-release-checks-20261009.md``. Until now only a running PC
checked for new volumes (``collection_updates.rs``), so nothing happened while it was off. This
module lets the server do the same for Kakao: once a day per work it re-runs the Kakao search a
binding stores, merges the result exactly as the PC does, and records the changes through the
ordinary Collections authority commands, so PC and tablet pick them up from the existing feeds.

**Dormant by default.** ``LAKOMICS_RELEASE_CHECKS`` unset/0 (the default): no thread starts,
``serverReleaseChecks:kakao`` is not advertised and both routes answer ``404
releaseChecksUnavailable``. Set it to ``1`` and restart to turn the checker on; unset it and
restart to roll back (a PC then simply resumes its own checks). It also does nothing while the
Collections authority is not active. The feature is advertised only while the switch is on, the
server has a Kakao key and the worker thread is alive (``features``).

Scope and cadence
-----------------
Live manga works with a bound ``kakao`` binding. Each (work, provider) is checked at most once
per 24 h (``collection_release_check_state``; the first time it counts from the binding's
``last_synced_at``). The worker wakes every ``WAKE_SECONDS`` (10 min) or on demand - after
``MORE_SECONDS`` (90 s) while works remain due, and exactly when a provider cool-down or a page
budget wait ends - handles at most ``BATCH_WORKS`` (4) works or ``BATCH_SECONDS`` (90 s) per
wake, one request at a time.
Kakao pages are taken from the shared page budget of ``collection_bindings.gate`` but a
background crawl may use only 120 of its 300 pages a minute; a budget wait reschedules the
rest of the wake (it is not a failure). The daily check never takes the interactive search
slot, so a person's search is never blocked by it.

Failures use the PC's table (``collection_updates.rs`` ``retry_seconds``/``stop_reason``):
transport, quota and credential errors stop the provider for 5 s / 30 s / 2 min / 10 min
(429: 1 / 2 / 5 / 15 min, credential 1 h, ``Retry-After`` up to 24 h as a minimum wait);
invalid responses, work-specific 4xx answers and a rejected command batch (``releaseEventLimit``,
``providerIdentityTaken`` ... - rolled back whole, logged with its code) defer only that work for
24 h. A locked database (``sqlite3.OperationalError``) or a binding that changed meanwhile is not
a failure: nothing is remembered and the work is tried again on a later wake.

One check (``Worker.check_work``)
---------------------------------
1. Read-only preflight (authority, work, binding, today's batch receipt).
2. ``collection_bindings.search_kakao_items(key, config.query)`` without any lock.
3. ``BEGIN IMMEDIATE``, reload the binding and abort (nothing written, retried on a later
   wake) when its ``entity_revision``/``snapshot_digest``/identity changed meanwhile.
4. ``plan_refresh``: the Python port of the PC refresh (``aladin_flow.rs``
   ``refresh_aladin_items_with_config_at`` -> ``reconcile_aladin_at`` -> ``reconcile_source``
   and ``release_watch.rs`` ``pending_release_changes``). It is pinned to the Rust code by
   ``_tools/app/src-tauri/src/library/fixtures/kakao_refresh.json``.
5. ONE ``collection_authority.apply_command_batch`` of ordinary commands (no new command
   type): ``upsertVolumeSource`` / ``upsertVolume`` (edition-0 slot, ``sort_order`` = volume
   number) per volume, ``recordReleaseEvent`` per detected change, ``bindProvider`` when the
   stored identity/config changed, ``applyProviderSnapshot``. The batch is issued by an
   in-process server principal (``"origin": "serverReleaseCheck"`` in its request payload).
   Ids are deterministic - batch ``uuid5(work, provider, day)``, command ``uuid5(batch,
   kind:key)``, event ``uuid5(work, provider, kind, volume, previous, current, day)`` - so a
   replay (same day twice, a retry after a crash) changes nothing, a flip back and forth on
   later days is recorded each time, and a change already recorded as the latest event of that
   volume (by the server or by a PC under another id, ``collection_authority._record_release``)
   is not recorded again.

   Nothing is written when nothing changed (no source, slot, event, binding or snapshot
   difference): the daily check then only touches ``collection_release_check_state``, as the PC
   only enqueues a snapshot on change. The previous check time of the status rule is
   ``max(state.last_checked_at, binding.last_synced_at)`` (the PC's subscription check time).

Event gating mirrors the PC from server state: ``derived.releaseWatch.enabled`` (the PC's
release subscription), a non-empty ``derived.ownedVolumes`` (Kakao alerts only for works with
owned-volume tracking) and ``derived.volumeRange``.

Routes (client role; both ``404 releaseChecksUnavailable`` while the switch is off)
------------------------------------------------------------------------------------
1. ``GET /v1/collections/release-checks/status``
   ``{"version": 1, "providers": {"kakao": CollectionUpdateStatus}}`` - the PC's
   ``CollectionUpdateStatus`` JSON: ``provider, checked, changedCollections, failed,
   remaining, requests, elapsedMs, networkMs, throttleMs, startedAt, finishedAt, retryAt,
   stopReason, consecutiveFailures, lastFailure {collectionId, detectedAt, kind, endpoint,
   httpStatus, retryAfterSeconds}, busy``. ``remaining`` is the number of works due now,
   ``busy`` is true while a wake is running.

2. ``POST /v1/collections/release-checks/run`` body ``{"provider": "kakao", "workId": id?}``
   Wakes the worker now (it never bypasses the once-a-day rule or a provider cool-down).
   With ``workId`` that work goes first when it is due. Reply ``{"version": 1, "provider",
   "workId", "queued": bool, "reason": null | "notDue", "status": CollectionUpdateStatus}``.
   Errors: ``422 invalidReleaseCheckRequest``, ``429 releaseCheckRateLimited`` (at most
   ``RUN_PER_MINUTE`` runs a minute per client, with ``Retry-After``), ``409
   authorityInactive``, ``503 kakaoSearchUnavailable`` (no server Kakao key), ``404
   releaseCheckWorkNotFound`` (not a live manga with a Kakao binding).

Errors are ``{"detail": {"code", "message"}}`` with Korean messages (401 from the auth guard is
``{"detail": "Unauthorized"}``).
"""
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from functools import cmp_to_key
from typing import Annotated, Literal

from fastapi import Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import authority
import collection_authority as ca
import collection_bindings as bindings
from app_lifecycle import join_worker, lifecycle

ENV = "LAKOMICS_RELEASE_CHECKS"
FEATURE = "serverReleaseChecks:kakao"
PREFIX = "/v1/collections/release-checks"
PROVIDER = "kakao"
ORIGIN = "serverReleaseCheck"
#: Fixed namespace of every id this module derives.
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://lakomics.invalid/serverReleaseCheck")

CHECK_INTERVAL = timedelta(hours=24)
WAKE_SECONDS = 600.0
MORE_SECONDS = 90.0
START_DELAY = 30.0
BATCH_WORKS = 4
BATCH_SECONDS = 90.0
RUN_PER_MINUTE = 6
MAX_BOUND_GROUPS = 10
MAX_BODY_BYTES = 1024

DDL = """
CREATE TABLE IF NOT EXISTS collection_release_check_state(
 work_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 last_checked_at TEXT,
 retry_at TEXT,
 last_error_code TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(work_id, provider));
CREATE TABLE IF NOT EXISTS collection_release_check_status(
 provider TEXT PRIMARY KEY,
 status_json TEXT NOT NULL);
"""


def startup_db(db):
    """Plain state tables; additive, created whether or not the checker is enabled."""
    db.executescript(DDL)


def enabled():
    return os.environ.get(ENV, "").strip().lower() in ("1", "true", "yes", "on")


#: The worker ``register`` installed last (what ``features`` asks whether it is alive).
_current = None


def features():
    """The authority status ``features`` this module contributes: ``serverReleaseChecks:kakao``
    only while the switch is on, the server has a Kakao key and the worker thread is alive -
    a PC that sees it stops checking itself, so it must be true."""
    worker = _current
    if not enabled() or bindings.kakao_key() is None or worker is None or not worker.alive():
        return []
    return [FEATURE]


def fail(status, code, message, headers=None, **extra):
    raise HTTPException(status, {"code": code, "message": message, **extra}, headers=headers)


# --- time ---------------------------------------------------------------------------------

def parse_time(value):
    """Aware ``datetime`` of an RFC 3339 / ISO 8601 text (no offset = UTC), else None."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def iso(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- the PC refresh, ported ---------------------------------------------------------------
# Everything from here to ``plan_refresh`` is pure (no database, no I/O). Rust sources:
# aladin_flow.rs (ProviderConfig, refind_group, refresh_aladin_items_with_config_at,
# reconcile_aladin_at, reconcile_source) and release_watch.rs (pending_release_changes).

class Ambiguous(Exception):
    """The stored binding cannot be matched to the search (``AmbiguousAladinBinding``)."""


def _strings(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def parse_config(config, external_id):
    """``ProviderConfig::parse``: ``{"query", "groups": [{anchorItemId, groupFingerprint,
    knownItemIds}]}`` of a stored ``provider_config_json`` (version 1 or 2), else None."""
    if not isinstance(config, dict) or not isinstance(config.get("query"), str):
        return None
    version = config.get("version")
    if type(version) is int and version == 1:
        fingerprint, known = config.get("groupFingerprint"), config.get("knownItemIds", [])
        if not isinstance(fingerprint, str) or not _strings(known):
            return None
        groups = [{"anchorItemId": external_id, "groupFingerprint": fingerprint, "knownItemIds": list(known)}]
    elif type(version) is int and version == 2:
        raw = config.get("groups")
        if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_BOUND_GROUPS:
            return None
        groups = []
        for group in raw:
            if (not isinstance(group, dict) or not isinstance(group.get("anchorItemId"), str)
                    or not isinstance(group.get("groupFingerprint"), str) or not _strings(group.get("knownItemIds"))):
                return None
            groups.append({"anchorItemId": group["anchorItemId"], "groupFingerprint": group["groupFingerprint"],
                           "knownItemIds": list(group["knownItemIds"])})
    else:
        return None
    return {"query": config["query"], "groups": groups}


def config_json(query, groups):
    """``ProviderConfig::to_json``: version 1 for a single group, version 2 for several."""
    if len(groups) == 1:
        group = groups[0]
        return {"version": 1, "query": query, "groupFingerprint": group["groupFingerprint"],
                "knownItemIds": group["knownItemIds"]}
    return {"version": 2, "query": query, "groups": groups}


def refind_group(anchor, fingerprint, known_ids, groups):
    """``refind_group``: index of the search group a stored group now is, or None.

    ``groups`` is ``[(fingerprint, member item ids)]``. The anchor wins; without it a unique
    group holding a known item; known items split over several groups are narrowed by the
    fingerprint; a pick without history uses the fingerprint alone.
    """
    def unique(indices):
        return indices[0] if len(indices) == 1 else None

    anchors = [i for i, (_, ids) in enumerate(groups) if anchor in ids]
    if anchors:
        return unique(anchors)
    known = [i for i, (_, ids) in enumerate(groups) if any(item in known_ids for item in ids)]
    if len(known) == 1:
        return known[0]
    return unique([i for i, (key, _) in enumerate(groups) if key == fingerprint and (not known_ids or i in known)])


def release_status_at(publication_date, checked_at):
    """``upcoming`` / ``released`` of a ``YYYY-MM-DD`` date on the date of ``checked_at``
    (in its own offset, as chrono's ``date_naive``), else None."""
    if not isinstance(publication_date, str):
        return None
    try:
        date = datetime.strptime(publication_date, "%Y-%m-%d").date()
    except ValueError:
        return None
    checked = parse_time(checked_at)
    if checked is None:
        return None
    return "upcoming" if date > checked.date() else "released"


def pending_release_changes(existing, item, previous_checked_at, checked_at):
    """``pending_release_changes``: new volume, changed date, upcoming -> released."""
    volume = item["volumeNumber"]
    if existing is None:
        return [{"kind": "new_volume", "volumeNumber": volume, "previousValue": None,
                 "currentValue": item["publicationDate"]}]
    changes = []
    if existing["publicationDate"] != item["publicationDate"]:
        changes.append({"kind": "release_date_changed", "volumeNumber": volume,
                        "previousValue": existing["publicationDate"], "currentValue": item["publicationDate"]})
    if previous_checked_at is not None:
        previous = release_status_at(existing["publicationDate"], previous_checked_at)
        current = release_status_at(item["publicationDate"], checked_at)
        if previous is not None and current is not None and previous != current:
            changes.append({"kind": "release_status_changed", "volumeNumber": volume,
                            "previousValue": previous, "currentValue": current})
    return changes


def source_row(item):
    """The ``collection_volume_sources`` row of a (merged) product, as the PC stores it."""
    return {"volumeNumber": item["volumeNumber"], "providerItemId": item["itemId"],
            "title": item["title"].strip(), "author": item["author"], "publisher": item["publisher"],
            "isbn13": item["isbn13"], "publicationDate": item["publicationDate"], "itemUrl": item["itemUrl"],
            "data": item["raw"]}


def plan_refresh(*, stored_config, external_id, items, checked_at, existing_sources, existing_slots,
                 gating, previous_checked_at, baseline_established=None, existing_volume_numbers=None):
    """The PC's Kakao refresh of one binding as data (nothing is written here).

    * ``stored_config`` / ``external_id``: the binding's ``provider_config_json`` and anchor.
    * ``items``: the parsed products of the search (``collection_bindings.kakao_item``).
    * ``checked_at``: RFC 3339 time of this check (becomes ``detectedAt`` of every event).
    * ``existing_sources``: ``{volumeNumber: stored source row}`` (``source_row`` shape).
    * ``existing_slots``: volume numbers that already have an edition-0 slot.
    * ``gating``: ``{"releaseWatch", "tracksOwnership", "minVolume", "maxVolume"}``.
    * ``previous_checked_at``: the subscription's previous check time, or None.
    * ``baseline_established``: whether this binding has provider history; defaults to
      live source history for standalone planners. Timestamps alone do not establish it.
    * ``existing_volume_numbers``: all live slot numbers, across editions/providers;
      defaults to ``existing_slots``. Only edition-0 slots control slot creation.

    Returns ``{"config", "externalId", "snapshot", "sources", "newSlots", "events", "result"}``;
    raises ``Ambiguous`` when a stored group cannot be re-found.
    """
    config = parse_config(stored_config, external_id)
    if config is None:
        raise Ambiguous()
    groups = bindings.grouped_kakao(items)
    keys = [(group["candidate"]["groupFingerprint"], group["memberIds"]) for group in groups]
    picked = []
    for bound in config["groups"]:
        index = refind_group(bound["anchorItemId"], bound["groupFingerprint"], bound["knownItemIds"], keys)
        if index is None:
            raise Ambiguous()
        series = groups[index]
        fingerprint = series["candidate"]["groupFingerprint"]
        same = next((pick for pick in picked if pick["series"]["candidate"]["groupFingerprint"] == fingerprint), None)
        if same is not None:
            same["known"].extend(bound["knownItemIds"])
        else:
            picked.append({"anchor": bound["anchorItemId"], "known": list(bound["knownItemIds"]), "series": series})
    if baseline_established is None:
        baseline_established = bool(existing_sources)
    return reconcile(stored_config, config["query"], picked, checked_at, existing_sources, existing_slots,
                     gating, previous_checked_at, baseline_established, existing_volume_numbers)


def plan_bind(*, choice, items, checked_at, stored_config, existing_sources, existing_slots):
    """Delayed selection: anchor first, otherwise a unique fingerprint; quiet baseline.

    Display hints never enter the planner. Coincident selections become one group.
    Legacy single-group choices are normalized by the request boundary.
    """
    groups = bindings.grouped_kakao(items)
    keys = [(group["candidate"]["groupFingerprint"], group["memberIds"]) for group in groups]
    picked, seen = [], set()
    for selected in choice["groups"]:
        index = refind_group(selected["anchorItemId"], selected["groupFingerprint"], [], keys)
        if index is None:
            raise Ambiguous()
        if index in seen:
            next(pick for pick in picked if pick["series"] is groups[index])["known"].append(selected["anchorItemId"])
            continue
        seen.add(index)
        picked.append({"anchor": groups[index]["candidate"]["anchorItemId"],
                       "known": [selected["anchorItemId"]], "series": groups[index]})
    if not picked:
        raise Ambiguous()
    return reconcile(stored_config, choice["query"], picked, checked_at, existing_sources, existing_slots,
                     {"releaseWatch": False, "tracksOwnership": False}, None)


def reconcile(stored_config, query, picked, checked_at, existing_sources, existing_slots, gating,
              previous_checked_at, baseline_established=False, existing_volume_numbers=None):
    """``reconcile_aladin_at``: groups ordered by lowest volume (then fingerprint), the first
    anchor becomes the binding identity, a volume offered by several groups keeps the product
    ``compare_duplicate_preference`` prefers (the others count as ignored)."""
    picked.sort(key=lambda pick: (max(pick["series"]["items"][0]["volumeNumber"], 1),
                                  pick["series"]["candidate"]["groupFingerprint"]))
    groups = [{"anchorItemId": pick["anchor"],
               "groupFingerprint": pick["series"]["candidate"]["groupFingerprint"],
               "knownItemIds": sorted(set(pick["known"]) | {item["itemId"] for item in pick["series"]["items"]})}
              for pick in picked]
    new_config = config_json(query.strip(), groups)
    candidates = [pick["series"]["candidate"] for pick in picked]
    snapshot = candidates[0] if len(candidates) == 1 else {"groups": candidates}
    all_items = sorted((item for pick in picked for item in pick["series"]["items"]),
                       key=cmp_to_key(bindings._prefer))
    merged = {}
    for item in all_items:
        number = max(item["volumeNumber"], 1)
        merged.setdefault(number, {**item, "volumeNumber": number})
    ignored = sum(candidate["ignoredCount"] for candidate in candidates) + len(all_items) - len(merged)
    volumes = sorted(merged)
    stored = stored_config if isinstance(stored_config, dict) else {}
    dismissed = stored.get("reviewDismissedVolumes")
    if isinstance(dismissed, list) and all(type(n) is int for n in dismissed) and dismissed == volumes:
        new_config["reviewDismissedVolumes"] = volumes
    result = {"added": 0, "updated": 0, "unchanged": 0, "ignored": ignored}
    sources, events = [], []
    track = baseline_established and gating["releaseWatch"] and gating["tracksOwnership"]
    live_volumes = existing_slots if existing_volume_numbers is None else existing_volume_numbers
    for number in volumes:
        item = merged[number]
        existing = existing_sources.get(number)
        row = source_row(item)
        if existing is None:
            result["added"] += 1
        elif existing == row:
            result["unchanged"] += 1
        else:
            result["updated"] += 1
        sources.append(row)
        if track:
            for change in pending_release_changes(existing, item, previous_checked_at, checked_at):
                if change["kind"] == "new_volume" and number in live_volumes:
                    continue
                low, high = gating.get("minVolume"), gating.get("maxVolume")
                if (low is None or change["volumeNumber"] >= low) and (high is None or change["volumeNumber"] <= high):
                    events.append(change)
    return {"config": new_config, "externalId": picked[0]["anchor"], "snapshot": snapshot, "sources": sources,
            "newSlots": [number for number in volumes if number not in existing_slots], "events": events,
            "result": result}


# --- failures: the PC's backoff table (collection_updates.rs) -----------------------------

RATE_LIMITED, TIMED_OUT, UNAVAILABLE = "rate_limited", "timed_out", "unavailable"
INVALID_RESPONSE, NO_CREDENTIAL, BAD_CREDENTIAL = "invalid_response", "credential_not_configured", "invalid_credential"


def retry_seconds(reason, http_status, retry_after, consecutive):
    """``retry_seconds``: how long the provider stays stopped after ``consecutive`` failures."""
    index = min(max(consecutive - 1, 0), 3)
    if reason == RATE_LIMITED:
        base = (60, 120, 300, 900)[index]
    elif reason in (NO_CREDENTIAL, BAD_CREDENTIAL) or http_status in (401, 403):
        base = 3600
    else:
        base = (5, 30, 120, 600)[index]
    # Server deadlines are minimum waits, also when a 503 supplies Retry-After.
    return max(base, min(retry_after or 0, 86400))


class RefreshError(Exception):
    """One work's check failed: ``reason`` is the PC's stop reason (None = this work only)."""

    def __init__(self, reason, code, kind, http_status=None, retry_after=None, endpoint="search"):
        super().__init__(code)
        self.reason, self.code, self.kind, self.endpoint = reason, code, kind, endpoint
        self.http_status, self.retry_after = http_status, retry_after

    @property
    def work_error(self):
        """A 4xx answer that belongs to this work (not auth, timeout or quota)."""
        return (self.http_status is not None and 400 <= self.http_status < 500
                and self.http_status not in (401, 403, 408, 429))

    def failure(self):
        return {"kind": self.kind, "endpoint": self.endpoint, "httpStatus": self.http_status,
                "retryAfterSeconds": self.retry_after}


def classify(error):
    """The ``RefreshError`` an exception of a check stands for."""
    if isinstance(error, RefreshError):
        return error
    if isinstance(error, bindings.Upstream):
        if error.kind == "timeout":
            return RefreshError(TIMED_OUT, "timeout", "timeout")
        if error.kind == "status":
            status = error.status
            if status in (401, 403):
                return RefreshError(BAD_CREDENTIAL, "credentialRejected", "http", status, error.retry_after)
            if status == 429:
                return RefreshError(RATE_LIMITED, "rateLimited", "http", status, error.retry_after)
            return RefreshError(UNAVAILABLE, "upstreamFailed", "http", status, error.retry_after)
        if error.kind == "invalid":
            return RefreshError(INVALID_RESPONSE, "invalidResponse", "invalid_response")
        return RefreshError(UNAVAILABLE, "upstreamUnavailable", "connection")
    if isinstance(error, bindings.KakaoTooBroad):
        return RefreshError(INVALID_RESPONSE, "searchTooBroad", "invalid_response")
    if isinstance(error, Ambiguous):
        return RefreshError(None, "ambiguousBinding", "unknown")
    if isinstance(error, HTTPException):
        # A rejected command batch: ``endpoint`` carries the authority's error code.
        detail = error.detail if isinstance(error.detail, dict) else {}
        code = str(detail.get("code") or "commandRejected")[:64]
        return RefreshError(None, code, "authority", endpoint=code)
    return RefreshError(None, "internalError", "unknown")


class Ineligible(Exception):
    """The work is gone, not a live manga, or no longer bound to Kakao: nothing to check."""


class BindingChanged(Exception):
    """The binding (or the authority) changed during the crawl: nothing is written."""


# --- status -------------------------------------------------------------------------------

def default_status():
    return {"provider": PROVIDER, "checked": 0, "changedCollections": 0, "failed": 0, "remaining": 0,
            "requests": 0, "elapsedMs": 0, "networkMs": 0, "throttleMs": 0, "startedAt": None,
            "finishedAt": None, "retryAt": None, "stopReason": None, "consecutiveFailures": 0,
            "lastFailure": None, "busy": False}


def load_status(db):
    row = db.execute("SELECT status_json FROM collection_release_check_status WHERE provider=?",
                     (PROVIDER,)).fetchone()
    try:
        stored = json.loads(row[0]) if row else {}
    except ValueError:
        stored = {}
    status = default_status()
    status.update({key: value for key, value in stored.items() if key in status})
    return status


def save_status(db, status):
    db.execute("INSERT INTO collection_release_check_status(provider,status_json) VALUES(?,?)"
               " ON CONFLICT(provider) DO UPDATE SET status_json=excluded.status_json",
               (PROVIDER, json.dumps({**status, "busy": False}, sort_keys=True)))


def event_id(work_id, change, day):
    """Deterministic id of one change seen on ``day`` (``YYYY-MM-DD``): the same change on the
    same day is the same event however often seen, a flip back and forth on later days is not."""
    text = lambda value: "" if value is None else str(value)
    return str(uuid.uuid5(NAMESPACE, ":".join((work_id, PROVIDER, change["kind"], str(change["volumeNumber"]),
                                                text(change["previousValue"]), text(change["currentValue"]), day))))


# --- the worker ---------------------------------------------------------------------------

class Worker:
    """One daemon lane for the whole application; all state lives in SQLite."""

    def __init__(self, get_db, *, now=lambda: datetime.now(timezone.utc)):
        self.get_db, self.now = get_db, now
        self.stop_event = threading.Event()
        self.wake_event = threading.Event()
        self.lane = threading.Lock()
        self.thread = None
        self.priority = []
        self.delay = None
        self.more = False
        self.start_delay = START_DELAY

    # lifecycle (app_lifecycle hooks) -------------------------------------------------------
    def start(self):
        if not enabled():
            return
        if self.thread is not None and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self.run, name="release-checks", daemon=True)
        self.thread.start()

    def alive(self):
        thread = self.thread
        return thread is not None and thread.is_alive() and not self.stop_event.is_set()

    def wake(self):
        self.wake_event.set()

    def drain(self):
        self.stop_event.set()
        self.wake()

    def stop(self):
        self.drain()
        thread = self.thread
        if thread is not None:
            join_worker(thread, 6, lambda: setattr(self, "thread", None))

    def run(self):
        if self.stop_event.wait(self.start_delay):
            return
        while not self.stop_event.is_set():
            # Clear before the cycle: a wake that arrives during it must cut the next wait short.
            self.wake_event.clear()
            wait = WAKE_SECONDS
            self.delay = None
            self.more = False
            try:
                wait = self.next_wait(self.run_batch())
            except Exception:
                logging.getLogger(__name__).exception("release check cycle failed")
            if not self.stop_event.is_set():
                self.wake_event.wait(wait)

    def next_wait(self, status):
        """Seconds until the next wake after a batch that returned ``status``: a page-budget
        wait or a provider cool-down is waited out exactly (at most one ``WAKE_SECONDS``;
        nothing is requested while a longer one lasts), works still due come back soon, else
        the ordinary interval."""
        if self.delay is not None:
            return max(1.0, min(self.delay + 1.0, WAKE_SECONDS))
        retry = parse_time(status.get("retryAt"))
        if retry is not None and retry > self.now():
            return max(1.0, min((retry - self.now()).total_seconds() + 1.0, WAKE_SECONDS))
        if self.more:
            return MORE_SECONDS
        return WAKE_SECONDS

    # selection ------------------------------------------------------------------------------
    def due(self, db, library_id, now, *, only=None):
        """Work ids due now, oldest check first, requested works first."""
        rows = db.execute(
            "SELECT w.work_id AS work_id, b.last_synced_at AS synced, s.last_checked_at AS checked,"
            " s.retry_at AS retry FROM collection_authority_works w"
            " JOIN collection_authority_bindings b ON b.library_id=w.library_id AND b.work_id=w.work_id"
            "  AND b.provider=? AND b.bound=1"
            " LEFT JOIN collection_release_check_state s ON s.work_id=w.work_id AND s.provider=?"
            " WHERE w.library_id=? AND w.type='manga' AND w.lifecycle='live'"
            + ("" if only is None else " AND w.work_id=?"),
            [PROVIDER, PROVIDER, library_id] + ([] if only is None else [only])).fetchall()
        cutoff = now - CHECK_INTERVAL
        found = []
        for row in rows:
            retry = parse_time(row["retry"])
            if retry is not None and retry > now:
                continue
            last = row["checked"] or row["synced"]
            checked = parse_time(last)
            if checked is None or checked <= cutoff:
                found.append((last or "", row["work_id"]))
        found.sort()
        ids = [work_id for _, work_id in found]
        first = [work_id for work_id in self.priority if work_id in ids]
        return first + [work_id for work_id in ids if work_id not in first]

    def library(self, db):
        return authority.active_domain(db, ca.DOMAIN)

    # public views ---------------------------------------------------------------------------
    def status_view(self):
        now = self.now()
        with self.get_db() as db:
            status = load_status(db)
            domain = self.library(db)
            status["remaining"] = 0 if domain is None else len(self.due(db, domain["libraryId"], now))
        status["busy"] = self.lane.locked()
        return status

    def request(self, work_id):
        """Put ``work_id`` first in the next wake when it is due; ``(queued, reason)``."""
        now = self.now()
        with self.get_db() as db:
            domain = self.library(db)
            if domain is None:
                fail(409, authority.CODE_AUTHORITY_INACTIVE, "이 영역은 아직 서버 권위가 아닙니다.")
            row = db.execute(
                "SELECT 1 FROM collection_authority_works w JOIN collection_authority_bindings b"
                " ON b.library_id=w.library_id AND b.work_id=w.work_id AND b.provider=? AND b.bound=1"
                " WHERE w.library_id=? AND w.work_id=? AND w.type='manga' AND w.lifecycle='live'",
                (PROVIDER, domain["libraryId"], work_id)).fetchone()
            if row is None:
                fail(404, "releaseCheckWorkNotFound", "카카오에 연결된 만화 작품을 찾을 수 없습니다.")
            due = bool(self.due(db, domain["libraryId"], now, only=work_id))
        if due and work_id not in self.priority:
            self.priority.append(work_id)
        return due, None if due else "notDue"

    # one wake -------------------------------------------------------------------------------
    def run_batch(self):
        """Port of ``run_collection_updates_with``: up to ``BATCH_WORKS`` due works, at most
        ``BATCH_SECONDS``, then the provider status. Returns the status."""
        if not self.lane.acquire(blocking=False):
            return {**self.status_view(), "busy": True}
        try:
            return self._run_batch()
        finally:
            self.lane.release()

    def _run_batch(self):
        now = self.now()
        with self.get_db() as db:
            domain = self.library(db)
            status = load_status(db)
            if not enabled() or domain is None:
                return status
            library_id = domain["libraryId"]
            retry = parse_time(status["retryAt"])
            if retry is not None and retry > now:
                return status
            pending = self.due(db, library_id, now)
        if not pending:
            return status
        if status["finishedAt"] is not None or status["startedAt"] is None:
            status = {**default_status(), "startedAt": iso(now)}
        status.update(retryAt=None, stopReason=None, remaining=len(pending))
        started = time.monotonic()
        stats = {}
        for work_id in pending[:BATCH_WORKS]:
            if self.stop_event.is_set() or time.monotonic() - started >= BATCH_SECONDS:
                break
            moment = self.now()
            try:
                recorded = self.check_work(work_id, moment, stats)
            except (Ineligible, BindingChanged, bindings.SearchCancelled):
                continue
            except sqlite3.OperationalError:
                # "database is locked" and the like: nothing was written or remembered, so the
                # work is simply due again on the next wake. Do not hammer a busy database.
                logging.getLogger(__name__).warning("release check of one work: database busy, retrying later")
                break
            except bindings.PageBudget as budget:
                # The shared page budget is used up: try again after it refills; not a failure.
                self.delay = budget.wait
                break
            except Exception as error:
                failure = classify(error)
                if isinstance(error, HTTPException):
                    logging.getLogger(__name__).warning(
                        "release check batch rejected (HTTP %s, %s); the work is deferred a day",
                        error.status_code, failure.code)
                elif not isinstance(error, (RefreshError, bindings.Upstream, bindings.KakaoTooBroad, Ambiguous)):
                    logging.getLogger(__name__).exception("release check of one work failed")
                status["failed"] += 1
                status["lastFailure"] = {"collectionId": work_id, "detectedAt": iso(moment), **failure.failure()}
                if failure.reason is not None and failure.reason != INVALID_RESPONSE and not failure.work_error:
                    status["consecutiveFailures"] += 1
                    seconds = retry_seconds(failure.reason, failure.http_status, failure.retry_after,
                                            status["consecutiveFailures"])
                    status["stopReason"] = failure.reason
                    status["retryAt"] = iso(moment + timedelta(seconds=seconds))
                    self.remember(work_id, moment, error_code=failure.code)
                    break
                status["consecutiveFailures"] = 0
                # A removed or mismatched work must not block the rest, nor be retried by each wake.
                self.remember(work_id, moment, error_code=failure.code, retry_at=moment + CHECK_INTERVAL)
                continue
            status["consecutiveFailures"] = 0
            if status["lastFailure"] and status["lastFailure"]["collectionId"] == work_id:
                status["lastFailure"] = None
            status["checked"] += 1
            if recorded:
                status["changedCollections"] += 1
            self.priority = [other for other in self.priority if other != work_id]
        status["requests"] += stats.get("requests", 0)
        status["networkMs"] += stats.get("networkMs", 0)
        status["elapsedMs"] += int((time.monotonic() - started) * 1000)
        with self.get_db() as db:
            status["remaining"] = len(self.due(db, library_id, self.now()))
            if status["remaining"] == 0:
                status["finishedAt"] = iso(self.now())
            save_status(db, status)
            db.commit()
        self.more = status["remaining"] > 0
        return status

    def remember(self, work_id, moment, *, error_code=None, retry_at=None, checked=False):
        """Upsert the work's state row (only what is given changes)."""
        with self.get_db() as db:
            db.execute(
                "INSERT INTO collection_release_check_state(work_id,provider,last_checked_at,retry_at,"
                "last_error_code,updated_at) VALUES(?,?,?,?,?,?)"
                " ON CONFLICT(work_id,provider) DO UPDATE SET"
                " last_checked_at=CASE WHEN ? THEN excluded.last_checked_at ELSE last_checked_at END,"
                " retry_at=CASE WHEN ? THEN excluded.retry_at ELSE retry_at END,"
                " last_error_code=excluded.last_error_code, updated_at=excluded.updated_at",
                (work_id, PROVIDER, iso(moment) if checked else None,
                 None if retry_at is None else iso(retry_at), error_code, iso(moment),
                 int(checked), int(retry_at is not None)))
            db.commit()

    # one work -------------------------------------------------------------------------------
    def check_work(self, work_id, moment, stats=None):
        """Check one work now; returns whether a release event was recorded.

        Raises ``Ineligible``/``BindingChanged`` (nothing written, nothing remembered),
        ``bindings.PageBudget``/``SearchCancelled`` (nothing written) or the failure.
        """
        checked_at = iso(moment)
        with self.get_db() as db:
            db.execute("BEGIN")
            try:
                pre = self.preflight(db, work_id, checked_at)
            finally:
                db.rollback()
        if pre["cached"] is not None:
            self.remember(work_id, moment, checked=True, retry_at=moment + CHECK_INTERVAL)
            return False
        key = bindings.kakao_key()
        if key is None:
            raise RefreshError(NO_CREDENTIAL, "kakaoKeyMissing", "credential")
        items, _ = bindings.search_kakao_items(key, pre["query"], background=True,
                                               stop=self.stop_event.is_set, stats=stats)
        with self.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                recorded = self.apply(db, pre, items, moment, checked_at)
                db.commit()
            except BaseException:
                db.rollback()
                raise
        self.remember(work_id, moment, checked=True, retry_at=moment + CHECK_INTERVAL)
        return recorded

    def preflight(self, db, work_id, checked_at):
        domain = self.library(db)
        if domain is None:
            raise Ineligible()
        library_id = domain["libraryId"]
        work = ca.work_row(db, library_id, work_id)
        binding = ca.binding_row(db, library_id, work_id, PROVIDER)
        if (work is None or work["lifecycle"] != "live" or work["type"] != "manga"
                or binding is None or not binding["bound"]):
            raise Ineligible()
        config = parse_config(json.loads(binding["config"]) if binding["config"] else None,
                              binding["external_id"])
        if config is None:
            raise Ambiguous()
        day = checked_at[:10]
        batch = str(uuid.uuid5(NAMESPACE, f"{work_id}:{PROVIDER}:{day}"))
        payload = {"origin": ORIGIN, "workId": work_id, "provider": PROVIDER, "day": day}
        _, _, cached = ca.command_batch_receipt(db, library_id=library_id, epoch=domain["epoch"],
                                                operation_id=batch, request_payload=payload)
        return {"libraryId": library_id, "epoch": domain["epoch"], "workId": work_id, "query": config["query"],
                "revision": binding["entity_revision"], "digest": binding["snapshot_digest"],
                "externalId": binding["external_id"], "config": binding["config"], "batch": batch,
                "payload": payload, "cached": cached}

    def apply(self, db, pre, items, moment, checked_at):
        """Under ``BEGIN IMMEDIATE``: reload, plan, apply the one command batch."""
        library_id, work_id = pre["libraryId"], pre["workId"]
        domain = self.library(db)
        if domain is None or domain["libraryId"] != library_id or domain["epoch"] != pre["epoch"]:
            raise BindingChanged()
        work = ca.work_row(db, library_id, work_id)
        binding = ca.binding_row(db, library_id, work_id, PROVIDER)
        if (work is None or work["lifecycle"] != "live" or work["type"] != "manga"
                or binding is None or not binding["bound"]):
            raise Ineligible()
        if (binding["entity_revision"], binding["snapshot_digest"], binding["external_id"], binding["config"]) != (
                pre["revision"], pre["digest"], pre["externalId"], pre["config"]):
            raise BindingChanged()
        _, _, cached = ca.command_batch_receipt(db, library_id=library_id, epoch=pre["epoch"],
                                                operation_id=pre["batch"], request_payload=pre["payload"])
        if cached is not None:
            return False
        derived = json.loads(work["derived"])
        watch, owned, bounds = derived.get("releaseWatch") or {}, derived.get("ownedVolumes"), derived.get("volumeRange") or {}
        gating = {"releaseWatch": bool(watch.get("enabled")), "tracksOwnership": bool(owned),
                  "minVolume": bounds.get("minVolume"), "maxVolume": bounds.get("maxVolume")}
        state = db.execute("SELECT last_checked_at FROM collection_release_check_state WHERE work_id=? AND provider=?",
                           (work_id, PROVIDER)).fetchone()
        # The PC compares with the subscription's check time, which every refresh (PC ones too)
        # updates; here that is the later of our own last check and the binding's last snapshot
        # write (every refresh and snapshot, whoever made it, stamps ``last_synced_at``).
        times = [text for text in (state["last_checked_at"] if state else None, binding["last_synced_at"])
                 if parse_time(text) is not None]
        previous = max(times, key=parse_time, default=None)
        source_rows = db.execute(
            "SELECT * FROM collection_authority_volume_sources WHERE library_id=? AND work_id=? AND provider=?",
            (library_id, work_id, PROVIDER)).fetchall()
        revisions = {row["volume_number"]: row["entity_revision"] for row in source_rows}
        existing = {row["volume_number"]: {
            "volumeNumber": row["volume_number"], "providerItemId": row["provider_item_id"], "title": row["title"],
            "author": row["author"], "publisher": row["publisher"], "isbn13": row["isbn13"],
            "publicationDate": row["publication_date"], "itemUrl": row["item_url"], "data": json.loads(row["data"])}
            for row in source_rows if not row["deleted"]}
        slots = {row["volume_number"] for row in db.execute(
            "SELECT volume_number FROM collection_authority_volumes WHERE library_id=? AND work_id=?"
            " AND edition_index=0 AND deleted=0", (library_id, work_id))}
        live_volumes = {row["volume_number"] for row in db.execute(
            "SELECT volume_number FROM collection_authority_volumes WHERE library_id=? AND work_id=?"
            " AND deleted=0", (library_id, work_id))}
        # Adoption timestamps and subscription history are not a Kakao baseline.
        # A rebind may retain old sources/snapshot as a merge base; its snapshot
        # must still describe the current identity and selected groups.
        config = parse_config(json.loads(pre["config"]), binding["external_id"])
        snapshot = json.loads(binding["snapshot"]) if binding["snapshot"] else {}
        candidates = snapshot.get("groups", [snapshot]) if isinstance(snapshot, dict) else []
        baseline = (bool(existing) and binding["snapshot_external_id"] == binding["external_id"]
                    and isinstance(candidates, list) and all(isinstance(c, dict) for c in candidates)
                    and {c.get("groupFingerprint") for c in candidates}
                    == {g["groupFingerprint"] for g in config["groups"]})
        plan = plan_refresh(stored_config=json.loads(pre["config"]) if pre["config"] else None,
                            external_id=binding["external_id"], items=items, checked_at=checked_at,
                            existing_sources=existing, existing_slots=slots, gating=gating,
                            previous_checked_at=previous, baseline_established=baseline,
                            existing_volume_numbers=live_volumes)
        batch = uuid.UUID(pre["batch"])

        def command(kind, key, **fields):
            return {"libraryId": library_id, "epoch": pre["epoch"], "contractVersion": ca.CONTRACT_VERSION,
                    "operationId": str(uuid.uuid5(batch, f"{kind}:{key}")), "commandType": kind,
                    "workId": work_id, **fields}

        events = {}
        detected_ms = int(parse_time(checked_at).timestamp() * 1000)
        for change in plan["events"]:
            values = (work_id, work["name"], PROVIDER, change["kind"], change["volumeNumber"],
                      change["previousValue"], change["currentValue"], checked_at)
            ident = event_id(work_id, change, checked_at[:10])
            known = db.execute("SELECT 1 FROM collection_release_events WHERE event_id=?", (ident,)).fetchone()
            if known is None and not ca._release_seen_recently(db, values, detected_ms):
                events.setdefault(change["volumeNumber"], []).append((ident, change))
        commands = []
        data_changed = False  # a source row or slot is written
        for row in plan["sources"]:
            number = row["volumeNumber"]
            if existing.get(number) != row:
                data_changed = True
                commands.append(command(ca.UPSERT_VOLUME_SOURCE, number, volumeNumber=number, provider=PROVIDER,
                                        providerItemId=row["providerItemId"], title=row["title"],
                                        author=row["author"], publisher=row["publisher"], isbn13=row["isbn13"],
                                        publicationDate=row["publicationDate"], itemUrl=row["itemUrl"],
                                        data=row["data"], deleted=False,
                                        expectedRevision=revisions.get(number, 0)))
            if number in plan["newSlots"]:
                data_changed = True
                volume_id = str(uuid.uuid5(NAMESPACE, f"{work_id}:{number}:0:volume"))
                old = db.execute("SELECT entity_revision FROM collection_authority_volumes WHERE library_id=?"
                                 " AND volume_id=?", (library_id, volume_id)).fetchone()
                commands.append(command(ca.UPSERT_VOLUME, number, volumeId=volume_id, volumeNumber=number,
                                        editionIndex=0, sortOrder=number, displayLabel=None, coverArtworkId=None,
                                        sourceProvider=None, sourceCoverId=None, deleted=False,
                                        expectedRevision=old[0] if old else 0))
            for ident, change in events.get(number, []):
                commands.append({**command(ca.RECORD_RELEASE, ident), "eventId": ident, "provider": PROVIDER,
                                 "kind": change["kind"], "volumeNumber": number,
                                 "previousValue": change["previousValue"], "currentValue": change["currentValue"],
                                 "detectedAt": checked_at})
        stored_config = json.loads(binding["config"]) if binding["config"] else None
        if binding["external_id"] != plan["externalId"] or stored_config != plan["config"]:
            commands.append(command(ca.BIND, "bind", provider=PROVIDER, externalId=plan["externalId"],
                                    config=plan["config"], expectedRevision=binding["entity_revision"]))
        # Like the PC (``enqueue_provider_snapshot``), a snapshot is written only when the identity,
        # snapshot or values differ - or a source/slot changed, which re-derives availability and
        # schedule; an unchanged daily check writes nothing (no revision, no feed delta).
        snapshot_stale = (binding["snapshot_external_id"] != plan["externalId"]
                          or binding["external_id"] != plan["externalId"]
                          or (json.loads(binding["snapshot"]) if binding["snapshot"] else None) != plan["snapshot"]
                          or (json.loads(binding["snapshot_values"]) if binding["snapshot_values"] else None) != {})
        if snapshot_stale or data_changed:
            commands.append(command(ca.APPLY_SNAPSHOT, "snapshot", provider=PROVIDER, externalId=plan["externalId"],
                                    snapshot=plan["snapshot"], values={}, details=None,
                                    baseSnapshotDigest=binding["snapshot_digest"]))
        if not commands:
            return False
        ca.apply_command_batch(db, library_id=library_id, epoch=pre["epoch"], operation_id=pre["batch"],
                               request_payload=pre["payload"], commands=commands, now=checked_at)
        return any(events.values())


# --- routes -------------------------------------------------------------------------------

class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    provider: Literal["kakao"]
    workId: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")] | None = None


class RunLimiter:
    """At most ``RUN_PER_MINUTE`` runs a minute per client."""

    def __init__(self, clock=time.monotonic):
        self.clock, self.lock, self.windows = clock, threading.Lock(), {}

    def admit(self, principal):
        """Seconds to wait (0 = admitted and counted)."""
        with self.lock:
            now = self.clock()
            window = self.windows.setdefault(principal, deque())
            while window and now - window[0] >= 60:
                window.popleft()
            if len(window) >= RUN_PER_MINUTE:
                return max(1, int(60 - (now - window[0])) + 1)
            window.append(now)
            return 0


def register(app, get_db, require_client):
    """Install the worker (started only while enabled) and the routes; returns the worker.
    Tables come from ``startup_db`` (called by the Collections startup)."""
    worker = Worker(get_db)
    limiter = RunLimiter()
    app.state.release_check_worker = worker
    global _current
    _current = worker
    lifecycle(app).on_startup(worker.start)
    lifecycle(app).on_drain(worker.drain)
    lifecycle(app).on_shutdown(worker.stop)

    def guard(authorization):
        principal = str(require_client(authorization) or "client")
        if not enabled():
            fail(404, "releaseChecksUnavailable", "서버 신간 확인이 켜져 있지 않습니다.")
        return principal

    @app.get(PREFIX + "/status")
    def status(authorization: str | None = Header(default=None)):
        guard(authorization)
        return {"version": 1, "providers": {PROVIDER: worker.status_view()}}

    @app.post(PREFIX + "/run")
    async def run(request: Request, authorization: str | None = Header(default=None)):
        principal = guard(authorization)
        wait = limiter.admit(principal)
        if wait:
            fail(429, "releaseCheckRateLimited", "신간 확인을 너무 자주 요청했어요. 잠시 후 다시 시도해 주세요.",
                 headers={"Retry-After": str(wait)}, retryAfter=wait)
        body = await bindings._bounded(request, MAX_BODY_BYTES, "invalidReleaseCheckRequest",
                                       "신간 확인 요청이 너무 큽니다.")
        try:
            command = RunRequest.model_validate_json(body)
        except (ValidationError, ValueError):
            fail(422, "invalidReleaseCheckRequest", "신간 확인 요청을 확인할 수 없습니다.")
        return await run_in_threadpool(trigger, command)

    def trigger(command):
        with get_db() as db:
            if worker.library(db) is None:
                fail(409, authority.CODE_AUTHORITY_INACTIVE, "이 영역은 아직 서버 권위가 아닙니다.")
        if bindings.kakao_key() is None:
            fail(503, "kakaoSearchUnavailable", "서버에 카카오 검색이 설정되지 않았습니다.")
        queued, reason = (True, None) if command.workId is None else worker.request(command.workId)
        worker.wake()
        return {"version": 1, "provider": command.provider, "workId": command.workId, "queued": queued,
                "reason": reason, "status": worker.status_view()}

    return worker
