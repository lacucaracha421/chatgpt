"""Shadow-only character candidate groups (CHAR-AUTO-003 phase A).

Chinese Whispers over the S36 CCIP crop features groups person crops that look
like one character. The main output is "expand known" suggestions: a pure cluster
of a known character whose crops are mostly unlabeled suggests adding those assets
to that character. Clusters with no known character are only counted and listed
by id ("new candidates"). The command writes a JSON report and an HTML preview
into a cache directory; the library database is opened read-only and no
character, decision, reference or classification is changed.

Graph: symmetric top-k neighbours, keeping edges whose CCIP distance
0.5*(1-cos) is at most the s36-knn3-v1 automatic threshold (read from
s36_policy.json; the threshold the 2026-09-26 trial used). An expand-known group
must be compact (median intra distance <= known_max_median_distance, which drops
style clusters chained through one confirmed crop), and each suggested asset must
be within the s36-knn3-v1 recommendation threshold of the target's confirmed crops.

Labels follow the trial: confirmed = latest accepted manual/unknown decision or
a character reference; automatic acceptances stay separate. A label is assigned
to a crop only for single-crop images or via a reference region matching one crop.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import html
import json
import os
from pathlib import Path
import re
import time
import zipfile

import numpy as np

from character_augmentation import S36_NAMESPACE
from holdout_dataset import open_readonly
from holdout_rules import is_hash
from s36_scoring import distance, knn, unit

HERE = Path(__file__).resolve().parent
SCHEMA = "lakomics-character-candidate-groups-v1"
POLICY = {
    "version": "cw-candidates-v1",
    "neighbours": 10,
    "iterations": 30,
    "seed": 0,
    "edge_policy_version": "s36-knn3-v1",
    "min_assets": 5,
    "min_unlabeled_share": 0.6,
    "known_min_share": 0.8,
    "new_max_median_distance": 0.13,
    "new_min_source_posts": 3,
    "known_max_median_distance": 0.16,
}
OUTPUT_NAMESPACE = "candidate-groups"


# --------------------------------------------------------------------------- graph

def policy_thresholds(policy):
    """(edge, suggestion) = s36-knn3-v1 automatic and recommendation thresholds,
    from the current or previous entry of s36_policy.json."""
    wanted = POLICY["edge_policy_version"]
    for entry in (policy, policy.get("revision", {}).get("previous", {})):
        if entry.get("version") == wanted:
            edge, suggest = float(entry["automatic_max_knn3"]), float(entry["recommendation_max_knn3"])
            if not 0 < edge <= suggest < 0.5:
                raise ValueError("Policy thresholds out of range")
            return edge, suggest
    raise ValueError(f"{wanted} thresholds not found in s36_policy.json")


def knn_graph(vectors, k, tau, block=2048):
    """Symmetric top-k graph over normalized rows: {(i, j): weight}, i < j.

    An edge exists when j is among i's k nearest (or vice versa) and the
    distance is <= tau. Weight is 1 - distance.
    """
    n = len(vectors)
    edges = {}
    k = min(k, n - 1)
    if k <= 0:
        return edges
    for start in range(0, n, block):
        stop = min(n, start + block)
        d = distance(vectors[start:stop], vectors)
        rows = np.arange(start, stop)
        d[rows - start, rows] = np.inf
        nearest = np.argpartition(d, k - 1, axis=1)[:, :k]
        for r, i in enumerate(rows):
            for j in nearest[r]:
                value = float(d[r, j])
                if value <= tau:
                    key = (int(i), int(j)) if i < j else (int(j), int(i))
                    edges[key] = 1.0 - value
    return edges


def chinese_whispers(n, edges, iterations=30, seed=0):
    """Deterministic Chinese Whispers. Returns cluster ids; singletons are -1.

    Fixed seed for the visiting order; ties go to the smallest label. Cluster ids
    are numbered by first appearance in index order, so equal input gives equal output.
    """
    neighbours = [[] for _ in range(n)]
    for (i, j), weight in sorted(edges.items()):
        neighbours[i].append((j, weight))
        neighbours[j].append((i, weight))
    labels = list(range(n))
    rng = np.random.default_rng(seed)
    for _ in range(iterations):
        changed = 0
        for i in rng.permutation(n):
            if not neighbours[i]:
                continue
            score = {}
            for j, weight in neighbours[i]:
                score[labels[j]] = score.get(labels[j], 0.0) + weight
            best = min(score, key=lambda label: (-score[label], label))
            if best != labels[i]:
                labels[i] = best
                changed += 1
        if not changed:
            break
    sizes = Counter(labels)
    ids, out = {}, []
    for label in labels:
        out.append(-1 if sizes[label] < 2 else ids.setdefault(label, len(ids)))
    return np.asarray(out, dtype=np.int64)


# ---------------------------------------------------------------- classification

def classify(statuses, labels, assets, posts, median_distance, policy=POLICY):
    """Classify one cluster. Returns (kind, reason, known_target_or_None).

    statuses: per crop 'confirmed' | 'auto' | 'ambiguous' | 'unlabeled';
    labels: per crop target id for confirmed crops ('' otherwise).
    """
    if len(set(assets)) < policy["min_assets"]:
        return "ignored", "too_few_assets", None
    counts = Counter(statuses)
    if counts["unlabeled"] / len(statuses) < policy["min_unlabeled_share"]:
        return "ignored", "mostly_labeled", None
    known = Counter(label for status, label in zip(statuses, labels) if status == "confirmed" and label)
    if known:
        target, n = min(known.items(), key=lambda item: (-item[1], item[0]))
        if n / sum(known.values()) < policy["known_min_share"]:
            return "ignored", "mixed_known", None
        if median_distance > policy["known_max_median_distance"]:
            return "ignored", "loose_known", None
        return "expand_known", "pure_known_mostly_unlabeled", target
    if counts["confirmed"] or counts["auto"]:
        return "ignored", "has_confirmed_or_auto", None
    if len(set(posts)) < policy["new_min_source_posts"]:
        return "ignored", "few_source_posts", None
    if median_distance > policy["new_max_median_distance"]:
        return "ignored", "loose", None
    return "new_candidate", "tight_multi_post_unlabeled", None


def median_intra(vectors):
    if len(vectors) < 2:
        return 0.0
    d = distance(vectors, vectors)
    return float(np.median(d[np.triu_indices(len(vectors), 1)]))


def source_post(url, batch, asset_id):
    """One source post per X status / page; photos of one post share it."""
    if url:
        url = re.sub(r"[?#].*$", "", url)
        return re.sub(r"/photo/\d+/?$", "", url)
    return batch or asset_id


# ---------------------------------------------------------------------- inputs

def load_features(root):
    """All non-fallback S36 crops in a feature directory, sorted by hash."""
    from character_encoder import load_feature
    hashes, crops, boxes, vectors, skipped = [], [], [], [], 0
    for path in sorted(Path(root).glob("*.npz")):
        h = path.stem
        if not is_hash(h) or path.is_symlink():
            skipped += 1
            continue
        try:
            feature = load_feature(path, h)
        except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile):
            skipped += 1
            continue
        if feature.fallback:
            continue
        for index, box in enumerate(feature.boxes):
            hashes.append(h)
            crops.append(index)
            boxes.append(tuple(int(v) for v in box))
            vectors.append(feature.vectors[index])
    if not vectors:
        raise ValueError("No S36 crop features found")
    return hashes, crops, boxes, unit(np.stack(vectors)), skipped


def iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def load_library(connection):
    """Read-only metadata: assets, labels, rejections, references, targets, series."""
    q = lambda sql: connection.execute(sql).fetchall()
    assets = {}
    for aid, h, w, hgt, thumb, url, batch, pdq in q(
            "SELECT id, content_hash, width, height, thumbnail_relative_path, source_url,"
            " import_batch_id, hex(perceptual_hash) FROM assets"
            " WHERE status != 'trash' AND trashed_at IS NULL ORDER BY id"):
        assets.setdefault(h, {"id": aid, "size": [w, hgt], "thumbnail": thumb,
                              "post": source_post(url, batch, aid), "pdq": pdq})
    latest = q("""SELECT target_id, asset_id, decision, origin FROM character_decisions c
        WHERE asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM character_decisions n
        WHERE n.target_id = c.target_id AND n.source_asset_id = c.source_asset_id AND n.sequence > c.sequence)""")
    confirmed, auto, rejected = defaultdict(set), defaultdict(set), defaultdict(set)
    for target, aid, decision, origin in latest:
        if decision == "accepted":
            (auto if origin == "automatic" else confirmed)[aid].add(target)
        elif decision == "rejected":
            rejected[aid].add(target)
    references = defaultdict(list)
    for target, aid in q("SELECT target_id, asset_id FROM character_references"
                         " WHERE asset_id IS NOT NULL ORDER BY target_id, slot"):
        confirmed[aid].add(target)
        references[target].append(aid)
    regions = {(t, a): json.loads(b) for t, a, b in q(
        "SELECT target_id, asset_id, bounds_json FROM character_reference_regions")}
    names = dict(q("SELECT id, name FROM classification_entries"))
    parent = dict(q("SELECT id, parent_id FROM classification_entries"))
    series_ids = {row[0] for row in q("SELECT classification_id FROM character_series")}

    def series_of(entry):
        for _ in range(64):
            if entry is None:
                return None
            if entry in series_ids:
                return entry
            entry = parent.get(entry)
        return None

    asset_series = defaultdict(set)
    for aid, entry in q("SELECT asset_id, classification_id FROM asset_classifications"):
        s = series_of(entry)
        if s:
            asset_series[aid].add(s)
    targets = {tid: {"name": name, "series": series} for tid, name, series in q(
        "SELECT id, display_name, series_classification_id FROM character_targets")}
    return {"assets": assets, "confirmed": confirmed, "auto": auto, "rejected": rejected,
            "references": references, "regions": regions, "series_names": names,
            "asset_series": asset_series, "targets": targets}


def crop_labels(hashes, boxes, lib):
    """Per-crop status/label/asset/series, following the trial rules."""
    n = len(hashes)
    status, label, asset, series = ["unlabeled"] * n, [""] * n, [""] * n, [""] * n
    by_hash = defaultdict(list)
    for i, h in enumerate(hashes):
        by_hash[h].append(i)
    for h, idxs in by_hash.items():
        row = lib["assets"].get(h)
        if row is None:
            for i in idxs:
                status[i] = "no_asset"
            continue
        aid = row["id"]
        conf = lib["confirmed"].get(aid, set())
        au = lib["auto"].get(aid, set()) - conf
        s = sorted(lib["asset_series"].get(aid, ()))
        for i in idxs:
            asset[i], series[i] = aid, s[0] if s else ""
        if conf:
            for i in idxs:
                status[i] = "ambiguous"
            if len(idxs) == 1 and len(conf) == 1:
                status[idxs[0]], label[idxs[0]] = "confirmed", next(iter(conf))
            else:
                for target in sorted(conf):
                    region = lib["regions"].get((target, aid))
                    if region is None:
                        continue
                    best = max(idxs, key=lambda i: iou(boxes[i], region))
                    if iou(boxes[best], region) > 0.3:
                        status[best], label[best] = "confirmed", target
        elif au:
            for i in idxs:
                status[i] = "auto"
            if len(idxs) == 1 and len(au) == 1:
                label[idxs[0]] = next(iter(au))
    return status, label, asset, series


# ---------------------------------------------------------------------- report

def group_id(members, hashes, crops):
    key = "\n".join(sorted(f"{hashes[i]}:{crops[i]}" for i in members))
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def build_report(hashes, crops, boxes, vectors, lib, *, edge_max, suggest_max, feature_id,
                 policy=POLICY, clock=time.perf_counter):
    started = clock()
    status, label, asset, series = crop_labels(hashes, boxes, lib)
    edges = knn_graph(vectors, policy["neighbours"], edge_max)
    clusters = chinese_whispers(len(hashes), edges, policy["iterations"], policy["seed"])
    graph_seconds = clock() - started
    members = defaultdict(list)
    for i, c in enumerate(clusters):
        if c >= 0:
            members[int(c)].append(i)
    asset_rows = {row["id"]: row for row in lib["assets"].values()}
    targets = lib["targets"]
    gallery_idx = defaultdict(list)
    for i, (s, t) in enumerate(zip(status, label)):
        if s == "confirmed" and t:
            gallery_idx[t].append(i)

    def thumb(aid):
        row = asset_rows.get(aid)
        return {"thumbnail": row["thumbnail"], "image_size": row["size"]} if row else {"thumbnail": None, "image_size": None}

    expand, new, ignored = [], [], Counter()
    purity_num = purity_den = 0
    recovered = set()
    for cid in sorted(members):
        m = [i for i in members[cid] if status[i] != "no_asset"]
        if len(m) < 2:
            ignored["no_asset"] += 1
            continue
        known = Counter(label[i] for i in m if status[i] == "confirmed")
        if known:
            top, n = min(known.items(), key=lambda item: (-item[1], item[0]))
            purity_num += n
            purity_den += sum(known.values())
            if sum(known.values()) >= 2 and n / sum(known.values()) >= policy["known_min_share"]:
                recovered.add(top)
        ids = [asset[i] for i in m]
        posts = [asset_rows[a]["post"] for a in ids]
        med = median_intra(vectors[m])
        kind, reason, target = classify([status[i] for i in m], [label[i] for i in m], ids, posts, med, policy)
        if kind == "ignored":
            ignored[reason] += 1
            continue
        if kind == "new_candidate":
            new.append({"id": group_id(m, hashes, crops), "asset_ids": sorted(set(ids))})
            continue
        unlabeled = defaultdict(list)
        for i in m:
            if status[i] == "unlabeled":
                unlabeled[asset[i]].append(i)
        excluded = sorted(a for a in unlabeled if target in lib["rejected"].get(a, ()))
        gallery = vectors[gallery_idx[target]]
        suggestions, far = [], 0
        for aid in sorted(set(unlabeled) - set(excluded)):
            idx = sorted(unlabeled[aid], key=lambda i: crops[i])
            score = float(knn(vectors[idx], gallery).min())
            if score > suggest_max:
                far += 1
                continue
            suggestions.append({"asset_id": aid, **thumb(aid),
                                "crops": [{"index": crops[i], "box": list(boxes[i])} for i in idx],
                                "knn3_to_confirmed": round(score, 4)})
        if not suggestions:
            ignored["no_close_suggestion"] += 1
            continue
        suggestions.sort(key=lambda s: (s["knn3_to_confirmed"], s["asset_id"]))
        info = targets.get(target, {})
        refs = []
        for aid in lib["references"].get(target, []):
            region = lib["regions"].get((target, aid))
            refs.append({"asset_id": aid, **thumb(aid), "box": list(region) if region else None})
        expand.append({
            "id": group_id(m, hashes, crops),
            "target": {"id": target, "name": info.get("name"), "series_id": info.get("series"),
                       "series": lib["series_names"].get(info.get("series"))},
            "purity": round(known[target] / sum(known.values()), 3),
            "confirmed_crops_in_group": known[target],
            "crops": len(m),
            "assets": len(set(ids)),
            "source_posts": len(set(posts)),
            "median_intra_distance": round(med, 4),
            "status_counts": dict(sorted(Counter(status[i] for i in m).items())),
            "references": refs,
            "suggestions": suggestions,
            "excluded_rejected_asset_ids": excluded,
            "excluded_far_assets": far,
        })
    expand.sort(key=lambda g: (-len(g["suggestions"]), g["id"]))
    new.sort(key=lambda g: g["id"])
    return {
        "schema": SCHEMA,
        "policy": {**policy, "edge_max_distance": edge_max, "suggestion_max_knn3": suggest_max,
                   "feature_id": feature_id,
                   "distance": "0.5*(1-cos) of L2-normalized S36 CCIP crop features",
                   "suggestion_distance": "knn3_to_confirmed = min over the asset's grouped crops of the mean distance "
                                          "to the 3 nearest confirmed crops (references + manual acceptances) of the target; "
                                          "assets above suggestion_max_knn3 are dropped"},
        "shadow_only": "Suggestions only; nothing in the library was changed.",
        "label_rule": ("confirmed = latest accepted manual/unknown decision or a character reference; "
                       "auto = automatic acceptance only; labels only for single-crop images or matched reference regions"),
        "summary": {
            "crops": len(hashes),
            "images": len(set(hashes)),
            "edges": len(edges),
            "clusters": len(members),
            "clustered_crops": int((clusters >= 0).sum()),
            "status_counts": dict(sorted(Counter(status).items())),
            "known_characters_recovered": [len(recovered), len(gallery_idx)],
            "purity_confirmed": round(purity_num / purity_den, 4) if purity_den else None,
            "expand_known_groups": len(expand),
            "expand_known_targets": len({g["target"]["id"] for g in expand}),
            "expand_known_suggested_assets": sum(len(g["suggestions"]) for g in expand),
            "expand_known_unlabeled_crops": sum(g["status_counts"].get("unlabeled", 0) for g in expand),
            "new_candidate_groups": len(new),
            "ignored_clusters": dict(sorted(ignored.items())),
            "graph_and_clustering_seconds": round(graph_seconds, 2),
        },
        "expand_known": expand,
        "new_candidates": new,
    }


# ---------------------------------------------------------------------- output

def guard(path, stop):
    """Refuse symlinks from `stop` down to `path` (like s36_library_cache)."""
    path, stop = Path(path), Path(stop)
    for p in [path, *path.parents]:
        if p.is_symlink():
            raise ValueError("Output path must not contain symlinks")
        if p == stop:
            break


def write_atomic(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.{os.getpid()}.part")
    temp.write_text(text, encoding="utf-8")
    os.replace(temp, path)


def crop_style(size, box):
    """CSS background crop of a thumbnail using a box in original pixels."""
    w, h = size
    x0, y0, x1, y1 = box if box else (0, 0, w, h)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    bw, bh = max(1, x1 - x0), max(1, y1 - y0)
    px = x0 / (w - bw) * 100 if w > bw else 0
    py = y0 / (h - bh) * 100 if h > bh else 0
    return (f"background-size:{w / bw * 100:.2f}% {h / bh * 100:.2f}%;"
            f"background-position:{px:.2f}% {py:.2f}%;aspect-ratio:{bw / bh:.3f}")


def tile(library, item, box, caption, cls):
    if not item.get("thumbnail") or not item.get("image_size") or not all(item["image_size"]):
        return f'<div class="c missing" title="{html.escape(item["asset_id"])}">?</div>'
    uri = html.escape((library / item["thumbnail"]).as_uri(), quote=True)
    return (f'<figure class="{cls}"><div class="c" title="{html.escape(item["asset_id"])}" '
            f'style="background-image:url(\'{uri}\');{crop_style(item["image_size"], box)}"></div>'
            f'<figcaption>{html.escape(caption)}</figcaption></figure>')


def render_html(report, library, max_refs=8, max_suggestions=40):
    library = Path(library).resolve()
    s = report["summary"]
    parts = [f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Character suggestions</title>
<style>
:root{{--bg:#fafafa;--fg:#1d1d1f;--muted:#6e6e73;--card:#fff;--line:#e3e3e8;--ref:#2356c4}}
@media (prefers-color-scheme:dark){{:root{{--bg:#151517;--fg:#ececf0;--muted:#9a9aa2;--card:#1f1f23;--line:#33333a;--ref:#7ea2ff}}}}
body{{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}}
h1{{font-size:20px;margin:0 0 4px}} .muted{{color:var(--muted)}}
.g{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0}}
.g h2{{font-size:15px;margin:0 0 4px}} .row{{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:flex-start}}
.label{{width:100%;font-size:12px;color:var(--muted)}}
figure{{margin:0}} figcaption{{font-size:11px;color:var(--muted);text-align:center}}
.c{{height:130px;background-repeat:no-repeat;border-radius:6px;border:2px solid transparent}}
.ref .c{{border-color:var(--ref)}} .missing{{width:60px;display:grid;place-items:center;border:1px dashed var(--line)}}
</style></head><body>
<h1>Add to known characters</h1>
<p class="muted">Shadow-only {html.escape(report['policy']['version'])} · edge ≤ {report['policy']['edge_max_distance']:.4f} ·
suggest ≤ {report['policy']['suggestion_max_knn3']:.4f} ·
{s['expand_known_groups']} groups · {s['expand_known_suggested_assets']} suggested images ·
{s['new_candidate_groups']} unnamed groups (ids in report.json only). Blue = reference; number = distance to confirmed images.</p>"""]
    for g in report["expand_known"]:
        t = g["target"]
        parts.append(f"""<section class="g"><h2>{html.escape(t['name'] or t['id'])} · {html.escape(t['series'] or 'no series')}
 — add {len(g['suggestions'])}</h2><div class="muted">{g['id']} · purity {g['purity']:.0%} ·
{g['confirmed_crops_in_group']} confirmed in group · {g['source_posts']} posts · median {g['median_intra_distance']:.3f}
{f" · {len(g['excluded_rejected_asset_ids'])} excluded (rejected)" if g['excluded_rejected_asset_ids'] else ''}</div>
<div class="row"><span class="label">References</span>""")
        for ref in g["references"][:max_refs]:
            parts.append(tile(library, ref, ref.get("box"), "ref", "ref"))
        parts.append('</div><div class="row"><span class="label">Suggested</span>')
        for item in g["suggestions"][:max_suggestions]:
            parts.append(tile(library, item, item["crops"][0]["box"], f"{item['knn3_to_confirmed']:.3f}", "sug"))
        if len(g["suggestions"]) > max_suggestions:
            parts.append(f'<span class="muted">+{len(g["suggestions"]) - max_suggestions}</span>')
        parts.append("</div></section>")
    parts.append("</body></html>")
    return "\n".join(parts)


