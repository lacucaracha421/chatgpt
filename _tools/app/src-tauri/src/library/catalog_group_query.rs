use rusqlite::{params_from_iter, types::Value, Connection};

use super::{
    catalog_query::{compile, parse, Expr},
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

// Boundary measurements at 32,768 / 65,536 / 120,000 candidates showed
// material benefit through 65,536 with both empty and saved policy. Bound the
// index-only probe as well as the selected seed; never enumerate a broad tag.
pub(super) const SELECTIVE_CANDIDATE_LIMIT: i64 = 65_536;
// Page enumeration has a separate measured bound. At 251/512 bookmarks the
// short-language-page probe plus seed took ~1.8/9.5ms versus ~670ms rank scans.
// Dense pages retain rank early exit; the COUNT seed bound is not a page bound.
const BOOKMARK_PAGE_CANDIDATE_LIMIT: i64 = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CountRoute {
    Id,
    Prepared,
    Bookmark,
    Tag,
    General,
}

pub(super) struct GroupQueryPlan {
    query: CatalogSearchQuery,
    eligible: String,
    matching: String,
    values: Vec<Value>,
    seed: Option<(String, Vec<Value>)>,
    bookmark_candidates: Option<i64>,
    seed_page: bool,
    pub(super) route: CountRoute,
    pub(super) hot_cutoff: Option<i64>,
}

// Only conjunctive ancestors prove a predicate mandatory. Never descend into
// OR or NOT, even when the text happens to contain an ID or exact tag.
fn mandatory<'a>(expression: &'a Expr, out: &mut Vec<&'a Expr>) {
    match expression {
        Expr::And(a, b) => {
            mandatory(a, out);
            mandatory(b, out);
        }
        Expr::Or(_, _) | Expr::Not(_) => {}
        leaf => out.push(leaf),
    }
}

