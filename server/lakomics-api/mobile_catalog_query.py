"""PC grouped catalog semantics, over immutable, allowlisted replica tables.

The shared fixture is also executed by Rust's actual grouped API. Keep changes
aligned with library/catalog_query.rs and catalog_group_query.rs.
"""
from __future__ import annotations

import time
from urllib.parse import urlsplit


class QueryError(ValueError):
    def __init__(self, start, end, message="Invalid catalog query"):
        super().__init__(message)
        self.span = {"start": start, "end": end}


def parse_query(source):
    data = source.encode("utf-8")
    if len(data) > 4096:
        raise QueryError(4096, len(data))
    tokens, i = [], 0
    def span(n):
        return len(source[:n].encode("utf-8"))
    while i < len(source):
        if source[i].isspace():
            i += 1
            continue
        start, c = i, source[i]
        if c == '"':
            i += 1
            value = ""
            while i < len(source) and source[i] != '"':
                if source[i] == "\\":
                    i += 1
                    if i >= len(source) or source[i] not in ('"', "\\"):
                        raise QueryError(span(start), span(min(i + 1, len(source))))
                value += source[i]
                i += 1
            if i == len(source) or not value:
                raise QueryError(span(start), span(i))
            i += 1
            kind = "value"
        elif c in "():-<>":
            i += 1
            value = c
            if c in "<>" and i < len(source) and source[i] == "=":
                value += "="
                i += 1
            kind = value
        elif c == "=":
            raise QueryError(span(i), span(i + 1))
        else:
            while i < len(source) and not source[i].isspace() and source[i] not in '():"<=>':
                i += 1
            value = source[start:i]
            kind = value.upper() if value.upper() in ("AND", "OR", "NOT") else "word"
        tokens.append((kind, value, span(start), span(i)))
    if len(tokens) > 256:
        raise QueryError(0, len(data))
    if not tokens:
        return None
    cursor = 0
    def peek():
        return tokens[cursor][0] if cursor < len(tokens) else "end"
    def take():
        nonlocal cursor
        if cursor == len(tokens):
            raise QueryError(len(data), len(data))
        result = tokens[cursor]
        cursor += 1
        return result
    def value():
        token = take()
        if token[0] not in ("word", "value"):
            raise QueryError(token[2], token[3])
        return token
    def number(token, zero=False):
        import re
        text = token[1]
        if not re.fullmatch(r"\+?[0-9]+", text):
            raise QueryError(token[2], token[3])
        n = int(text)
        if n < (0 if zero else 1) or n > 9223372036854775807:
            raise QueryError(token[2], token[3])
        return n
    def primary():
        token = take()
        kind, text = token[:2]
        if kind == "(":
            result = expression()
            closing = take()
            if closing[0] != ")":
                raise QueryError(closing[2], closing[3])
            return result
        if kind == "value":
            return ("title", text)
        if kind != "word":
            raise QueryError(token[2], token[3])
        if peek() in (">", ">=", "<", "<="):
            op = take()[0]
            if text.lower() != "pages":
                raise QueryError(token[2], token[3])
            return ("pages", op, number(value(), True))
        if peek() != ":":
            return ("title", text)
        take()
        v = value()
        field = text.lower()
        if field == "id":
            return ("id", number(v))
        if field == "pages":
            return ("pages", "=", number(v, True))
        if field == "uploader":
            return ("uploader", v[1])
        if field == "category":
            aliases = ["doujinshi|동인지", "manga|만화", "artistcg|아티스트cg", "gamecg|게임cg", "western|서양", "imageset|이미지세트", "nonh|비성인", "cosplay|코스프레", "asianporn|아시아포르노", "misc|기타", "private|비공개"]
            compact = "".join(c for c in v[1].lower() if not c.isspace() and c not in "-_")
            try:
                category = int(v[1])
            except ValueError:
                category = next((n for n, names in enumerate(aliases, 1) if compact in names.split("|")), 0)
            if not 1 <= category <= 11:
                raise QueryError(v[2], v[3])
            return ("category", category)
        return ("tag", field, v[1])
    def unary():
        if peek() in ("NOT", "-"):
            take()
            return ("not", unary())
        return primary()
    def conjunction():
        result = unary()
        while peek() == "AND" or peek() in ("word", "value", "(", "NOT", "-"):
            if peek() == "AND":
                take()
            result = ("and", result, unary())
        return result
    def expression():
        result = conjunction()
        while peek() == "OR":
            take()
            result = ("or", result, conjunction())
        return result
    result = expression()
    if cursor != len(tokens):
        raise QueryError(tokens[cursor][2], tokens[cursor][3])
    return result


