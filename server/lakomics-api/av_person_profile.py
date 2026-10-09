"""Additive person profile storage and strict manual-field validation."""
import math

import av_contract

PROFILE_FIELDS = {"birthDate", "heightCm", "bandIn", "waistIn", "hipIn", "cup",
                  "breastType", "careerStart", "careerEnd", "urls"}
NAME_FIELDS = {"displayName", "nameJa"}
FIELDS = PROFILE_FIELDS | NAME_FIELDS
RESET = {"reset": True}


def source(payload):
    # Absence, unlike explicit null, denotes a pre-overrides person.
    return payload.get("stashdbProfile", payload.get("profile"))


def merged(payload):
    base = source(payload)
    overrides = payload.get("profileOverrides", {})
    fields = {k: v for k, v in overrides.items() if k in PROFILE_FIELDS}
    if base is None and not fields:
        return None
    result = dict(base) if base is not None else {
        "source": "stashdb", "name": None, "aliases": [],
        **dict.fromkeys(PROFILE_FIELDS - {"urls"}), "urls": []}
    result.update(fields)
    # Existing readers require an array even for an explicitly cleared links field.
    if result.get("urls") is None:
        result["urls"] = []
    return result


def names(payload):
    base = payload["profileBaseNames"]
    overrides = payload.get("profileOverrides", {})
    return (overrides.get("displayName", base["displayName"]) or "",
            overrides.get("nameJa", base.get("nameJa")))


def metadata(payload):
    return {"stashdbProfile": source(payload), "profileOverrides": payload.get("profileOverrides", {})}


def validate(field, value):
    # Import locally: StashDB imports the authority dispatcher during registration.
    from av_stashdb import number, safe_url, valid_date
    from collection_authority import fail
    if field not in FIELDS:
        fail()
    if value is None:
        return None
    if field in NAME_FIELDS or field == "cup":
        limit = av_contract.MAX_PERSON_NAME if field in NAME_FIELDS else 20
        if not isinstance(value, str) or len(value) > limit:
            fail()
        return value.strip() or None
    if field == "birthDate":
        if valid_date(value) is None:
            fail()
    elif field in {"heightCm", "bandIn", "waistIn", "hipIn", "careerStart", "careerEnd"}:
        low, high = ((1900, 2200) if field.startswith("career") else
                     (1, 300) if field == "heightCm" else (1, 200))
        if number(value, low, high) is None:
            fail()
    elif field == "breastType":
        if not isinstance(value, str) or value not in ("NATURAL", "FAKE", "NA"):
            fail()
    elif field == "urls":
        if not isinstance(value, list) or len(value) > 100:
            fail()
        for link in value:
            if (not isinstance(link, dict) or set(link) != {"site", "url"}
                    or not isinstance(link["site"], str) or len(link["site"]) > 200
                    or not safe_url(link["url"])):
                fail()
    return value


def parse(changes, expected):
    from collection_authority import fail
    if (not isinstance(changes, dict) or not changes or not set(changes) <= FIELDS
            or not isinstance(expected, dict) or set(changes) != set(expected)):
        fail()
    parsed = {}
    for key, value in changes.items():
        if isinstance(value, dict):
            if set(value) != {"reset"} or value["reset"] is not True:
                fail()
            parsed[key] = RESET.copy()
        else:
            parsed[key] = validate(key, value)
    for key, state in expected.items():
        if (not isinstance(state, dict) or set(state) != {"value", "overridden"}
                or type(state["overridden"]) is not bool):
            fail()
        # Accept legacy value ranges without normalization, but retain strict types
        # (Python otherwise considers True equal to the numeric value 1).
        value = state["value"]
        if value is None:
            continue
        if key in NAME_FIELDS | {"cup", "birthDate", "breastType"}:
            if not isinstance(value, str) or len(value) > av_contract.MAX_PERSON_NAME:
                fail()
        elif key == "urls":
            if (not isinstance(value, list) or len(value) > 100
                    or any(not isinstance(u, dict) or set(u) != {"site", "url"}
                           or not isinstance(u["site"], str) or len(u["site"]) > 200
                           or not isinstance(u["url"], str) or len(u["url"]) > 2000 for u in value)):
                fail()
        elif type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
            fail()
    return parsed, expected