impl GroupQueryPlan {
    /// Caller owns a fixed read snapshot spanning planning, page and count.
    pub(super) fn new(
        connection: &Connection,
        query: &CatalogSearchQuery,
        now: i64,
    ) -> Result<Self, LibraryError> {
        let expression = parse(&query.text)?;
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
        let seconds = match query.sort {
            CatalogSort::HotDay => Some(86_400),
            CatalogSort::HotWeek => Some(604_800),
            CatalogSort::HotMonth => Some(2_592_000),
            _ => None,
        };
        let hot_cutoff = if let Some(seconds) = seconds {
            let posted_index: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM catalog.sqlite_master WHERE type='index' AND name='IdxWorksPosted')", [], |r| r.get(0))?;
            let access = if posted_index {
                "INDEXED BY IdxWorksPosted"
            } else {
                ""
            };
            let latest: Option<i64> = connection.query_row(
                &format!("SELECT (SELECT work.Posted FROM catalog.Works work {access} WHERE {eligible} ORDER BY work.Posted DESC LIMIT 1)"),
                params_from_iter(values.iter()), |r| r.get(0))?;
            Some(latest.unwrap_or(now).min(now).saturating_sub(seconds))
        } else {
            None
        };
        let mut matching = Vec::new();
        if query.scope == CatalogScope::Bookmarked {
            matching.push("EXISTS(SELECT 1 FROM online_catalog_bookmarks b WHERE b.provider='kHentai' AND b.work_id=CAST(work.Id AS TEXT))".to_owned());
        }
        if let Some(expression) = &expression {
            let compiled = compile(expression);
            matching.push(compiled.sql);
            values.extend(compiled.params);
        }
        if let Some(cutoff) = hot_cutoff {
            matching.push("work.Posted>=?".into());
            values.push(cutoff.into());
        }
        let matching = if matching.is_empty() {
            "1".into()
        } else {
            matching.join(" AND ")
        };
        let mut leaves = Vec::new();
        if let Some(expression) = &expression {
            mandatory(expression, &mut leaves);
        }
        let id = leaves.iter().find_map(|leaf| {
            if let Expr::Id(id) = leaf {
                Some(*id)
            } else {
                None
            }
        });
        let mut route = CountRoute::General;
        let mut seed = None;
        let mut bookmark_candidates = None;
        if let Some(id) = id {
            route = CountRoute::Id;
            seed = Some(("SELECT ? AS Id".into(), vec![id.into()]));
        } else if expression.is_none() && query.scope == CatalogScope::All && hot_cutoff.is_none() {
            route = CountRoute::Prepared;
        } else if query.scope == CatalogScope::Bookmarked {
            let sql = "SELECT work_id AS Id FROM online_catalog_bookmarks WHERE provider='kHentai'";
            let n: i64 = connection.query_row(
                &format!(
                    "SELECT COUNT(*) FROM ({sql} LIMIT {})",
                    SELECTIVE_CANDIDATE_LIMIT + 1
                ),
                [],
                |r| r.get(0),
            )?;
            bookmark_candidates = Some(n);
            if n <= SELECTIVE_CANDIDATE_LIMIT {
                route = CountRoute::Bookmark;
                seed = Some((sql.into(), vec![]));
            }
        }
        if route == CountRoute::General {
            let mut tags = Vec::new();
            if let Some(language) = query.language {
                tags.push(("language".to_owned(), language.as_tag().to_owned()));
            }
            for leaf in leaves {
                if let Expr::Tag { namespace, value } = leaf {
                    tags.push((namespace.clone(), value.clone()));
                }
            }
            for (namespace, value) in tags {
                let sql="SELECT WorkId AS Id FROM catalog.Tags INDEXED BY IdxTagsLookup WHERE Namespace=? AND Value=?";
                let parameters = vec![Value::Text(namespace), Value::Text(value)];
                let n: i64 = connection.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM ({sql} LIMIT {})",
                        SELECTIVE_CANDIDATE_LIMIT + 1
                    ),
                    params_from_iter(parameters.iter()),
                    |r| r.get(0),
                )?;
                if n <= SELECTIVE_CANDIDATE_LIMIT {
                    route = CountRoute::Tag;
                    seed = Some((sql.into(), parameters));
                    break;
                }
            }
        }
        let mut plan = Self {
            query: query.clone(),
            eligible,
            matching,
            values,
            seed,
            route,
            hot_cutoff,
            bookmark_candidates,
            seed_page: false,
        };
        if plan.route == CountRoute::Bookmark
            && plan
                .bookmark_candidates
                .is_some_and(|n| n <= BOOKMARK_PAGE_CANDIDATE_LIMIT)
        {
            if let Some((sql, values)) = plan.short_page_probe_statement() {
                let candidates: i64 =
                    connection.query_row(&sql, params_from_iter(values.iter()), |r| r.get(0))?;
                // Every matching group fits the first page if even the larger
                // hard-language member set fits. Query/visibility can only remove
                // members, so a rank traversal cannot stop before exhausting it.
                plan.seed_page = candidates <= i64::from(query.page_size.clamp(1, 100));
            }
        }
        Ok(plan)
    }

    fn cte(&self, access: &str) -> String {
        format!("WITH eligible AS NOT MATERIALIZED (SELECT work.* FROM catalog.Works work {access} WHERE {}), matching AS NOT MATERIALIZED (SELECT work.* FROM eligible work WHERE {})",self.eligible,self.matching)
    }
    fn short_page_probe_statement(&self) -> Option<(String, Vec<Value>)> {
        if self.query.scope != CatalogScope::Bookmarked {
            return None;
        }
        let language = self.query.language?;
        Some(("SELECT COUNT(*) FROM (SELECT 1 FROM online_catalog_bookmarks bookmark
            CROSS JOIN catalog.Works work ON work.Id=bookmark.work_id AND CAST(work.Id AS TEXT)=bookmark.work_id
            WHERE bookmark.provider='kHentai' AND EXISTS(SELECT 1 FROM catalog.Tags language
              WHERE language.WorkId=work.Id AND language.Namespace='language' AND language.Value=?) LIMIT ?)".into(),
            vec![language.as_tag().to_owned().into(),(i64::from(self.query.page_size.clamp(1,100))+1).into()]))
    }
    #[cfg(test)]
    pub(super) fn experimental_short_page_probe_statement(&self) -> Option<(String, Vec<Value>)> {
        self.short_page_probe_statement()
    }
    #[cfg(test)]
    pub(super) fn experimental_seed_page_statement(&self) -> Option<(String, Vec<Value>)> {
        self.seed_page_statement()
    }
    fn seed_page_statement(&self) -> Option<(String, Vec<Value>)> {
        let (seed, seed_values) = self.seed.as_ref()?;
        let (order, better) = match self.query.sort {
            CatalogSort::Latest => (
                "donor.Posted DESC,donor.Id DESC",
                "(work.Posted IS NOT NULL,COALESCE(work.Posted,0),work.Id)>(donor.Posted IS NOT NULL,COALESCE(donor.Posted,0),donor.Id)",
            ),
            _ => (
                "donor.Views DESC,donor.Posted DESC,donor.Id DESC",
                "(work.Views,work.Posted IS NOT NULL,COALESCE(work.Posted,0),work.Id)>(donor.Views,donor.Posted IS NOT NULL,COALESCE(donor.Posted,0),donor.Id)",
            ),
        };
        let canonical = if self.route == CountRoute::Bookmark {
            " AND CAST(donor.Id AS TEXT)=candidate.Id"
        } else {
            ""
        };
        let sql = format!("{}, candidate AS MATERIALIZED ({seed})
            SELECT member.group_id,donor.Title,donor.Id FROM candidate
            CROSS JOIN matching donor ON donor.Id=candidate.Id{canonical}
            CROSS JOIN online_catalog_group_members member ON member.provider='kHentai' AND member.catalog_work_id=donor.Id
            WHERE NOT EXISTS(SELECT 1 FROM online_catalog_group_members sibling CROSS JOIN matching work ON work.Id=sibling.catalog_work_id
              WHERE sibling.provider=member.provider AND sibling.group_id=member.group_id AND {better})
            ORDER BY {order} LIMIT ? OFFSET ?",self.cte(""));
        let mut values = self.values.clone();
        values.extend(seed_values.clone());
        values.push(i64::from(self.query.page_size.clamp(1, 100)).into());
        values.push(
            (u64::from(self.query.page) * u64::from(self.query.page_size.clamp(1, 100)))
                .min(i64::MAX as u64)
                .try_into()
                .map(Value::Integer)
                .unwrap(),
        );
        Some((sql, values))
    }
    pub(super) fn count_statement(&self) -> Option<(String, Vec<Value>)> {
        if self.route == CountRoute::Prepared {
            return None;
        }
        Some(self.direct_count_statement())
    }
    pub(super) fn generic_count_statement(&self) -> (String, Vec<Value>) {
        (format!("{} SELECT COUNT(DISTINCT member.group_id) FROM matching work CROSS JOIN online_catalog_group_members member ON member.provider='kHentai' AND member.catalog_work_id=work.Id",self.cte("NOT INDEXED")),self.values.clone())
    }
    pub(super) fn raw_count_statement(&self) -> (String, Vec<Value>) {
        (
            format!("{} SELECT COUNT(*) FROM matching work", self.cte("")),
            self.values.clone(),
        )
    }
    fn direct_count_statement(&self) -> (String, Vec<Value>) {
        if let Some((seed, parameters)) = &self.seed {
            let mut values = parameters.clone();
            values.extend(self.values.clone());
            // Bookmarks use a canonical text equality too: integer coercion alone
            // would admit aliases such as 01 for work 1.
            let canonical = if self.route == CountRoute::Bookmark {
                " AND CAST(work.Id AS TEXT)=candidate.Id"
            } else {
                ""
            };
            (format!("WITH candidate AS MATERIALIZED ({seed}) SELECT COUNT(DISTINCT member.group_id) FROM candidate CROSS JOIN catalog.Works work ON work.Id=candidate.Id{canonical} CROSS JOIN online_catalog_group_members member ON member.provider='kHentai' AND member.catalog_work_id=work.Id WHERE {} AND {}",self.eligible,self.matching),values)
        } else {
            self.generic_count_statement()
        }
    }
}