def compile_query(expr):
    params = []
    def walk(e):
        kind = e[0]
        if kind == "title":
            pattern = "%" + e[1].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            params.extend((pattern, pattern))
            return "(work.Title LIKE ? ESCAPE '\\' OR COALESCE(work.TitleJpn,'') LIKE ? ESCAPE '\\')"
        if kind == "tag":
            params.extend(e[1:])
            return "EXISTS(SELECT 1 FROM catalog.Tags t WHERE t.WorkId=work.Id AND t.Namespace=? AND t.Value=?)"
        if kind in ("id", "category", "uploader"):
            params.append(e[1])
            return {"id": "work.Id=?", "category": "COALESCE(work.Category,-1)=?", "uploader": "COALESCE(work.Uploader,'')=? COLLATE NOCASE"}[kind]
        if kind == "pages":
            params.append(e[2])
            return "work.FileCount " + e[1] + " ?"
        if kind == "not":
            return "NOT (" + walk(e[1]) + ")"
        return "(" + walk(e[1]) + (" AND " if kind == "and" else " OR ") + walk(e[2]) + ")"
    return (walk(expr), params) if expr else ("1", [])


def eligible(query, state="state"):
    if query.get("preparedState"):
        clauses, params = [], []
        if query["language"] != "all":
            clauses.append(f"{state}.{query['language']}=1")
        if not query["revealBlocked"]:
            clauses.append(f"{state}.visible=1")
        return " AND ".join(clauses) or "1", params
    clauses, params = ["likely(work.Expunged=0)" if query["sort"] == "latest" else "work.Expunged=0"], []
    if query["language"] != "all":
        clauses.append("EXISTS(SELECT 1 FROM catalog.Tags t WHERE t.WorkId=work.Id AND t.Namespace='language' AND t.Value=?)")
        params.append(query["language"])
    if not query["revealBlocked"]:
        if query.get("hasHidden", True):
            clauses.append("NOT EXISTS(SELECT 1 FROM online_catalog_hidden_categories h WHERE h.category=work.Category)")
        if query.get("hasBlocked", True):
            clauses.append("NOT EXISTS(SELECT 1 FROM catalog.Tags t JOIN online_catalog_blocked_tags b ON b.namespace=t.Namespace AND b.value=t.Value WHERE t.WorkId=work.Id)")
    return " AND ".join(clauses), params


def freeze_query(db, query):
    query = dict(query)
    query["hasHidden"], query["hasBlocked"] = map(bool, db.execute("SELECT EXISTS(SELECT 1 FROM online_catalog_hidden_categories),EXISTS(SELECT 1 FROM online_catalog_blocked_tags)").fetchone())
    query["preparedState"] = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mobile_catalog_work_state'").fetchone())
    seconds = {"hotDay": 86400, "hotWeek": 604800, "hotMonth": 2592000}.get(query["sort"])
    if seconds and "hotCutoff" not in query:
        where, params = eligible(query)
        source = "catalog.Works work"
        if query["preparedState"]:
            source += " JOIN mobile_catalog_work_state state ON state.work_id=work.Id"
        latest = db.execute("SELECT work.Posted FROM " + source + " WHERE " + where + " ORDER BY work.Posted DESC LIMIT 1", params).fetchone()
        now = int(time.time())
        query["hotCutoff"] = min(latest[0] if latest and latest[0] is not None else now, now) - seconds
    return query


def cte(query):
    where, params = eligible(query)
    sql, values = compile_query(parse_query(query["text"]))
    params.extend(values)
    if query["scope"] == "bookmarked":
        sql += " AND " + ("work._bookmarked=1" if query.get("preparedState") else "EXISTS(SELECT 1 FROM online_catalog_bookmarks b WHERE b.provider='kHentai' AND b.work_id=CAST(work.Id AS TEXT))")
    if "hotCutoff" in query:
        sql += " AND work.Posted>=?"
        params.append(query["hotCutoff"])
    if query.get("preparedState"):
        eligible_source = "SELECT work.*,state.group_id AS _group_id,state.bookmarked AS _bookmarked FROM catalog.Works work JOIN mobile_catalog_work_state state ON state.work_id=work.Id WHERE " + where
    else:
        eligible_source = "SELECT work.* FROM catalog.Works work WHERE " + where
    return f"WITH eligible AS NOT MATERIALIZED ({eligible_source}), matching AS MATERIALIZED (SELECT work.* FROM eligible work WHERE {sql})", params


