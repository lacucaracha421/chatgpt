"""Provider numbering and local visibility for manga parts (no I/O)."""
from copy import deepcopy


def provider_number(number, bounds):
    low, high = bounds.get("minVolume"), bounds.get("maxVolume")
    if (low is not None and number < low) or (high is not None and number > high):
        return None
    return number - (low if low is not None else 1) + 1 if bounds.get("restartNumbering", False) else number


def local_contains(number, bounds):
    if bounds.get("restartNumbering", False):
        low, high = bounds.get("minVolume"), bounds.get("maxVolume")
        return number >= 1 and (high is None or number <= high - (low if low is not None else 1) + 1)
    return provider_number(number, bounds) is not None


def scope_picks(picked, bounds):
    """Scope provider products while keeping group history and choosing a part anchor."""
    result = []
    for original in picked:
        pick = deepcopy(original)
        items = pick["series"]["items"]
        pick["known"] = sorted(set(pick["known"]) | {item["itemId"] for item in items})
        inside = [item for item in items if provider_number(max(item["volumeNumber"], 1), bounds) is not None]
        if not inside:
            continue
        if bounds.get("minVolume") is not None or bounds.get("maxVolume") is not None:
            pick["anchor"] = min(inside, key=lambda item: max(item["volumeNumber"], 1))["itemId"]
        if bounds.get("minVolume") is None and bounds.get("maxVolume") is None and not bounds.get("restartNumbering", False):
            result.append(pick)
            continue
        for item in inside:
            item["volumeNumber"] = provider_number(max(item["volumeNumber"], 1), bounds)
        pick["series"]["items"] = inside
        candidate = pick["series"]["candidate"]
        candidate["volumes"] = [dict(volume, volumeNumber=provider_number(volume["volumeNumber"], bounds))
                                for volume in candidate["volumes"]
                                if provider_number(volume["volumeNumber"], bounds) is not None]
        result.append(pick)
    return result
