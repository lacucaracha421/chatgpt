"""Connection review read projection shared by replica and authority readers."""
import re


def snapshot_volumes(snapshot):
    groups = snapshot.get("groups") if isinstance(snapshot, dict) else None
    groups = groups if isinstance(groups, list) else [snapshot]
    return sorted({volume["volumeNumber"] for group in groups if isinstance(group, dict)
                   for volume in (group.get("volumes") if isinstance(group.get("volumes"), list) else []) if isinstance(volume, dict)
                   and type(volume.get("volumeNumber")) is int and volume["volumeNumber"] > 0})


def dismissal_matches(config, volumes):
    value = config.get("reviewDismissedVolumes")
    return isinstance(value, list) and all(type(n) is int for n in value) and value == volumes


def review(work_id, name, bindings, highest_owned, owned_count, volume_range):
    kakao = bindings.get("kakao")
    config = (kakao or {}).get("config") or {}
    config = config if isinstance(config, dict) else {}
    snapshot = (bindings.get("mangadex") or {}).get("snapshot") or {}
    titles = snapshot
    for key in ("detail", "data", "attributes", "altTitles"):
        titles = titles.get(key) if isinstance(titles, dict) else None
    titles = titles if isinstance(titles, list) else []
    korean = next((t["ko"].strip() for t in titles if isinstance(t, dict)
                   and isinstance(t.get("ko"), str) and t["ko"].strip()), None)
    source = "name" if re.search(r"[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]", name) else "mangadex" if korean else "none"
    query = name if source != "mangadex" else korean
    volumes = snapshot_volumes((kakao or {}).get("snapshot"))
    groups = config.get("groups")
    groups = groups if isinstance(groups, list) else [{"groupFingerprint": config.get("groupFingerprint")}]
    partial = len(volumes) < max([highest_owned, *volumes])
    stored_query = config.get("query")
    query = stored_query if isinstance(stored_query, str) and stored_query.strip() else query
    return {"collectionId": work_id, "query": query[:2000], "dismissalSupported": True,
            "querySource": source, "bound": kakao is not None, "volumes": volumes,
            "highestOwnedVolume": highest_owned, "ownedCount": owned_count,
            "partialDismissed": kakao is not None and partial and dismissal_matches(config, volumes),
            "groupFingerprints": [g["groupFingerprint"] for g in groups if isinstance(g, dict) and isinstance(g.get("groupFingerprint"), str)],
            "minVolume": volume_range.get("minVolume"), "maxVolume": volume_range.get("maxVolume"),
            "hideConnectionPrompt": volume_range.get("hideConnectionPrompt", False)}


def validated_review(*args):
    """Optional review data must never reject a work projection or replica."""
    from mobile_collections import KakaoReview
    from pydantic import ValidationError
    try:
        return KakaoReview.model_validate(review(*args)).model_dump()
    except (ValidationError, TypeError, ValueError, AttributeError, KeyError):
        return None