def count_groups(db, query):
    prefix, params = cte(query)
    if query.get("preparedState"):
        return db.execute(prefix + " SELECT COUNT(DISTINCT work._group_id) FROM matching work", params).fetchone()[0]
    return db.execute(prefix + " SELECT COUNT(DISTINCT m.group_id) FROM matching work JOIN online_catalog_group_members m ON m.provider='kHentai' AND m.catalog_work_id=work.Id", params).fetchone()[0]


def search_groups(db, query, offset=0, limit=40):
    prefix, params = cte(query)
    latest = query["sort"] == "latest"
    rank_order = "donor.Posted IS NOT NULL DESC,COALESCE(donor.Posted,0) DESC,donor.Id DESC"
    final_order = "Posted DESC,Id DESC"
    if not latest:
        rank_order = "donor.Views DESC," + rank_order
        final_order = "Views DESC,Posted DESC,Id DESC"
    if query.get("preparedState"):
        ranked = f""", ranked AS (
          SELECT donor._group_id AS group_id,donor.Posted,donor.Id,donor.Views,
                 ROW_NUMBER() OVER(PARTITION BY donor._group_id ORDER BY {rank_order}) AS rn
          FROM matching donor
        ) SELECT group_id FROM ranked WHERE rn=1 ORDER BY {final_order} LIMIT ? OFFSET ?"""
    else:
        ranked = f""", ranked AS (
          SELECT member.group_id,donor.Posted,donor.Id,donor.Views,
                 ROW_NUMBER() OVER(PARTITION BY member.group_id ORDER BY {rank_order}) AS rn
          FROM matching donor JOIN online_catalog_group_members member
            ON member.provider='kHentai' AND member.catalog_work_id=donor.Id
        ) SELECT group_id FROM ranked WHERE rn=1 ORDER BY {final_order} LIMIT ? OFFSET ?"""
    groups = [r[0] for r in db.execute(prefix + ranked, [*params, limit, offset])]
    if not groups:
        return []
    requested = ",".join("(?)" for _ in groups)
    sql = prefix + f""", requested(group_id) AS (VALUES {requested})
      SELECT requested.group_id,
       (SELECT work.Id FROM online_catalog_group_members member CROSS JOIN matching work ON work.Id=member.catalog_work_id
        WHERE member.provider='kHentai' AND member.group_id=requested.group_id
        ORDER BY (CAST(work.Id AS TEXT)=COALESCE((SELECT preference.selected_work_id FROM online_catalog_group_preferences preference
          JOIN online_catalog_group_members anchor ON anchor.provider=preference.provider AND anchor.work_id=preference.anchor_work_id
          WHERE anchor.provider=member.provider AND anchor.group_id=member.group_id ORDER BY preference.edit_revision DESC LIMIT 1),'')) DESC,
          EXISTS(SELECT 1 FROM catalog.Tags language WHERE language.WorkId=work.Id AND language.Namespace='language' AND language.Value='korean') DESC,
          member.thumbnail_valid DESC,member.completeness DESC,member.lineage_terminal DESC,work.Id DESC LIMIT 1),
       (SELECT COUNT(*) FROM online_catalog_group_members m JOIN eligible work ON work.Id=m.catalog_work_id WHERE m.provider='kHentai' AND m.group_id=requested.group_id),
       EXISTS(SELECT 1 FROM online_catalog_group_members m JOIN eligible work ON work.Id=m.catalog_work_id
         JOIN online_catalog_bookmarks b ON b.provider=m.provider AND b.work_id=m.work_id WHERE m.provider='kHentai' AND m.group_id=requested.group_id)
      FROM requested"""
    selected = list(db.execute(sql, [*params, *groups]))
    works = summaries(db, [r[1] for r in selected])
    return [dict(works[r[1]], groupId=r[0], versionCount=r[2], hasBookmarkedVersion=bool(r[3])) for r in selected]

def thumbnail(raw):
    try:
        u = urlsplit(raw or "")
        return raw if u.scheme == "https" and not u.username and not u.password and u.hostname and (u.hostname == "ehgt.org" or u.hostname.endswith(".ehgt.org")) else None
    except ValueError:
        return None