pub(super) fn count_groups(
    connection: &Connection,
    plan: &GroupQueryPlan,
) -> Result<Option<u64>, LibraryError> {
    if plan.route == CountRoute::Prepared {
        return super::catalog_counts::lookup(
            connection,
            plan.query.language,
            plan.query.reveal_blocked,
        );
    }
    generic_count(connection, plan).map(Some)
}

fn generic_count(connection: &Connection, plan: &GroupQueryPlan) -> Result<u64, LibraryError> {
    let (sql, values) = plan.direct_count_statement();
    #[cfg(test)]
    let started = std::time::Instant::now();
    let count: i64 = connection.query_row(&sql, params_from_iter(values.iter()), |r| r.get(0))?;
    #[cfg(test)]
    report_measurement(connection, "count", &sql, &values, started.elapsed());
    Ok(count as u64)
}

// Historical backend tests exercise arbitrary direct mutations without running
// the preparation lifecycle. Production callers must preserve pending counts.
pub(super) fn select_groups(
    connection: &Connection,
    query: &CatalogSearchQuery,
) -> Result<(Vec<GroupSelection>, u64), LibraryError> {
    let plan = GroupQueryPlan::new(connection, query, chrono::Utc::now().timestamp())?;
    let page = select_page(connection, &plan)?;
    let count = count_groups(connection, &plan)?;
    #[cfg(test)]
    let count = match count {
        Some(count) => count,
        None => generic_count(connection, &plan)?,
    };
    #[cfg(not(test))]
    let count = count.ok_or(LibraryError::Database(rusqlite::Error::InvalidQuery))?;
    Ok((page, count))
}

