"""Shared mechanics of the batch command routes (Album membership, classification assignment).

A batch is a transport convenience, not a new unit of consistency: every command in it is
applied by the domain's own ``apply_command`` with its own receipt, change row and
compare-and-set, exactly as the single-command route would. What the batch adds is one
request, one ``BEGIN IMMEDIATE`` and one commit around up to ``MAX_COMMANDS`` of them, with
a SAVEPOINT per command so one refused command (stale revision, tombstoned asset, missing
album) is reported on its own entry and the rest still apply.

Idempotent retry needs no batch receipt: replaying the same commands returns each command's
stored receipt result. A malformed batch is rejected whole before any write, so a caller
never has to guess which of its commands were looked at.
"""
import json

from fastapi import HTTPException

MAX_COMMANDS = 100
MAX_BODY_BYTES = 64 * 1024

ENVELOPE_KEYS = {"libraryId", "epoch", "contractVersion", "batchId", "commands"}
#: Carried once by the batch envelope; a command that repeats them is ambiguous.
SHARED_KEYS = ("libraryId", "epoch", "contractVersion")


async def read_body(request, fail, invalid_code):
    """The decoded JSON body, or 413 as soon as it is known to exceed the batch limit."""
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_BODY_BYTES:
            fail(413)
        data.extend(chunk)
    try:
        return json.loads(data)
    except (ValueError, UnicodeError):
        fail(422, invalid_code, "일괄 명령을 읽을 수 없습니다.")


def parse_batch(body, *, parse_command, allowed_types, uuid_pattern, fail, invalid_code):
    """Validate the envelope and every command; return ``(identity, parsed)``.

    ``parse_command`` is the domain's own single-command parser, fed a full single-command
    body built from the envelope plus each entry, so a batch entry is validated exactly like
    a single command. Nothing is written until the whole batch parsed.
    """
    if not isinstance(body, dict) or set(body) != ENVELOPE_KEYS:
        fail(422, invalid_code, "일괄 명령 봉투가 올바르지 않습니다.")
    batch_id = body["batchId"]
    if not isinstance(batch_id, str) or not uuid_pattern.fullmatch(batch_id):
        fail(422, invalid_code, "일괄 작업 ID가 올바르지 않습니다.")
    commands = body["commands"]
    if not isinstance(commands, list) or not 1 <= len(commands) <= MAX_COMMANDS:
        fail(422, invalid_code, f"일괄 명령은 1개 이상 {MAX_COMMANDS}개 이하여야 합니다.")
    parsed, seen = [], set()
    for command in commands:
        if not isinstance(command, dict) or any(key in command for key in SHARED_KEYS):
            fail(422, invalid_code, "일괄 명령 항목이 올바르지 않습니다.")
        entry = parse_command({**command, **{key: body[key] for key in SHARED_KEYS}})
        if entry[4] not in allowed_types:
            fail(422, "unsupportedBatchCommand", "일괄 명령이 지원하지 않는 명령입니다.")
        if entry[3] in seen:
            fail(422, invalid_code, "일괄 명령에 같은 작업 ID가 두 번 들어 있습니다.")
        seen.add(entry[3])
        parsed.append(entry)
    identity = {"libraryId": body["libraryId"], "epoch": body["epoch"],
                "contractVersion": body["contractVersion"], "batchId": batch_id}
    return identity, parsed


def error_entry(operation_id, exc):
    """One refused command as a result entry; ``current`` carries the winning state."""
    detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
    error = {**detail, "status": exc.status_code}
    error.setdefault("code", "error")
    status = "conflict" if error["code"] == "revisionConflict" else "rejected"
    return {"operationId": operation_id, "status": status, "changed": False,
            "changeSequence": None, "error": error}


def apply_each(db, parsed, *, apply_one, summarize, now):
    """Apply every parsed command inside the caller's transaction, one SAVEPOINT each.

    An ``HTTPException`` rolls back only that command; any other exception is a server fault
    and propagates so the caller rolls the whole batch back.
    """
    results = []
    for library_id, epoch, contract_version, operation_id, command_type, entity in parsed:
        db.execute("SAVEPOINT batch_command")
        try:
            result = apply_one(
                db, library_id=library_id, epoch=epoch, contract_version=contract_version,
                command_type=command_type, operation_id=operation_id, entity=entity, now=now)
        except HTTPException as exc:
            db.execute("ROLLBACK TO SAVEPOINT batch_command")
            db.execute("RELEASE SAVEPOINT batch_command")
            results.append(error_entry(operation_id, exc))
        else:
            db.execute("RELEASE SAVEPOINT batch_command")
            results.append({"operationId": operation_id,
                            "status": "applied" if result["changed"] else "noop",
                            "changed": result["changed"],
                            "changeSequence": result["changeSequence"],
                            **summarize(result)})
    return results
