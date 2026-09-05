use rusqlite::{params_from_iter, types::Value, Connection};

use super::{
    catalog_query::{compile, parse},
    catalog_visibility::append_visibility_predicates,
    error::LibraryError,
    models::{CatalogScope, CatalogSearchQuery, CatalogSort},
};

pub(super) struct GroupSelection {
    pub group_id: String,
    pub representative_id: i64,
    pub version_count: u64,
    pub has_bookmarked_version: bool,
}

struct Filter {
    cte: String,
    values: Vec<Value>,
}

fn filter(
    connection: &Connection,
    query: &CatalogSearchQuery,
    access: &str,
    now: i64,
) -> Result<Filter, LibraryError> {
    let mut clauses = vec![super::online_catalog::active_work_predicate(query.sort).to_owned()];
    let mut values = Vec::new();
    if let Some(language) = query.language {
        clauses.push("EXISTS(SELECT 1 FROM catalog.Tags tag WHERE tag.WorkId=work.Id AND tag.Namespace='language' AND tag.Value=?)".into());
        values.push(language.as_tag().to_owned().into());
    }
    if !query.reveal_blocked {
        append_visibility_predicates(connection, &mut clauses)?;
    }
    let eligible = clauses.join(" AND ");
    let mut matching = Vec::new();
    if query.scope == CatalogScope::Bookmarked {
        matching.push("EXISTS(SELECT 1 FROM online_catalog_bookmarks b WHERE b.provider='kHentai' AND b.work_id=CAST(work.Id AS TEXT))".to_owned());
    }
    if let Some(expression) = parse(&query.text)? {
        let compiled = compile(&expression);
        matching.push(compiled.sql);
        values.extend(compiled.params);
    }
    let seconds = match query.sort {
        CatalogSort::HotDay => Some(86_400),
        CatalogSort::HotWeek => Some(604_800),
        CatalogSort::HotMonth => Some(2_592_000),
        _ => None,
    };
    if let Some(seconds) = seconds {
        // Keep the existing latest-posted/clamped clock convention, but an
        // ineligible future sibling must not set the visible group's window.
        matching.push(format!(
            "work.Posted >= (SELECT MIN(COALESCE(MAX(Posted),?),?) - {seconds} FROM eligible)"
        ));
        values.extend([Value::Integer(now), Value::Integer(now)]);
    }
    let matching = if matching.is_empty() {
        "1".into()
    } else {
        matching.join(" AND ")
    };
    Ok(Filter {
        cte: format!("WITH eligible AS NOT MATERIALIZED (SELECT work.* FROM catalog.Works work {access} WHERE {eligible}), matching AS NOT MATERIALIZED (SELECT work.* FROM eligible work WHERE {matching})"),
        values,
    })
}

