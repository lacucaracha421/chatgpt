"""MangaDex fetch and authority planning for the shared serial bind lane.

Imports are inert and stdlib-only. URLs are constructed from validated identities;
client display hints never reach the transport. Blob staging precedes authority I/O.
"""
import json
import os
import re
import time
import uuid

from kakao_bind_worker import Refused, selection_receipt

NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://lakomics.invalid/serverMangaDexBind")
MESSAGES = {
    "mangadexApplyUnavailable": "서버 연결을 준비 중입니다. 잠시 후 다시 시도해 주세요.",
    "collectionUnavailable": "연결할 만화 작품을 찾을 수 없습니다.",
    "bindingChanged": "연결 정보가 변경되었습니다. 다시 선택해 주세요.",
    "mangadexNotFound": "MangaDex에서 이 작품을 찾을 수 없습니다.",
    "invalidMangaDexIdentity": "선택한 MangaDex 작품 정보가 올바르지 않습니다. 다시 선택해 주세요.",
    "invalidMangaDexResponse": "MangaDex 응답을 처리하지 못했습니다. 잠시 후 다시 요청해 주세요.",
    "providerIdentityTaken": "다른 작품에 이미 연결된 검색 결과입니다. 다시 선택해 주세요.",
    "mangadexCoverInvalid": "일본판 표지 이미지가 올바르지 않습니다. 다시 선택해 주세요.",
    "mangadexResponseTooLarge": "작품 정보나 표지가 허용 크기를 초과했습니다.",
    "bindApplyFailed": "연결을 적용할 수 없습니다. 선택한 작품을 다시 확인해 주세요.",
    "operationConflict": "다른 내용으로 연결 요청을 재사용할 수 없습니다.",
}


def refuse(code):
    raise Refused(code, MESSAGES[code])


def canonical_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def parse_covers(envelope, manga_id, bindings):
    if not isinstance(envelope, dict) or envelope.get("result") != "ok" or not isinstance(envelope.get("data"), list):
        refuse("invalidMangaDexResponse")
    covers = []
    for raw in envelope["data"]:
        if not isinstance(raw, dict) or not isinstance(raw.get("relationships", []), list):
            refuse("invalidMangaDexResponse")
        if not any(isinstance(r, dict) and r.get("type") == "manga" and r.get("id") == manga_id
                   for r in raw.get("relationships", [])):
            continue
        attrs = raw.get("attributes")
        if (not isinstance(attrs, dict) or not canonical_uuid(raw.get("id"))
                or not bindings._valid_cover_identity(attrs.get("fileName"))
                or any(attrs.get(key) is not None and not isinstance(attrs[key], str) for key in ("volume", "locale"))):
            refuse("invalidMangaDexResponse")
        covers.append({"coverId": raw["id"], "fileName": attrs["fileName"],
                       "volume": attrs.get("volume"), "language": attrs.get("locale")})
    return covers


def representative(covers):
    japanese = [c for c in covers if c["language"] == "ja"]
    return next((c for c in japanese if c["volume"] == "1"), japanese[0] if japanese else None)


def volume_slot(value):
    # Rust i64 parsing accepts a leading plus, but not whitespace or Unicode digits.
    if not isinstance(value, str) or not re.fullmatch(r"\+?[0-9]+(?:\.[123])?", value):
        return None
    number, _, edition = value.partition(".")
    if len(number.lstrip("+0")) > 19:
        return None
    number = int(number)
    if not 0 < number <= (2**63 - 1) // 10:
        return None
    if number > 1_000_000:
        refuse("mangadexResponseTooLarge")
    return number, int(edition or 0)