pub(super) fn select_page(
    connection: &Connection,
    plan: &GroupQueryPlan,
) -> Result<Vec<GroupSelection>, LibraryError> {
    let query = &plan.query;
    let cte = plan.cte("");
    let values = plan.values.clone();
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
    let source = if query.sort == CatalogSort::Latest
        && posted_index
        && plan.route != CountRoute::Id
    {
        "catalog.Works ordered INDEXED BY IdxWorksPosted CROSS JOIN matching donor ON donor.Id=ordered.Id"
    } else {
        "matching donor"
    };
    let order = if query.sort == CatalogSort::Latest && posted_index && plan.route != CountRoute::Id
    {
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
    let (sql, page_values) = if plan.seed_page {
        // Only the measured, guaranteed-short bookmark shape uses this page
        // plan. Other COUNT seeds preserve their independent page access paths.
        plan.seed_page_statement()
            .expect("bookmark page has a seed")
    } else {
        (sql, page_values)
    };
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
        return Ok(Vec::new());
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
    Ok(selected)
}

#[cfg(test)]
#[derive(Clone)]
pub(super) struct QueryMeasurement {
    pub(super) phase: String,
    pub(super) sql: String,
    pub(super) values: Vec<Value>,
    pub(super) duration: std::time::Duration,
}
#[cfg(test)]
thread_local! { static MEASUREMENTS: std::cell::RefCell<Vec<QueryMeasurement>> = const { std::cell::RefCell::new(Vec::new()) }; }
#[cfg(test)]
pub(super) fn take_measurements() -> Vec<QueryMeasurement> {
    MEASUREMENTS.with(|measurements| std::mem::take(&mut *measurements.borrow_mut()))
}

#[cfg(test)]
fn report_measurement(
    connection: &Connection,
    phase: &str,
    sql: &str,
    values: &[Value],
    duration: std::time::Duration,
) {
    MEASUREMENTS.with(|measurements| {
        measurements.borrow_mut().push(QueryMeasurement {
            phase: phase.into(),
            sql: sql.into(),
            values: values.to_vec(),
            duration,
        })
    });
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