pub(super) fn select_groups(
    connection: &Connection,
    query: &CatalogSearchQuery,
) -> Result<(Vec<GroupSelection>, u64), LibraryError> {
    let now = chrono::Utc::now().timestamp();
    let Filter {
        cte: count_cte,
        values,
    } = filter(connection, query, "NOT INDEXED", now)?;
    // CROSS JOIN prevents the DISTINCT optimization from driving random Works
    // lookups in opaque group-ID order. Matching still applies to ONE work.
    let count_sql = format!(
        "{count_cte} SELECT COUNT(DISTINCT member.group_id)
        FROM matching work CROSS JOIN online_catalog_group_members member
        ON member.provider='kHentai' AND member.catalog_work_id=work.Id"
    );
    #[cfg(test)]
    let started = std::time::Instant::now();
    let total: i64 =
        connection.query_row(&count_sql, params_from_iter(values.iter()), |r| r.get(0))?;
    #[cfg(test)]
    report_measurement(connection, "count", &count_sql, &values, started.elapsed());
    let Filter { cte, .. } = filter(connection, query, "", now)?;
    let (order, better) = match query.sort {
        CatalogSort::Latest => (
            "donor.Posted DESC,donor.Id DESC",
            "(work.Posted IS NOT NULL,COALESCE(work.Posted,0),work.Id)>(donor.Posted IS NOT NULL,COALESCE(donor.Posted,0),donor.Id)",
        ),
        _ => (
            "donor.Views DESC,donor.Posted DESC,donor.Id DESC",
            "(work.Views,work.Posted IS NOT NULL,COALESCE(work.Posted,0),work.Id)>(donor.Views,donor.Posted IS NOT NULL,COALESCE(donor.Posted,0),donor.Id)",
        ),
    };
    let posted_index: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM catalog.sqlite_master WHERE type='index' AND name='IdxWorksPosted')", [], |r| r.get(0))?;
    let source = if query.sort == CatalogSort::Latest && posted_index {
        "catalog.Works ordered INDEXED BY IdxWorksPosted CROSS JOIN matching donor ON donor.Id=ordered.Id"
    } else {
        "matching donor"
    };
    let order = if query.sort == CatalogSort::Latest && posted_index {
        "ordered.Posted DESC,ordered.Id DESC"
    } else {
        order
    };
    let sql = format!("{cte} SELECT member.group_id,donor.Title FROM {source}
        CROSS JOIN online_catalog_group_members member ON member.provider='kHentai' AND member.catalog_work_id=donor.Id
        WHERE NOT EXISTS(SELECT 1 FROM online_catalog_group_members sibling CROSS JOIN matching work ON work.Id=sibling.catalog_work_id
          WHERE sibling.provider=member.provider AND sibling.group_id=member.group_id AND {better})
        ORDER BY {order} LIMIT ? OFFSET ?");
    let mut page_values = values.clone();
    page_values.push(i64::from(query.page_size.clamp(1, 100)).into());
    page_values.push(
        (u64::from(query.page) * u64::from(query.page_size.clamp(1, 100)))
            .min(i64::MAX as u64)
            .try_into()
            .map(Value::Integer)
            .unwrap(),
    );
    #[cfg(test)]
    let started = std::time::Instant::now();
    let ids = connection
        .prepare(&sql)?
        .query_map(params_from_iter(page_values.iter()), |r| {
            r.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    #[cfg(test)]
    report_measurement(connection, "page", &sql, &page_values, started.elapsed());
    if ids.is_empty() {
        return Ok((Vec::new(), total as u64));
    }
    // One bounded statement selects all representatives and visible counts.
    // No per-card statement, no raw-page folding, no metadata from ineligible rows.
    let mut rep_values = values;
    let placeholders = ids
        .iter()
        .map(|id| {
            rep_values.push(id.clone().into());
            "(?)"
        })
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("{cte}, requested(group_id) AS (VALUES {placeholders})
        SELECT requested.group_id,
          (SELECT work.Id FROM online_catalog_group_members member INDEXED BY online_catalog_group_members_reverse CROSS JOIN matching work ON work.Id=member.catalog_work_id
           WHERE member.provider='kHentai' AND member.group_id=requested.group_id
           ORDER BY (CAST(work.Id AS TEXT)=COALESCE((SELECT preference.selected_work_id
             FROM online_catalog_group_preferences preference JOIN online_catalog_group_members anchor
             ON anchor.provider=preference.provider AND anchor.work_id=preference.anchor_work_id
             WHERE anchor.provider=member.provider AND anchor.group_id=member.group_id
             ORDER BY preference.edit_revision DESC LIMIT 1),'')) DESC,
             EXISTS(SELECT 1 FROM catalog.Tags language WHERE language.WorkId=work.Id AND language.Namespace='language' AND language.Value='korean') DESC,
             member.thumbnail_valid DESC,member.completeness DESC,member.lineage_terminal DESC,work.Id DESC LIMIT 1),
          (SELECT COUNT(*) FROM online_catalog_group_members member JOIN eligible work ON work.Id=member.catalog_work_id
           WHERE member.provider='kHentai' AND member.group_id=requested.group_id),
          EXISTS(SELECT 1 FROM online_catalog_group_members member JOIN eligible work ON work.Id=member.catalog_work_id
           JOIN online_catalog_bookmarks bookmark ON bookmark.provider=member.provider AND bookmark.work_id=member.work_id
           WHERE member.provider='kHentai' AND member.group_id=requested.group_id)
        FROM requested");
    #[cfg(test)]
    let started = std::time::Instant::now();
    let selected = connection
        .prepare(&sql)?
        .query_map(params_from_iter(rep_values.iter()), |r| {
            Ok(GroupSelection {
                group_id: r.get(0)?,
                representative_id: r.get(1)?,
                version_count: r.get::<_, i64>(2)? as u64,
                has_bookmarked_version: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    #[cfg(test)]
    report_measurement(
        connection,
        "representatives",
        &sql,
        &rep_values,
        started.elapsed(),
    );
    Ok((selected, total as u64))
}

#[cfg(test)]
fn report_measurement(
    connection: &Connection,
    phase: &str,
    sql: &str,
    values: &[Value],
    duration: std::time::Duration,
) {
    if std::env::var_os("LAKOMICS_GROUP_PROFILE").is_none() {
        return;
    }
    let plan = connection
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(params_from_iter(values.iter()), |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    eprintln!(
        "{}",
        serde_json::json!({"implementation":true,"phase":phase,"ms":duration.as_secs_f64()*1000.0,"plan":plan})
    );
}

#[cfg(test)]
#[path = "catalog_group_query_tests.rs"]
mod tests;