class Provider:
    NAMESPACE = NAMESPACE

    def __init__(self, bindings, ca, get_db, storage, bucket, *, artwork=None, clock=time.monotonic):
        self.bindings, self.ca, self.get_db = bindings, ca, get_db
        self.storage, self.bucket, self.artwork, self.clock = storage, bucket, artwork, clock
        self.injected_artwork = artwork is not None

    def pipeline(self):
        if self.artwork is None:
            import work_providers
            self.artwork = work_providers
        return self.artwork

    def ready(self):
        if self.storage is None or self.bucket is None:
            return False
        # No client construction, HEAD or provider traffic for readiness.
        if self.injected_artwork:
            return self.artwork.mangadex_ready()
        if not all(os.environ.get(k, "").strip() for k in
                   ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")):
            return False
        return self.pipeline().mangadex_ready()

    def check(self, deadline, stop):
        if stop():
            raise self.bindings.SearchCancelled()
        if self.clock() >= deadline:
            raise self.bindings.Upstream("timeout")

    def admitted(self, callback, deadline, stop):
        self.check(deadline, stop)
        slot = self.bindings.gate.provider_locks["mangadex"]
        if not slot.acquire(timeout=min(self.bindings.PROVIDER_WAIT, max(0, deadline - self.clock()))):
            raise self.bindings.PageBudget(3)
        try:
            self.check(deadline, stop)
            self.bindings.gate.mangadex_spacing()
            self.check(deadline, stop)
            result = callback()
            self.check(deadline, stop)
            return result
        finally:
            slot.release()

    def json_request(self, url, params, deadline, stop):
        def read():
            return self.bindings.http_get(url, params, {}, 4 * 1024 * 1024,
                                          max(0.5, min(20, deadline - self.clock())), deadline)
        body = self.admitted(read, deadline, stop)
        if len(body) > 4 * 1024 * 1024:
            refuse("mangadexResponseTooLarge")
        try:
            result = json.loads(body, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError):
            refuse("invalidMangaDexResponse")
        return result

    def fetch(self, manga_id, *, stop):
        if not canonical_uuid(manga_id):
            refuse("invalidMangaDexIdentity")
        deadline = self.clock() + 90
        detail = self.json_request(f"https://api.mangadex.org/manga/{manga_id}",
                                  [("includes[]", k) for k in ("cover_art", "author", "artist")], deadline, stop)
        if not isinstance(detail, dict) or detail.get("result") != "ok" or not isinstance(detail.get("data"), dict):
            refuse("invalidMangaDexResponse")
        if detail["data"].get("id") != manga_id:
            refuse("invalidMangaDexIdentity")
        try:
            item = self.bindings.mangadex_item(detail["data"], detail=True)
        except (TypeError, AttributeError, ValueError):
            refuse("invalidMangaDexResponse")
        if item is None:
            refuse("invalidMangaDexResponse")
        covers_deadline = min(deadline, self.clock() + 60)
        records, total_seen = [], None
        for page in range(50):
            reply = self.json_request("https://api.mangadex.org/cover",
                [("manga[]", manga_id), ("limit", "100"), ("order[volume]", "asc"), ("offset", str(page * 100))],
                covers_deadline, stop)
            if (not isinstance(reply, dict) or reply.get("result") != "ok"
                    or not isinstance(reply.get("data"), list) or len(reply["data"]) > 100):
                refuse("invalidMangaDexResponse")
            total = reply.get("total")
            if total is not None and (type(total) is not int or total < 0 or total > 5000):
                refuse("invalidMangaDexResponse")
            if total_seen is not None and total != total_seen:
                refuse("invalidMangaDexResponse")
            total_seen = total
            if "offset" in reply and reply["offset"] != page * 100:
                refuse("invalidMangaDexResponse")
            if not reply["data"] and total is not None and len(records) < total:
                refuse("invalidMangaDexResponse")
            records.extend(reply["data"])
            envelope = {"result": "ok", "data": records}
            if len(self.ca.encode(envelope).encode("utf-8")) > 4 * 1024 * 1024:
                refuse("mangadexResponseTooLarge")
            if (total is not None and len(records) >= total) or (total is None and len(reply["data"]) < 100):
                break
        else:
            refuse("invalidMangaDexResponse")
        covers = parse_covers(envelope, manga_id, self.bindings)
        snapshot = {"detail": detail, "covers": envelope}
        if len(self.ca.encode(snapshot).encode("utf-8")) > self.ca.MAX_SNAPSHOT_BYTES:
            refuse("mangadexResponseTooLarge")
        picked = representative(covers)
        receipt = None
        if picked is not None:
            artwork = self.pipeline()
            image_deadline = min(deadline, self.clock() + 30)
            try:
                data, mime = self.admitted(lambda: artwork.mangadex_image(
                    manga_id, picked["fileName"], image_deadline), image_deadline, stop)
                self.check(deadline, stop)
                receipt = artwork.store_artwork_bytes(data, mime, image_deadline, self.get_db, self.storage, self.bucket,
                    provider="mangadex", provider_image_id=picked["coverId"], automatic=True, stop=stop,
                    strict_deadline=True)
                self.check(deadline, stop)
            except artwork.UpstreamStatus as error:
                if error.status == 404:
                    refuse("mangadexCoverInvalid")
                raise self.bindings.Upstream("status", error.status, error.retry_after) from None
        return {"mangaId": manga_id, "snapshot": snapshot, "covers": covers, "representative": picked,
                "artwork": receipt, "values": {k: item[k] for k in ("year", "author", "genres", "overview", "originalTitle")}}

    def untouched_selection(self, db, pre):
        domain, work_id = pre["domain"], pre["row"]["collection_id"]
        captured = json.loads(pre["row"]["binding_precondition"])
        if captured.get("selectionReceipt") != selection_receipt(db, domain, work_id):
            return False
        floor = db.execute("SELECT pruned_through FROM collection_authority_retention WHERE library_id=? AND epoch=?",
                           (domain["libraryId"], domain["epoch"])).fetchone()
        if floor and floor[0] > captured["cursor"]:
            return False
        changes = db.execute("SELECT sequence,command_type,entity_key FROM collection_authority_changes"
                             " WHERE library_id=? AND epoch=? AND sequence>? ORDER BY sequence",
                             (domain["libraryId"], domain["epoch"], captured["cursor"])).fetchall()
        if [r["sequence"] for r in changes] != list(range(captured["cursor"] + 1, domain["cursor"] + 1)):
            return False
        return not any(r["command_type"] == self.ca.SELECT_ARTWORK and r["entity_key"] == work_id for r in changes)

    def apply(self, db, pre, fetched, now):
        ca = self.ca
        library, epoch, work_id = pre["domain"]["libraryId"], pre["domain"]["epoch"], pre["row"]["collection_id"]
        def command(command_type, key, **fields):
            return {"libraryId": library, "epoch": epoch, "contractVersion": ca.CONTRACT_VERSION,
                    "operationId": str(uuid.uuid5(uuid.UUID(pre["batch"]), f"{command_type}:{key}")),
                    "commandType": command_type, "workId": work_id, **fields}
        binding = pre["binding"]
        bound = binding is not None and binding["bound"]
        commands = []
        if not bound or binding["external_id"] != fetched["mangaId"] or binding["config"] is not None:
            commands.append(command(ca.BIND, "bind", provider="mangadex", externalId=fetched["mangaId"], config=None,
                                    expectedRevision=binding["entity_revision"] if bound else 0))
        commands.append(command(ca.APPLY_SNAPSHOT, "snapshot", provider="mangadex", externalId=fetched["mangaId"],
            snapshot=fetched["snapshot"], values=fetched["values"], details=None,
            baseSnapshotDigest=binding["snapshot_digest"] if bound else None))
        picked, artwork_id = fetched["representative"], None
        if picked is not None:
            receipt = fetched["artwork"]
            if receipt is None or not receipt.get("original"):
                refuse("mangadexCoverInvalid")
            old = db.execute("SELECT * FROM collection_authority_artworks WHERE library_id=? AND work_id=?"
                             " AND provider='mangadex' AND provider_image_id=? ORDER BY artwork_id",
                             (library, work_id, picked["coverId"])).fetchone()
            artwork_id = old["artwork_id"] if old else str(uuid.uuid5(NAMESPACE, f"{work_id}:mangadex:{picked['coverId']}"))
            if old is None:
                commands.append(command(ca.ADD_ARTWORK, artwork_id, artworkId=artwork_id, kind="cover", provider="mangadex",
                    providerImageId=picked["coverId"], language="ja",
                    **{k: receipt[k] for k in ("original", "thumbnail", "width", "height")}))
            state = ca.work_state(pre["work"])
            if (not state["selection"].get("work") and not state["fields"].get("coverAssetId")
                    and self.untouched_selection(db, pre)):
                commands.append(command(ca.SELECT_ARTWORK, "work", slot="work", artworkId=artwork_id, expectedArtworkId=None))
        rows = db.execute("SELECT * FROM collection_authority_volumes WHERE library_id=? AND work_id=?",
                          (library, work_id)).fetchall()
        slots = {}
        for cover in fetched["covers"]:
            if cover["language"] == "ja" and (slot := volume_slot(cover["volume"])) is not None:
                slots.setdefault(slot, cover)
        live_count = sum(not r["deleted"] for r in rows)
        for (number, edition), cover in sorted(slots.items()):
            matches = [r for r in rows if (r["volume_number"], r["edition_index"]) == (number, edition)]
            live = [r for r in matches if not r["deleted"]]
            if len(live) > 1 or (not live and len(matches) > 1):
                refuse("bindApplyFailed")
            old = live[0] if live else matches[0] if matches else None
            if old is not None and old["source_provider"] not in (None, "mangadex"):
                continue
            ident = old["volume_id"] if old else str(uuid.uuid5(NAMESPACE, f"{work_id}:{number}:{edition}:volume"))
            if old is None and db.execute("SELECT 1 FROM collection_authority_volumes WHERE library_id=? AND volume_id=?",
                                          (library, ident)).fetchone():
                refuse("bindApplyFailed")
            if old is None or old["deleted"]:
                live_count += 1
                if live_count > ca.MAX_VOLUMES_PER_WORK:
                    refuse("mangadexResponseTooLarge")
            cover_id = old["cover_artwork_id"] if old else None
            if cover_id is None and picked is not None and cover["coverId"] == picked["coverId"]:
                cover_id = artwork_id
            fields = dict(volumeId=ident, volumeNumber=number, editionIndex=edition,
                sortOrder=old["sort_order"] if old else number * 10 + edition,
                displayLabel=old["display_label"] if old else None,
                coverArtworkId=cover_id, sourceProvider="mangadex", sourceCoverId=cover["coverId"], deleted=False,
                expectedRevision=old["entity_revision"] if old else 0)
            if old and not old["deleted"] and (old["cover_artwork_id"], old["source_provider"], old["source_cover_id"]) == (
                    cover_id, "mangadex", cover["coverId"]):
                continue
            commands.append(command(ca.UPSERT_VOLUME, ident, **fields))
        # No release event commands: snapshot + monotonic authority slots are the quiet baseline.
        ca.apply_command_batch(db, library_id=library, epoch=epoch, operation_id=pre["batch"],
                               request_payload=pre["payload"], commands=commands, now=now)

    def classify(self, error, planner):
        if isinstance(error, Refused):
            return Refused(error.code if error.code in MESSAGES else "bindApplyFailed",
                           MESSAGES.get(error.code, MESSAGES["bindApplyFailed"]))
        if isinstance(error, self.bindings.Upstream):
            if getattr(error, "too_large", False):
                return Refused("mangadexResponseTooLarge", MESSAGES["mangadexResponseTooLarge"])
            if error.kind == "invalid":
                return Refused("invalidMangaDexResponse", MESSAGES["invalidMangaDexResponse"])
            if error.status == 404:
                return Refused("mangadexNotFound", MESSAGES["mangadexNotFound"])
            if planner.classify(error).work_error or error.status in (301, 302, 303, 307, 308):
                return Refused("invalidMangaDexResponse", MESSAGES["invalidMangaDexResponse"])
            return error
        detail = getattr(error, "detail", None)
        if isinstance(detail, dict):
            code = detail.get("code")
            if code in ("providerTimeout", "providerUnavailable", "providerArtworkStorageUnavailable", "providerImageDecoderUnavailable"):
                return planner.RefreshError(planner.UNAVAILABLE, "bindDeferred", "connection")
            mapping = {"providerImageInvalid": "mangadexCoverInvalid", "providerArtworkMismatch": "mangadexCoverInvalid",
                       "providerResponseTooLarge": "mangadexResponseTooLarge", "revisionConflict": "bindingChanged"}
            code = mapping.get(code, code if code in MESSAGES else "bindApplyFailed")
            return Refused(code, MESSAGES[code])
        return error
