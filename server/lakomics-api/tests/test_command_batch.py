"""The shared envelope rules of the batch command routes (Album membership, classification
assignment), tested once on ``command_batch.parse_batch`` instead of once per route.

Route-specific rejections (a command shape, an unbatchable command type) stay in the route
tests: test_album_batch_commands.py and test_classification_batch.py.
"""
import re
import sys
import unittest
import uuid
from pathlib import Path

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import command_batch

UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
ALLOWED = {"setThing"}


def fail(status=422, code="invalid", message="", **extra):
    raise HTTPException(status_code=status, detail={"code": code})


def parse_command(body):
    return (body["libraryId"], body["epoch"], body["contractVersion"], body["operationId"],
            body["commandType"], None)


def command(operation_id=None, **changes):
    return {"operationId": operation_id or str(uuid.uuid4()), "commandType": "setThing", **changes}


def envelope(listed, **changes):
    return {"libraryId": "lib", "epoch": 1, "contractVersion": 1, "batchId": str(uuid.uuid4()),
            "commands": listed, **changes}


def parse(body):
    return command_batch.parse_batch(body, parse_command=parse_command, allowed_types=ALLOWED,
                                     uuid_pattern=UUID_PATTERN, fail=fail, invalid_code="invalidBatch")


class ParseBatchTests(unittest.TestCase):
    def test_a_valid_batch_returns_its_identity_and_every_command(self):
        first, second = command(), command()
        identity, parsed = parse(envelope([first, second]))
        self.assertEqual(identity["libraryId"], "lib")
        self.assertEqual([entry[3] for entry in parsed], [first["operationId"], second["operationId"]])

    def test_exactly_the_command_limit_is_accepted(self):
        _, parsed = parse(envelope([command() for _ in range(command_batch.MAX_COMMANDS)]))
        self.assertEqual(len(parsed), command_batch.MAX_COMMANDS)

    def test_a_malformed_envelope_or_command_list_is_refused_whole(self):
        valid = command()
        shared = command(libraryId="lib")
        duplicate = command(valid["operationId"])
        cases = {
            "empty": envelope([]),
            "not an object": envelope([valid, "x"]),
            "scope in command": envelope([valid, shared]),
            "duplicate operation": envelope([valid, duplicate]),
            "over the limit": envelope([command() for _ in range(command_batch.MAX_COMMANDS + 1)]),
            "bad batch id": envelope([valid], batchId="not-a-uuid"),
            "commands not a list": envelope([valid], commands="nope"),
            "unknown envelope key": envelope([valid], surprise=True),
            "body not an object": [valid],
        }
        for name, body in cases.items():
            with self.assertRaises(HTTPException, msg=name) as caught:
                parse(body)
            self.assertEqual(caught.exception.status_code, 422, name)

    def test_a_command_type_the_route_does_not_batch_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            parse(envelope([command(commandType="deleteThing")]))
        self.assertEqual(caught.exception.detail["code"], "unsupportedBatchCommand")


if __name__ == "__main__":
    unittest.main()