def timestamp(value):
    if value is None:
        return None
    while abs(value) >= 100_000_000_000:
        value = (abs(value) // 1000) * (-1 if value < 0 else 1)
    return value


def summaries(db, ids):
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    rows = db.execute(f"SELECT work.*,EXISTS(SELECT 1 FROM online_catalog_bookmarks b WHERE b.provider='kHentai' AND b.work_id=CAST(work.Id AS TEXT)) AS bookmarked FROM catalog.Works work WHERE work.Id IN ({placeholders})", ids)
    result = {r["Id"]: dict(provider="kHentai", providerWorkId=str(r["Id"]), title=r["Title"], titleJpn=r["TitleJpn"], thumbnailUrl=thumbnail(r["Thumb"]), bookmarked=bool(r["bookmarked"]), fileCount=r["FileCount"], views=r["Views"], posted=timestamp(r["Posted"] or 0), artists=[], series=[]) for r in rows}
    for row in db.execute(f"SELECT WorkId,Namespace,Value FROM catalog.Tags WHERE WorkId IN ({placeholders}) AND Namespace IN ('artist','parody') ORDER BY WorkId,Namespace,Value", ids):
        result[row[0]]["artists" if row[1] == "artist" else "series"].append(row[2])
    return result


def detail(db, work_id, query):
    where, params = eligible(query)
    source = "catalog.Works work"
    if query.get("preparedState"):
        source += " JOIN mobile_catalog_work_state state ON state.work_id=work.Id"
    row = db.execute("SELECT work.* FROM " + source + " WHERE work.Id=? AND " + where, [work_id, *params]).fetchone()
    if row is None:
        return None
    result = summaries(db, [work_id])[work_id]
    result.pop("artists"); result.pop("series")
    result.update(uploader=row["Uploader"], category=row["Category"], posted=timestamp(row["Posted"]), updated=timestamp(row["Updated"]), fileSize=row["FileSize"], rating=row["Rating"])
    groups = {}
    for tag in db.execute("SELECT t.Namespace,t.Value,tr.label FROM catalog.Tags t LEFT JOIN catalog.Translations tr ON tr.namespace=t.Namespace AND tr.value=t.Value WHERE t.WorkId=? ORDER BY t.Namespace,t.Value", [work_id]):
        group = groups.setdefault(tag[0], {"namespace": tag[0], "values": [], "labels": {}})
        group["values"].append(tag[1])
        if tag[2]:
            group["labels"][tag[1]] = tag[2]
    result["tagGroups"] = list(groups.values())
    return result


def editions(db, handle, query, offset, limit):
    row = db.execute("SELECT m.group_id FROM online_catalog_group_handles h JOIN online_catalog_group_members m ON m.provider=h.provider AND m.work_id=h.anchor_work_id WHERE h.provider='kHentai' AND h.group_id=?", [handle]).fetchone()
    if row is None:
        return None
    group = row[0]
    where, params = eligible(query)
    source = "FROM online_catalog_group_members m JOIN catalog.Works work ON work.Id=m.catalog_work_id"
    if query.get("preparedState"):
        source += " JOIN mobile_catalog_work_state state ON state.work_id=work.Id"
    source += " WHERE m.provider='kHentai' AND m.group_id=? AND " + where
    total = db.execute("SELECT COUNT(*) " + source, [group, *params]).fetchone()[0]
    selected = db.execute("SELECT p.selected_work_id FROM online_catalog_group_preferences p JOIN online_catalog_group_members a ON a.provider=p.provider AND a.work_id=p.anchor_work_id WHERE a.provider='kHentai' AND a.group_id=? ORDER BY p.edit_revision DESC LIMIT 1", [group]).fetchone()
    selected = selected[0] if selected else None
    if selected and not db.execute("SELECT EXISTS(SELECT 1 " + source + " AND m.work_id=?)", [group, *params, selected]).fetchone()[0]:
        selected = None
    ids = [r[0] for r in db.execute("SELECT work.Id " + source + " ORDER BY work.Posted DESC,work.Id DESC LIMIT ? OFFSET ?", [group, *params, limit, offset])]
    hydrated = summaries(db, ids)
    return {"groupId": group, "selectedProviderWorkId": selected, "items": [hydrated[i] for i in ids], "totalCount": total}