# ------------------------------------------------------------------------- CLI

def default_output(library):
    return Path(library) / ".cache/characters" / OUTPUT_NAMESPACE / POLICY["version"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="Cluster S36 features and write report.json + preview.html")
    build.add_argument("--library", type=Path, required=True)
    build.add_argument("--database", type=Path, required=True, help="library.sqlite or a backup copy (opened read-only)")
    build.add_argument("--output-dir", type=Path, help="Default: <library>/.cache/characters/candidate-groups/<version>")
    build.add_argument("--no-html", action="store_true")
    preview = sub.add_parser("preview", help="Regenerate preview.html from an existing report.json")
    preview.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "preview":
            report = json.loads(args.report.read_text(encoding="utf-8"))
            if report.get("schema") != SCHEMA:
                raise ValueError("Unsupported report schema")
            guard(args.report.parent, args.report.parent)
            write_atomic(args.report.parent / "preview.html", render_html(report, report["library_root"]))
            print(args.report.parent / "preview.html")
            return
        from character_augmentation import feature_identity
        started = time.perf_counter()
        library = args.library.resolve(strict=True)
        output = (args.output_dir or default_output(library)).absolute()
        guard(output, library if library in output.parents else output.anchor)
        policy_file = json.loads((HERE / "s36_policy.json").read_text(encoding="utf-8"))
        edge_max, suggest_max = policy_thresholds(policy_file)
        fid = feature_identity()
        if policy_file["feature_id"] != fid:
            raise ValueError("s36_policy.json feature_id differs from the current S36 contract")
        feature_root = library / ".cache/characters" / S36_NAMESPACE / fid
        guard(feature_root, library)
        hashes, crops, boxes, vectors, skipped = load_features(feature_root)
        with open_readonly(args.database) as connection:
            lib = load_library(connection)
        report = build_report(hashes, crops, boxes, vectors, lib, edge_max=edge_max,
                              suggest_max=suggest_max, feature_id=fid)
        report["library_root"] = str(library)
        report["summary"]["skipped_feature_files"] = skipped
        report["summary"]["total_seconds"] = round(time.perf_counter() - started, 2)
        report["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_atomic(output / "report.json", json.dumps(report, ensure_ascii=False, indent=1, allow_nan=False))
        if not args.no_html:
            write_atomic(output / "preview.html", render_html(report, library))
        print(json.dumps({"output": str(output), **report["summary"]}, ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f"Candidate groups failed: {error}\n")


if __name__ == "__main__":
    main()
