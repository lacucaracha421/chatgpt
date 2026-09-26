//! Presentation and date-ordered navigation for registered series and characters.
use super::{
    characters::{Error, Result},
    models::AssetSummary,
    query::asset_summaries_by_ids,
    Library,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub classification_id: String,
    pub hero_asset_id: Option<String>,
    pub auto_classify: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseQuery {
    pub series_id: String,
    pub target_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub reference_target_id: Option<String>,
    pub after: Option<String>,
    pub limit: usize,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub series_filter: Option<SeriesGalleryFilter>,
}
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeriesGalleryFilter {
    Unclassified,
    NeedsReview,
    All,
}
impl SeriesGalleryFilter {
    fn stored(self) -> &'static str {
        match self {
            Self::Unclassified => "unclassified",
            Self::NeedsReview => "needs_review",
            Self::All => "all",
        }
    }
}
/// Per-character and per-group Asset counts for the folder tree, using the same
/// membership rules as opening that character or group without filters.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarCounts {
    pub targets: std::collections::HashMap<String, u64>,
    pub groups: std::collections::HashMap<String, u64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowsePage {
    pub items: Vec<AssetSummary>,
    pub next_cursor: Option<String>,
    pub total_count: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unavailable_reference_ids: Vec<String>,
}

pub(crate) const SERIES_GALLERY_SCOPE: &str = "WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id),
              ancestors(id,parent_id) AS (SELECT id,parent_id FROM classification_entries WHERE id=?1 UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
              SELECT a.id,a.collected_at FROM assets a WHERE a.status='normal'
              AND (?2 IS NOT NULL OR ?3 OR ?4='all' OR NOT EXISTS(SELECT 1 FROM asset_classifications ac JOIN character_excluded_folders e ON e.id=ac.classification_id WHERE ac.asset_id=a.id))
              AND (?2 IS NOT NULL OR ?3 OR ?4='all' OR NOT EXISTS(SELECT 1 FROM character_series_asset_exclusions x WHERE x.series_id=?1 AND x.asset_id=a.id))
              AND (EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope)) OR (?2 IS NOT NULL AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM ancestors)) AND EXISTS(SELECT 1 FROM character_relations r WHERE r.asset_id=a.id AND r.target_id=?2)))
              AND ((?2 IS NOT NULL AND (EXISTS(SELECT 1 FROM character_relations r WHERE r.asset_id=a.id AND r.target_id=?2)
                OR EXISTS(SELECT 1 FROM character_references r WHERE r.asset_id=a.id AND r.target_id=?2)
                OR EXISTS(SELECT 1 FROM character_learned_references r WHERE r.asset_id=a.id AND r.target_id=?2)))
                OR (?2 IS NULL AND (
                  ?3 OR ?4='all'
                  OR ((?4 IS NULL OR ?4='needs_review') AND EXISTS(
                    SELECT 1 FROM character_autotag_jobs j WHERE j.asset_id=a.id AND j.state='completed' AND j.review_state='partially_resolved'
                    AND NOT EXISTS(SELECT 1 FROM character_review_completions c WHERE c.asset_id=j.asset_id AND c.generation=j.generation AND c.source_generation=j.source_generation)
                  ))
                  OR ((?4 IS NULL OR ?4='unclassified') AND NOT EXISTS(SELECT 1 FROM character_relations r JOIN character_targets t ON t.id=r.target_id WHERE r.asset_id=a.id AND t.series_classification_id=?1)
                    AND NOT EXISTS(SELECT 1 FROM character_references r JOIN character_targets t ON t.id=r.target_id WHERE r.asset_id=a.id AND t.series_classification_id=?1)
                    AND NOT EXISTS(SELECT 1 FROM character_learned_references r JOIN character_targets t ON t.id=r.target_id WHERE r.asset_id=a.id AND t.series_classification_id=?1)))))";

/// Normal assets of one character group (?2) inside its series (?1). The group's member
/// assets (relations, references and learned references of its targets, deduplicated by
/// `UNION`) drive the join through `CROSS JOIN`, which SQLite keeps in the written order;
/// without `sqlite_stat1` the planner otherwise walks every normal asset and probes the
/// membership per asset (PERF-ALL-001: ~420 k VM steps per group on the real library).
/// Gate: `sidebar_count_vm_steps_stay_proportional_to_memberships`.
pub(crate) const GROUP_GALLERY_SCOPE: &str = "WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id),
              ancestors(id,parent_id) AS (SELECT id,parent_id FROM classification_entries WHERE id=?1 UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
              SELECT a.id,a.collected_at FROM (
                SELECT r.asset_id FROM character_group_members gm CROSS JOIN character_relations r ON r.target_id=gm.target_id WHERE gm.group_id=?2
                UNION SELECT r.asset_id FROM character_group_members gm CROSS JOIN character_references r ON r.target_id=gm.target_id WHERE gm.group_id=?2
                UNION SELECT r.asset_id FROM character_group_members gm CROSS JOIN character_learned_references r ON r.target_id=gm.target_id WHERE gm.group_id=?2
              ) AS member CROSS JOIN assets a ON a.id=member.asset_id WHERE a.status='normal'
              AND (EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
                OR (EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM ancestors))
                  AND EXISTS(SELECT 1 FROM character_relations r JOIN character_group_members gm ON gm.target_id=r.target_id WHERE r.asset_id=a.id AND gm.group_id=?2)))";

/// One character's gallery page. `dedup CROSS JOIN assets` keeps the character's own
/// assets as the driver (see [`GROUP_GALLERY_SCOPE`]); a plain `JOIN` walks every normal
/// asset per character without `sqlite_stat1`.
pub(crate) const TARGET_GALLERY_SQL: &str = r#"
WITH RECURSIVE scope(id) AS (
    SELECT id FROM classification_entries WHERE id=?1
    UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
), ancestors(id,parent_id) AS (
    SELECT id,parent_id FROM classification_entries WHERE id=?1
    UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id
), accepted(asset_id) AS (
    SELECT d.asset_id FROM character_decisions d
    WHERE d.target_id=?2 AND d.asset_id IS NOT NULL AND d.decision='accepted'
      AND NOT EXISTS(
        SELECT 1 FROM character_decisions newer
        WHERE newer.target_id=d.target_id AND newer.source_asset_id=d.source_asset_id
          AND newer.sequence>d.sequence
      )
), target_assets(asset_id,accepted) AS (
    SELECT asset_id,1 FROM accepted
    UNION ALL
    SELECT asset_id,0 FROM character_references WHERE target_id=?2 AND asset_id IS NOT NULL
    UNION ALL SELECT asset_id,0 FROM character_learned_references WHERE target_id=?2
), dedup(asset_id,accepted) AS (
    SELECT asset_id,MAX(accepted) FROM target_assets GROUP BY asset_id
), eligible(id,collected_at) AS (
    SELECT a.id,a.collected_at
    FROM dedup d CROSS JOIN assets a ON a.id=d.asset_id
    WHERE a.status='normal' AND (
        EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
        OR (d.accepted=1 AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM ancestors)))
    )
), ranked(id,collected_at,total_count) AS (
    SELECT id,collected_at,COUNT(*) OVER() FROM eligible
)
SELECT id,collected_at,total_count FROM ranked
WHERE (?3 IS NULL OR (collected_at,id)<(?3,?4))
ORDER BY collected_at DESC,id DESC LIMIT ?5
"#;

/// [`TARGET_GALLERY_SQL`]'s total alone, with the same `CROSS JOIN` driver.
const TARGET_GALLERY_COUNT_SQL: &str = r#"
WITH RECURSIVE scope(id) AS (
    SELECT id FROM classification_entries WHERE id=?1
    UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id
), ancestors(id,parent_id) AS (
    SELECT id,parent_id FROM classification_entries WHERE id=?1
    UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id
), accepted(asset_id) AS (
    SELECT d.asset_id FROM character_decisions d
    WHERE d.target_id=?2 AND d.asset_id IS NOT NULL AND d.decision='accepted'
      AND NOT EXISTS(SELECT 1 FROM character_decisions newer WHERE newer.target_id=d.target_id AND newer.source_asset_id=d.source_asset_id AND newer.sequence>d.sequence)
), target_assets(asset_id,accepted) AS (
    SELECT asset_id,1 FROM accepted
    UNION ALL SELECT asset_id,0 FROM character_references WHERE target_id=?2 AND asset_id IS NOT NULL
    UNION ALL SELECT asset_id,0 FROM character_learned_references WHERE target_id=?2
), dedup(asset_id,accepted) AS (
    SELECT asset_id,MAX(accepted) FROM target_assets GROUP BY asset_id
)
SELECT COUNT(*) FROM dedup d CROSS JOIN assets a ON a.id=d.asset_id
WHERE a.status='normal' AND (
    EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
    OR (d.accepted=1 AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM ancestors)))
)
"#;

pub(super) fn validate_art(connection: &Connection, id: &str) -> Result<()> {
    if !connection.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1 AND status='normal' AND media_kind='image')", [id], |r| r.get::<_, bool>(0))? {
        return Err(Error::Invalid("정상 이미지에서 대표 이미지를 선택해 주세요."));
    }
    Ok(())
}
impl Library {
    pub fn character_sidebar_counts(&self) -> Result<SidebarCounts> {
        let connection = self.connection()?;
        let mut counts = SidebarCounts::default();
        let targets = connection
            .prepare("SELECT id,series_classification_id FROM character_targets WHERE series_classification_id IS NOT NULL")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut target_count = connection.prepare(TARGET_GALLERY_COUNT_SQL)?;
        for (target_id, series_id) in targets {
            let total: i64 = target_count.query_row(params![series_id, target_id], |r| r.get(0))?;
            counts
                .targets
                .insert(target_id, u64::try_from(total).unwrap_or(0));
        }
        let groups = connection
            .prepare("SELECT id,series_id FROM character_groups")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut group_count =
            connection.prepare(&format!("SELECT COUNT(*) FROM ({GROUP_GALLERY_SCOPE})"))?;
        for (group_id, series_id) in groups {
            let total: i64 = group_count.query_row(params![series_id, group_id], |r| r.get(0))?;
            counts
                .groups
                .insert(group_id, u64::try_from(total).unwrap_or(0));
        }
        Ok(counts)
    }
    pub fn character_series(&self) -> Result<Vec<Series>> {
        let connection = self.connection()?;
        let mut query = connection.prepare("SELECT classification_id,(SELECT a.id FROM assets a WHERE a.id=hero_asset_id AND a.status='normal'),auto_classify FROM character_series ORDER BY classification_id")?;
        let result = query
            .query_map([], |r| {
                Ok(Series {
                    classification_id: r.get(0)?,
                    hero_asset_id: r.get(1)?,
                    auto_classify: r.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(result)
    }
    pub fn save_character_series(&self, request: Series) -> Result<Series> {
        let connection = self.connection()?;
        if super::classification::classification_in_role_scope(
            &connection,
            &request.classification_id,
            "originals",
        )? {
            return Err(Error::Invalid(
                "오리지널 보관 영역은 캐릭터 시리즈로 등록할 수 없습니다.",
            ));
        }
        if let Some(id) = &request.hero_asset_id {
            validate_art(&connection, id)?;
        }
        connection.execute("INSERT INTO character_series(classification_id,hero_asset_id,auto_classify) VALUES(?1,?2,?3)
          ON CONFLICT(classification_id) DO UPDATE SET hero_asset_id=excluded.hero_asset_id,auto_classify=excluded.auto_classify",
          params![request.classification_id,request.hero_asset_id,request.auto_classify])?;
        Ok(request)
    }
    pub fn browse_character_assets(&self, query: BrowseQuery) -> Result<BrowsePage> {
        if !(1..=200).contains(&query.limit) {
            return Err(Error::Invalid("조회 개수가 올바르지 않습니다."));
        }
        if query.group_id.is_some()
            && (query.target_id.is_some() || query.reference_target_id.is_some())
        {
            return Err(Error::Stale);
        }
        if let Some(group_id) = query.group_id.as_ref() {
            let valid: bool = self.connection()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM character_groups WHERE id=?1 AND series_id=?2)",
                params![group_id, query.series_id],
                |r| r.get(0),
            )?;
            if !valid {
                return Err(Error::Stale);
            }
        }
        if let Some(id) = query
            .reference_target_id
            .as_ref()
            .or(query.target_id.as_ref())
            .filter(|id| !id.is_empty())
        {
            if self
                .get_character_target(id)?
                .series_classification_id
                .as_deref()
                != Some(query.series_id.as_str())
            {
                return Err(Error::Stale);
            }
        }
        if query.reference_target_id.is_some()
            && query.target_id.is_some()
            && query.reference_target_id != query.target_id
        {
            return Err(Error::Stale);
        }
        let cursor: Option<(String, String)> = query
            .after
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?;
        if query.group_id.is_none() && query.reference_target_id.is_none() {
            if let Some(target_id) = query.target_id.as_deref() {
                return self.browse_character_target_assets(
                    &query.series_id,
                    target_id,
                    cursor.as_ref(),
                    query.limit,
                );
            }
        }
        let (ids, total) = {
            let connection = self.connection()?;
            let gallery_scope = SERIES_GALLERY_SCOPE;
            let group_scope = GROUP_GALLERY_SCOPE;
            let reference_scope = "WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id)
              SELECT a.id,a.collected_at FROM assets a WHERE a.status='normal' AND a.media_kind='image'
              AND NOT EXISTS(SELECT 1 FROM asset_classifications ac JOIN character_excluded_folders e ON e.id=ac.classification_id WHERE ac.asset_id=a.id)
              AND NOT EXISTS(SELECT 1 FROM character_series_asset_exclusions x WHERE x.series_id=?1 AND x.asset_id=a.id)
              AND EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
              AND NOT EXISTS(SELECT 1 FROM character_relations r WHERE r.asset_id=a.id AND r.target_id<>?2)
              AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.asset_id=a.id AND r.target_id<>?2)
              AND NOT EXISTS(SELECT 1 FROM character_learned_references r WHERE r.asset_id=a.id AND r.target_id<>?2)
              AND (?3 OR (NOT EXISTS(SELECT 1 FROM character_relations r WHERE r.asset_id=a.id)
              AND NOT EXISTS(SELECT 1 FROM character_references r WHERE r.asset_id=a.id)
              AND NOT EXISTS(SELECT 1 FROM character_learned_references r WHERE r.asset_id=a.id)))";
            let scoped_references = format!("{reference_scope} AND (EXISTS(SELECT 1 FROM character_relations r WHERE r.asset_id=a.id AND r.target_id=?2) OR EXISTS(SELECT 1 FROM character_references r WHERE r.asset_id=a.id AND r.target_id=?2) OR EXISTS(SELECT 1 FROM character_learned_references r WHERE r.asset_id=a.id AND r.target_id=?2))");
            let target_id = query
                .reference_target_id
                .as_ref()
                .or(query.target_id.as_ref());
            let all = query.all;
            let series_filter = query.series_filter.map(SeriesGalleryFilter::stored);
            if let Some(group_id) = query.group_id.as_ref() {
                let total: i64 = connection.query_row(
                    &format!("SELECT COUNT(*) FROM ({group_scope})"),
                    params![query.series_id, group_id],
                    |r| r.get(0),
                )?;
                let sql = format!("{group_scope} AND (?3 IS NULL OR (a.collected_at,a.id)<(?3,?4)) ORDER BY a.collected_at DESC,a.id DESC LIMIT ?5");
                let ids = connection
                    .prepare(&sql)?
                    .query_map(
                        params![
                            query.series_id,
                            group_id,
                            cursor.as_ref().map(|c| &c.0),
                            cursor.as_ref().map(|c| &c.1),
                            (query.limit + 1) as i64
                        ],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                (ids, total)
            } else if query.reference_target_id.is_some() {
                let scope = if query.target_id.is_some() {
                    scoped_references.as_str()
                } else {
                    reference_scope
                };
                let total: i64 = connection.query_row(
                    &format!("SELECT COUNT(*) FROM ({scope})"),
                    params![query.series_id, target_id, all],
                    |r| r.get(0),
                )?;
                let sql = format!("{scope} AND (?4 IS NULL OR (a.collected_at,a.id)<(?4,?5)) ORDER BY a.collected_at DESC,a.id DESC LIMIT ?6");
                let mut statement = connection.prepare(&sql)?;
                let ids = statement
                    .query_map(
                        params![
                            query.series_id,
                            target_id,
                            all,
                            cursor.as_ref().map(|c| &c.0),
                            cursor.as_ref().map(|c| &c.1),
                            (query.limit + 1) as i64
                        ],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                (ids, total)
            } else {
                let total: i64 = connection.query_row(
                    &format!("SELECT COUNT(*) FROM ({gallery_scope})"),
                    params![query.series_id, target_id, all, series_filter],
                    |r| r.get(0),
                )?;
                let sql = format!("{gallery_scope} AND (?5 IS NULL OR (a.collected_at,a.id)<(?5,?6)) ORDER BY a.collected_at DESC,a.id DESC LIMIT ?7");
                let ids = connection
                    .prepare(&sql)?
                    .query_map(
                        params![
                            query.series_id,
                            target_id,
                            all,
                            series_filter,
                            cursor.as_ref().map(|c| &c.0),
                            cursor.as_ref().map(|c| &c.1),
                            (query.limit + 1) as i64
                        ],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                (ids, total)
            }
        };
        let next_cursor = if ids.len() > query.limit {
            let last = &ids[query.limit - 1];
            Some(serde_json::to_string(&(&last.1, &last.0))?)
        } else {
            None
        };
        let page_ids = ids
            .iter()
            .take(query.limit)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let items = {
            let connection = self.connection()?;
            asset_summaries_by_ids(&connection, &page_ids)?
        };
        // Check only this picker page, outside the database lock. Keep unavailable
        // thumbnails in place so counts/cursors stay stable and the UI can explain them.
        let mut unavailable_reference_ids = Vec::new();
        if query.reference_target_id.is_some() {
            for item in &items {
                match self.open_library_media(&item.relative_path) {
                    Ok(_) => {}
                    Err(super::error::LibraryError::MediaNotFound) => {
                        unavailable_reference_ids.push(item.id.clone());
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(BrowsePage {
            items,
            next_cursor,
            total_count: total as u64,
            unavailable_reference_ids,
        })
    }

    fn browse_character_target_assets(
        &self,
        series_id: &str,
        target_id: &str,
        cursor: Option<&(String, String)>,
        limit: usize,
    ) -> Result<BrowsePage> {
        let (ids, total) = {
            let connection = self.connection()?;
            let rows = connection
                .prepare(TARGET_GALLERY_SQL)?
                .query_map(
                    params![
                        series_id,
                        target_id,
                        cursor.map(|value| value.0.as_str()),
                        cursor.map(|value| value.1.as_str()),
                        (limit + 1) as i64
                    ],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let total = match rows.first() {
                Some((_, _, total)) => *total,
                None => connection.query_row(
                    TARGET_GALLERY_COUNT_SQL,
                    params![series_id, target_id],
                    |row| row.get(0),
                )?,
            };
            (
                rows.into_iter()
                    .map(|(id, collected_at, _)| (id, collected_at))
                    .collect::<Vec<_>>(),
                total,
            )
        };
        let next_cursor = if ids.len() > limit {
            let last = &ids[limit - 1];
            Some(serde_json::to_string(&(&last.1, &last.0))?)
        } else {
            None
        };
        let page_ids = ids
            .iter()
            .take(limit)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let items = {
            let connection = self.connection()?;
            asset_summaries_by_ids(&connection, &page_ids)?
        };
        Ok(BrowsePage {
            items,
            next_cursor,
            total_count: total as u64,
            unavailable_reference_ids: Vec::new(),
        })
    }
}

// Manual scans stay in-series; automatic evidence may also come from its ancestors.
pub(super) fn candidate_image(
    connection: &Connection,
    series: &str,
    id: &str,
) -> Result<(String, String)> {
    candidate_image_mode(connection, series, id, false)
}

pub(super) fn candidate_image_mode(
    connection: &Connection,
    series: &str,
    id: &str,
    automatic: bool,
) -> Result<(String, String)> {
    candidate_media_mode(connection, series, id, automatic, false)
}

// Direct human assignment accepts videos and GIFs; recognition and references stay image-only.
pub(super) fn candidate_media_mode(
    connection: &Connection,
    series: &str,
    id: &str,
    automatic: bool,
    allow_video: bool,
) -> Result<(String, String)> {
    candidate_media_mode_with_exclusions(
        connection,
        series,
        id,
        automatic,
        allow_video,
        false,
        None,
    )
}

pub(super) fn candidate_media_mode_including_excluded(
    connection: &Connection,
    series: &str,
    id: &str,
    automatic: bool,
    allow_video: bool,
) -> Result<(String, String)> {
    candidate_media_mode_with_exclusions(connection, series, id, automatic, allow_video, true, None)
}

// A recorded decision must stay possible for every asset the character folder lists.
// Automatic parent-folder acceptance is a legitimate membership source, so rejecting an
// accepted asset cannot be gated on the series subtree alone.
pub(super) fn candidate_decision_media_mode(
    connection: &Connection,
    series: &str,
    target_id: &str,
    id: &str,
    automatic: bool,
    allow_video: bool,
) -> Result<(String, String)> {
    candidate_media_mode_with_exclusions(
        connection,
        series,
        id,
        automatic,
        allow_video,
        false,
        Some(target_id),
    )
}

pub(super) fn series_asset_excluded(
    connection: &Connection,
    series: &str,
    id: &str,
) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM character_series_asset_exclusions WHERE series_id=?1 AND asset_id=?2)",
        params![series, id],
        |row| row.get(0),
    )?)
}

fn candidate_media_mode_with_exclusions(
    connection: &Connection,
    series: &str,
    id: &str,
    automatic: bool,
    allow_video: bool,
    include_excluded: bool,
    existing_relation: Option<&str>,
) -> Result<(String, String)> {
    if super::classification::classification_in_role_scope(connection, series, "originals")? {
        return Err(Error::Invalid(
            "오리지널 보관 영역에서는 캐릭터 분류를 사용할 수 없습니다.",
        ));
    }
    if automatic && super::character_folders::asset_excluded(connection, id)? {
        return Err(Error::Invalid("캐릭터 분류에서 제외된 폴더의 자산입니다."));
    }
    if !include_excluded && series_asset_excluded(connection, series, id)? {
        return Err(Error::Invalid(
            "캐릭터 분류에서 제외된 자산입니다. 먼저 제외를 해제해 주세요.",
        ));
    }
    connection.query_row("WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id),
      ancestors(id,parent_id) AS (SELECT id,parent_id FROM classification_entries WHERE id=?1 UNION ALL
      SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
      SELECT a.content_hash,a.relative_path FROM assets a WHERE a.id=?2 AND a.status='normal' AND (a.media_kind='image' OR (?4 AND a.media_kind IN ('video','gif')))
      AND (EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND (ac.classification_id IN (SELECT id FROM scope) OR (?3 AND ac.classification_id IN (SELECT id FROM ancestors))))
        OR (?5 IS NOT NULL AND EXISTS(SELECT 1 FROM character_relations r WHERE r.asset_id=a.id AND r.target_id=?5)))",
      params![series,id,automatic,allow_video,existing_relation], |r| Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(Error::Invalid("시리즈 폴더 안의 지원되는 자산을 선택해 주세요."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::characters::{tests::Fixture, CharacterSettingsDraft, DecisionKind, DecisionRequest, TargetDraft};
    #[test]
    fn reference_picker_reports_missing_originals_without_losing_pages_or_saved_links() {
        let f = Fixture::new();
        let target = f.ready("A");
        std::fs::remove_file(f.temp.path().join("assets/asset-3.png")).unwrap();
        assert!(f.temp.path().join("thumbnails/asset-3.webp").is_file());
        let current = f.library.get_character_target(&target.id).unwrap();
        assert_eq!(current.references[3].status, "missing_file");
        assert!(matches!(
            f.library
                .replace_character_references(&target.id, current.revision, &f.refs),
            Err(Error::Library(
                super::super::error::LibraryError::MediaNotFound
            ))
        ));

        let mut after = None;
        let mut ids = Vec::new();
        let mut unavailable = Vec::new();
        loop {
            let page = f
                .library
                .browse_character_assets(BrowseQuery {
                    series_id: f.series.clone(),
                    target_id: Some(target.id.clone()),
                    group_id: None,
                    reference_target_id: Some(target.id.clone()),
                    after,
                    limit: 2,
                    all: true,
                    series_filter: None,
                })
                .unwrap();
            assert_eq!(page.total_count, 5);
            assert!(!page.items.is_empty());
            let json = serde_json::to_value(&page).unwrap();
            if let Some(missing) = json["unavailableReferenceIds"].as_array() {
                unavailable.extend(missing.iter().map(|id| id.as_str().unwrap().to_owned()));
            }
            ids.extend(page.items.iter().map(|item| item.id.clone()));
            after = page.next_cursor;
            if after.is_none() {
                break;
            }
        }
        assert_eq!(
            ids,
            vec!["asset-4", "asset-3", "asset-2", "asset-1", "asset-0"]
        );
        assert_eq!(unavailable, vec!["asset-3"]);

        let mut selected = current
            .usable_references()
            .filter_map(|reference| reference.asset_id.clone())
            .collect::<Vec<_>>();
        selected.push("asset-5".into());
        let saved = f
            .library
            .save_character_settings(
                CharacterSettingsDraft {
                    target: TargetDraft {
                        id: Some(current.id.clone()),
                        expected_revision: Some(current.revision),
                        series_classification_id: current.series_classification_id.clone(),
                        linked_classification_id: current.linked_classification_id.clone(),
                        display_name: current.display_name.clone(),
                        description: current.description.clone(),
                        thumbnail_asset_id: current.thumbnail_asset_id.clone(),
                        enabled: current.enabled,
                    },
                    reference_ids: selected,
                    reference_regions: Default::default(),
                },
                true,
            )
            .unwrap();
        assert_eq!(saved.usable_references().count(), 5);
        assert!(saved
            .references
            .iter()
            .chain(&saved.learned_references)
            .any(|reference| reference.asset_id.as_deref() == Some("asset-3")
                && reference.status == "missing_file"));
    }

    #[test]
    fn presentation_preserves_recognition_and_gallery_pages_real_relations() {
        let f = Fixture::new();
        let target = f.ready("A");
        let saved = f
            .library
            .save_character_target(TargetDraft {
                id: Some(target.id.clone()),
                expected_revision: Some(target.revision),
                series_classification_id: target.series_classification_id.clone(),
                linked_classification_id: target.linked_classification_id.clone(),
                display_name: target.display_name.clone(),
                enabled: true,
                description: "설명".into(),
                thumbnail_asset_id: Some("asset-5".into()),
            })
            .unwrap();
        assert_eq!(saved.fingerprint, target.fingerprint);
        assert_eq!(saved.description, "설명");
        assert_eq!(saved.thumbnail_asset_id.as_deref(), Some("asset-5"));
        let query = |target_id, after| BrowseQuery {
            reference_target_id: None,
            series_id: f.series.clone(),
            target_id,
            group_id: None,
            after,
            limit: 2,
            all: false,
            series_filter: None,
        };
        let unassigned = f
            .library
            .browse_character_assets(query(None, None))
            .unwrap();
        assert_eq!(unassigned.total_count, 1);
        assert_eq!(unassigned.items[0].id, "asset-5");
        let first = f
            .library
            .browse_character_assets(query(Some(target.id.clone()), None))
            .unwrap();
        assert_eq!(first.total_count, 5);
        assert_eq!(first.items.len(), 2);
        let second = f
            .library
            .browse_character_assets(query(Some(target.id.clone()), first.next_cursor))
            .unwrap();
        assert!(first
            .items
            .iter()
            .all(|a| second.items.iter().all(|b| a.id != b.id)));
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint,
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        assert_eq!(
            f.library
                .browse_character_assets(query(None, None))
                .unwrap()
                .total_count,
            0
        );
        assert_eq!(
            f.library
                .browse_character_assets(query(Some(target.id), None))
                .unwrap()
                .total_count,
            6
        );
        f.library
            .save_character_series(Series {
                classification_id: f.series.clone(),
                hero_asset_id: Some("asset-5".into()),
                auto_classify: true,
            })
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute("UPDATE assets SET status='trash' WHERE id='asset-5'", [])
            .unwrap();
        assert!(f.library.character_series().unwrap()[0]
            .hero_asset_id
            .is_none());
        assert!(f
            .library
            .get_character_target(&saved.id)
            .unwrap()
            .thumbnail_asset_id
            .is_none());
    }
    #[test]
    fn series_gallery_separates_unclassified_from_partially_resolved_assets() {
        let f = Fixture::new();
        let target = f.ready("A");
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id,
                expected_fingerprint: target.fingerprint,
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        f.library.connection().unwrap().execute(
            "INSERT INTO character_autotag_jobs(asset_id,generation,source_generation,content_hash,relative_path,classification_ids,state,review_state,updated_at)
             SELECT id,1,1,content_hash,relative_path,'[]','completed','partially_resolved','2026-09-11' FROM assets WHERE id='asset-5'",
            [],
        ).unwrap();
        let query = |series_filter, all| BrowseQuery {
            series_id: f.series.clone(),
            target_id: None,
            group_id: None,
            reference_target_id: None,
            after: None,
            limit: 100,
            all,
            series_filter: Some(series_filter),
        };

        let unclassified = f
            .library
            .browse_character_assets(query(SeriesGalleryFilter::Unclassified, false))
            .unwrap();
        assert!(unclassified.items.is_empty());
        let needs_review = f
            .library
            .browse_character_assets(query(SeriesGalleryFilter::NeedsReview, false))
            .unwrap();
        assert_eq!(
            needs_review
                .items
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            vec!["asset-5"]
        );
        let all = f
            .library
            .browse_character_assets(query(SeriesGalleryFilter::All, true))
            .unwrap();
        assert_eq!(all.total_count, 6);
    }
    #[test]
    fn target_gallery_keeps_root_moved_relations_and_drops_stale_membership() {
        let f = Fixture::new();
        let target = f.ready("A");
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        let root: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT parent_id FROM classification_entries WHERE id=?1",
                [&f.series],
                |row| row.get(0),
            )
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
                [&root],
            )
            .unwrap();
        let query = || BrowseQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            group_id: None,
            reference_target_id: None,
            after: None,
            limit: 100,
            all: false,
            series_filter: None,
        };
        let page = f.library.browse_character_assets(query()).unwrap();
        assert!(page.items.iter().any(|asset| asset.id == "asset-5"));
        assert_eq!(page.total_count, 6);

        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
                [&f.series],
            )
            .unwrap();
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Rejected,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
                [&root],
            )
            .unwrap();
        let page = f.library.browse_character_assets(query()).unwrap();
        assert!(page.items.iter().all(|asset| asset.id != "asset-5"));
        assert_eq!(page.total_count, 5);

        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-0'",
                [&root],
            )
            .unwrap();
        let page = f.library.browse_character_assets(query()).unwrap();
        assert!(page.items.iter().all(|asset| asset.id != "asset-0"));
        assert_eq!(page.total_count, 4);
    }

    #[test]
    fn group_gallery_unions_member_assets_without_duplicates() {
        let f = Fixture::new();
        let a = f.ready("A");
        let b = f.ready("B");
        for target in [&a, &b] {
            f.library
                .record_character_decisions(DecisionRequest {
                    target_id: target.id.clone(),
                    expected_fingerprint: target.fingerprint.clone(),
                    asset_ids: vec!["asset-5".into()],
                    decision: DecisionKind::Accepted,
                    baseline_fingerprint: None,
                    scan_id: None,
                })
                .unwrap();
        }
        let group_id = super::super::character_groups::save_character_group_in(
            &f.library.connection().unwrap(),
            super::super::character_groups::GroupDraft {
                id: None,
                series_id: f.series.clone(),
                expected_revision: None,
                name: "Duo".into(),
                target_ids: vec![a.id.clone(), b.id.clone()],
                delete: false,
            },
        )
        .unwrap();
        let page = f
            .library
            .browse_character_assets(BrowseQuery {
                series_id: f.series.clone(),
                target_id: None,
                group_id: Some(group_id.clone()),
                reference_target_id: None,
                after: None,
                limit: 100,
                all: false,
                series_filter: None,
            })
            .unwrap();
        let ids = page
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(ids.len(), page.items.len());
        assert!(ids.contains("asset-5"));
        assert_eq!(page.total_count as usize, ids.len());
        assert!(f
            .library
            .browse_character_assets(BrowseQuery {
                series_id: f.outside.clone(),
                target_id: None,
                group_id: Some(group_id),
                reference_target_id: None,
                after: None,
                limit: 100,
                all: false,
                series_filter: None
            })
            .is_err());
    }
    #[test]
    fn root_category_automatic_acceptance_stays_rejectable_from_the_character_folder() {
        let f = Fixture::new();
        let target = f.ready("A");
        // Automatic root-category acceptance: the asset lives under the series root, so
        // the folder lists it, but the series subtree alone would refuse a decision.
        let root: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT parent_id FROM classification_entries WHERE id=?1",
                [&f.series],
                |row| row.get(0),
            )
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-5'",
                [&root],
            )
            .unwrap();
        f.library.connection().unwrap().execute(
            "INSERT INTO character_decisions(target_id,asset_id,source_asset_id,asset_hash,decision,target_fingerprint,reference_snapshot,origin,created_at)
             SELECT ?1,id,id,content_hash,'accepted',?2,'[]','automatic','2026-09-11' FROM assets WHERE id='asset-5'",
            params![target.id, target.fingerprint],
        ).unwrap();

        let query = || BrowseQuery {
            series_id: f.series.clone(),
            target_id: Some(target.id.clone()),
            group_id: None,
            reference_target_id: None,
            after: None,
            limit: 100,
            all: false,
            series_filter: None,
        };
        // The folder must list it before a user can even attempt the rejection.
        let page = f.library.browse_character_assets(query()).unwrap();
        assert!(page.items.iter().any(|asset| asset.id == "asset-5"));

        let reject = |decision| DecisionRequest {
            target_id: target.id.clone(),
            expected_fingerprint: target.fingerprint.clone(),
            asset_ids: vec!["asset-5".into()],
            decision,
            baseline_fingerprint: None,
            scan_id: None,
        };
        // Rejecting an automatically accepted asset is the reported flow; it must succeed.
        f.library
            .record_character_decisions(reject(DecisionKind::Rejected))
            .unwrap();
        assert!(f
            .library
            .character_relations_for_asset("asset-5")
            .unwrap()
            .is_empty());
        assert!(f
            .library
            .browse_character_assets(query())
            .unwrap()
            .items
            .iter()
            .all(|a| a.id != "asset-5"));
        // The folder hides it, so reversal happens through history ("판단 해제"), which
        // clears the decision and returns the asset to the unclassified pool.
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: target.id.clone(),
                expected_fingerprint: target.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Cleared,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        assert!(f
            .library
            .character_relations_for_asset("asset-5")
            .unwrap()
            .is_empty());
        assert!(!f
            .library
            .list_character_decisions(&target.id, None, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn ancestor_and_other_series_images_are_not_eligible() {
        let f = Fixture::new();
        let root: String = f
            .library
            .connection()
            .unwrap()
            .query_row(
                "SELECT parent_id FROM classification_entries WHERE id=?1",
                [&f.series],
                |r| r.get(0),
            )
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
                [root],
            )
            .unwrap();
        assert!(candidate_image(&f.library.connection().unwrap(), &f.series, "asset-6").is_err());
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
                [&f.outside],
            )
            .unwrap();
        assert!(candidate_image(&f.library.connection().unwrap(), &f.series, "asset-6").is_err());
    }
    #[test]
    fn learned_references_are_full_character_membership_everywhere() {
        let f = Fixture::new();
        let a = f.ready("A");
        let b = f.ready("B");
        let connection = f.library.connection().unwrap();
        connection.execute(
            "INSERT INTO character_learned_references(target_id,asset_id,asset_hash,created_at) SELECT ?1,id,content_hash,'2026-09-13' FROM assets WHERE id='asset-5'",
            [&a.id],
        ).unwrap();
        drop(connection);

        let target_page = f.library.browse_character_assets(BrowseQuery { series_id:f.series.clone(), target_id:Some(a.id.clone()), group_id:None, reference_target_id:None, after:None, limit:100, all:false, series_filter:None }).unwrap();
        assert_eq!(target_page.total_count, 6);
        assert!(target_page.items.iter().any(|asset| asset.id == "asset-5"));

        let unclassified = f.library.browse_character_assets(BrowseQuery { series_id:f.series.clone(), target_id:None, group_id:None, reference_target_id:None, after:None, limit:100, all:false, series_filter:Some(SeriesGalleryFilter::Unclassified) }).unwrap();
        assert!(unclassified.items.iter().all(|asset| asset.id != "asset-5"));

        let group_id = super::super::character_groups::save_character_group_in(&f.library.connection().unwrap(), super::super::character_groups::GroupDraft { id:None, series_id:f.series.clone(), expected_revision:None, name:"A only".into(), target_ids:vec![a.id.clone()], delete:false }).unwrap();
        let group_page = f.library.browse_character_assets(BrowseQuery { series_id:f.series.clone(), target_id:None, group_id:Some(group_id.clone()), reference_target_id:None, after:None, limit:100, all:false, series_filter:None }).unwrap();
        assert!(group_page.items.iter().any(|asset| asset.id == "asset-5"));
        // Sidebar counts use the same membership as opening the character or group.
        let counts = f.library.character_sidebar_counts().unwrap();
        assert_eq!(counts.targets[&a.id], target_page.total_count);
        assert_eq!(counts.groups[&group_id], group_page.total_count);

        let picker = f.library.browse_character_assets(BrowseQuery { series_id:f.series.clone(), target_id:None, group_id:None, reference_target_id:Some(b.id.clone()), after:None, limit:100, all:true, series_filter:None }).unwrap();
        assert!(picker.items.iter().all(|asset| asset.id != "asset-5"));
        assert!(validate_character_selection(&f.library.connection().unwrap(), &f.series, Some(&b.id), "asset-5").is_err());
    }

    #[test]
    fn initial_character_creation_shows_references_beyond_the_first_five() {
        let f = Fixture::new();
        let reference_ids = (0..6).map(|i| format!("asset-{i}")).collect::<Vec<_>>();
        let target = f.library.save_character_settings(CharacterSettingsDraft {
            reference_regions: Default::default(),
            target: TargetDraft { id:None, expected_revision:None, series_classification_id:Some(f.series.clone()), linked_classification_id:Some(f.child.clone()), display_name:"Six refs".into(), description:String::new(), thumbnail_asset_id:None, enabled:true },
            reference_ids,
        }, true).unwrap();
        assert_eq!(target.references.len(), 5);
        assert_eq!(target.learned_references.len(), 1);
        let page = f.library.browse_character_assets(BrowseQuery { series_id:f.series.clone(), target_id:Some(target.id), group_id:None, reference_target_id:None, after:None, limit:100, all:false, series_filter:None }).unwrap();
        assert_eq!(page.total_count, 6);
        assert!(page.items.iter().any(|asset| asset.id == "asset-5"));
    }

    #[test]
    fn reference_picker_excludes_other_characters_before_pagination() {
        let f = Fixture::new();
        let a = f.ready("Towa");
        let b = f.ready("New character");
        let b = f
            .library
            .replace_character_references(&b.id, b.revision, &[])
            .unwrap();
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: a.id.clone(),
                expected_fingerprint: a.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        f.library
            .connection()
            .unwrap()
            .execute(
                "UPDATE asset_classifications SET classification_id=?1 WHERE asset_id='asset-6'",
                [&f.series],
            )
            .unwrap();
        let query = |id: &str, after| BrowseQuery {
            series_id: f.series.clone(),
            target_id: None,
            group_id: None,
            reference_target_id: Some(id.into()),
            after,
            limit: 2,
            all: true,
            series_filter: None,
        };
        let new = f
            .library
            .browse_character_assets(query(&b.id, None))
            .unwrap();
        assert_eq!(new.total_count, 1);
        assert_eq!(new.items[0].id, "asset-6");
        assert!(new.next_cursor.is_none());
        let own = f
            .library
            .browse_character_assets(query(&a.id, None))
            .unwrap();
        assert_eq!(own.total_count, 7);
        let scoped = f
            .library
            .browse_character_assets(BrowseQuery {
                target_id: Some(a.id.clone()),
                ..query(&a.id, None)
            })
            .unwrap();
        assert_eq!(scoped.total_count, 6);
        assert!(scoped.items.iter().all(|item| item.id != "asset-6"));
        assert!(scoped.next_cursor.is_some());
        let scoped_next = f
            .library
            .browse_character_assets(BrowseQuery {
                target_id: Some(a.id.clone()),
                ..query(&a.id, scoped.next_cursor)
            })
            .unwrap();
        assert!(scoped_next.items.iter().all(|item| item.id != "asset-6"
            && scoped.items.iter().all(|previous| previous.id != item.id)));

        let unclassified = f
            .library
            .browse_character_assets(BrowseQuery {
                all: false,
                ..query(&a.id, None)
            })
            .unwrap();
        assert_eq!(unclassified.total_count, 1);
        let unsaved = f.library.browse_character_assets(query("", None)).unwrap();
        assert_eq!(unsaved.total_count, 1);
        let connection = f.library.connection().unwrap();
        assert!(
            validate_character_selection(&connection, &f.series, Some(&b.id), "asset-5").is_err()
        );
        assert!(validate_character_selection(&connection, &f.series, None, "asset-0").is_err());
        assert!(
            validate_character_selection(&connection, &f.series, Some(&a.id), "asset-5").is_ok()
        );
        assert!(validate_character_selection(&connection, &f.series, None, "asset-6").is_ok());
        drop(connection);
        assert!(f
            .library
            .replace_character_references_selection(&b.id, b.revision, &["asset-5".into()], true)
            .is_err());
        assert!(f
            .library
            .get_character_target(&b.id)
            .unwrap()
            .references
            .is_empty());
        assert!(f
            .library
            .save_character_target_selection(
                super::super::characters::TargetDraft {
                    id: None,
                    expected_revision: None,
                    series_classification_id: Some(f.series.clone()),
                    linked_classification_id: None,
                    display_name: "Unsaved".into(),
                    description: String::new(),
                    thumbnail_asset_id: Some("asset-5".into()),
                    enabled: true,
                },
                true
            )
            .is_err());

        assert_eq!(own.items.len(), 2);
        assert!(own.next_cursor.is_some());
        let next = f
            .library
            .browse_character_assets(query(&a.id, own.next_cursor))
            .unwrap();
        assert!(next
            .items
            .iter()
            .all(|i| own.items.iter().all(|o| o.id != i.id)));
    }

    /// PERF-ALL-001 tighten-only gate. Character and group sidebar counts (and the galleries
    /// sharing their SQL) must cost VM steps in proportion to the character's or group's own
    /// assets, not to every normal asset. The pre-fix statements run on the same fixture to
    /// prove identical rows and that the thresholds catch the regression. Lower a `MAX_*`
    /// after a verified improvement; raise it only with a justified, measured reason.
    #[test]
    fn sidebar_count_vm_steps_stay_proportional_to_memberships() {
        const FILLER: usize = 2_000;
        // Measured on this fixture (bundled SQLite of rusqlite 0.40): target count fixed
        // 514, plain-`JOIN` plan 9,132; group count fixed 624, pre-fix scope 111,065.
        const MAX_TARGET_VM_STEPS: i32 = 650;
        const MAX_GROUP_VM_STEPS: i32 = 780;

        let f = Fixture::new();
        let a = f.ready("A");
        let b = f.ready("B");
        f.library
            .record_character_decisions(DecisionRequest {
                target_id: a.id.clone(),
                expected_fingerprint: a.fingerprint.clone(),
                asset_ids: vec!["asset-5".into()],
                decision: DecisionKind::Accepted,
                baseline_fingerprint: None,
                scan_id: None,
            })
            .unwrap();
        let group_id = super::super::character_groups::save_character_group_in(
            &f.library.connection().unwrap(),
            super::super::character_groups::GroupDraft {
                id: None,
                series_id: f.series.clone(),
                expected_revision: None,
                name: "Duo".into(),
                target_ids: vec![a.id.clone(), b.id.clone()],
                delete: false,
            },
        )
        .unwrap();
        {
            let mut connection = f.library.connection().unwrap();
            let transaction = connection.transaction().unwrap();
            {
                let mut asset = transaction
                    .prepare(
                        "INSERT INTO assets (
                            id, content_hash, media_kind, original_name, relative_path,
                            thumbnail_relative_path, byte_size, width, height, collected_at,
                            status
                         ) VALUES (?1, 'hash-' || ?1, 'image', ?1 || '.png',
                            'assets/' || ?1 || '.png', 'thumbnails/' || ?1 || '.webp',
                            1, 1, 1, '2026-08-16T00:00:00Z', ?2)",
                    )
                    .unwrap();
                let mut link = transaction
                    .prepare("INSERT INTO asset_classifications VALUES (?1, ?2)")
                    .unwrap();
                for index in 0..FILLER {
                    let id = format!("filler-{index:05}");
                    let status = if index % 7 == 3 { "trash" } else { "normal" };
                    asset.execute(params![id, status]).unwrap();
                    let folder = if index % 2 == 0 { &f.child } else { &f.outside };
                    link.execute(params![id, folder]).unwrap();
                }
            }
            transaction.commit().unwrap();
        }

        let connection = f.library.connection().unwrap();
        let no_cursor: Option<String> = None;
        let mut target_counts = std::collections::HashMap::new();
        let (mut target_fixed, mut target_plain) = (0, 0);
        for target in [&a, &b] {
            let count = compare(
                &connection,
                TARGET_GALLERY_COUNT_SQL,
                &TARGET_GALLERY_COUNT_SQL.replace("CROSS JOIN", "JOIN"),
                params![f.series, target.id],
            );
            assert_eq!(count.fixed_rows, count.plain_rows);
            target_fixed = target_fixed.max(count.fixed_steps);
            target_plain = target_plain.max(count.plain_steps);
            let page = compare(
                &connection,
                TARGET_GALLERY_SQL,
                &TARGET_GALLERY_SQL.replace("CROSS JOIN", "JOIN"),
                params![f.series, target.id, no_cursor, no_cursor, 100],
            );
            assert_eq!(page.fixed_rows, page.plain_rows);
            let total = match &count.fixed_rows[0][0] {
                rusqlite::types::Value::Integer(total) => *total,
                other => panic!("unexpected count {other:?}"),
            };
            assert_eq!(page.fixed_rows.len() as i64, total);
            target_counts.insert(target.id.clone(), total as u64);
        }
        let group_count_sql = format!("SELECT COUNT(*) FROM ({GROUP_GALLERY_SCOPE})");
        let group = compare(
            &connection,
            &group_count_sql,
            &format!("SELECT COUNT(*) FROM ({PRE_FIX_GROUP_GALLERY_SCOPE})"),
            params![f.series, group_id],
        );
        assert_eq!(group.fixed_rows, group.plain_rows);
        let group_rows = compare(
            &connection,
            &format!("{GROUP_GALLERY_SCOPE} ORDER BY a.collected_at DESC,a.id DESC"),
            &format!("{PRE_FIX_GROUP_GALLERY_SCOPE} ORDER BY a.collected_at DESC,a.id DESC"),
            params![f.series, group_id],
        );
        assert_eq!(group_rows.fixed_rows, group_rows.plain_rows);
        drop(connection);
        eprintln!(
            "target count VM steps: fixed {target_fixed}, plain JOIN {target_plain}; group count VM steps: fixed {}, pre-fix {}",
            group.fixed_steps, group.plain_steps
        );
        // Five references plus the accepted asset-5 for A; five references for B.
        assert_eq!(target_counts[&a.id], 6);
        assert_eq!(target_counts[&b.id], 5);
        assert_eq!(group_rows.fixed_rows.len(), 6);
        let counts = f.library.character_sidebar_counts().unwrap();
        assert_eq!(counts.targets, target_counts);
        assert_eq!(counts.groups[&group_id], 6);

        assert!(
            target_fixed <= MAX_TARGET_VM_STEPS,
            "target count VM steps {target_fixed} exceed the gate {MAX_TARGET_VM_STEPS}"
        );
        assert!(
            target_plain > MAX_TARGET_VM_STEPS,
            "the pre-fix target count plan ({target_plain} VM steps) no longer exceeds the gate"
        );
        assert!(
            group.fixed_steps <= MAX_GROUP_VM_STEPS,
            "group count VM steps {} exceed the gate {MAX_GROUP_VM_STEPS}",
            group.fixed_steps
        );
        assert!(
            group.plain_steps > MAX_GROUP_VM_STEPS,
            "the pre-fix group count plan ({} VM steps) no longer exceeds the gate",
            group.plain_steps
        );
    }

    /// Real-data equality check for the character count rewrites: every target's count and
    /// gallery rows and every group's rows, old statements against new. Point
    /// `LAKOMICS_CHARACTERS_SNAPSHOT_DB` at the `library.sqlite` of a snapshot copy, never at
    /// the live library; it is opened read-only.
    #[test]
    #[ignore = "needs LAKOMICS_CHARACTERS_SNAPSHOT_DB"]
    fn sidebar_counts_match_pre_fix_plan_on_snapshot() {
        let path = std::env::var_os("LAKOMICS_CHARACTERS_SNAPSHOT_DB")
            .expect("LAKOMICS_CHARACTERS_SNAPSHOT_DB");
        let connection =
            rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let pairs = |sql: &str| {
            connection
                .prepare(sql)
                .unwrap()
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        let no_cursor: Option<String> = None;
        let (mut fixed, mut plain, mut rows) = (0_i64, 0_i64, 0_usize);
        let targets = pairs("SELECT id,series_classification_id FROM character_targets WHERE series_classification_id IS NOT NULL ORDER BY id");
        for (target_id, series_id) in &targets {
            let count = compare(
                &connection,
                TARGET_GALLERY_COUNT_SQL,
                &TARGET_GALLERY_COUNT_SQL.replace("CROSS JOIN", "JOIN"),
                params![series_id, target_id],
            );
            assert_eq!(count.fixed_rows, count.plain_rows, "target {target_id}");
            let page = compare(
                &connection,
                TARGET_GALLERY_SQL,
                &TARGET_GALLERY_SQL.replace("CROSS JOIN", "JOIN"),
                params![series_id, target_id, no_cursor, no_cursor, 100_000],
            );
            assert_eq!(page.fixed_rows, page.plain_rows, "target {target_id}");
            rows += page.fixed_rows.len();
            fixed += i64::from(count.fixed_steps);
            plain += i64::from(count.plain_steps);
        }
        eprintln!(
            "{} targets, {rows} gallery rows; count VM steps: fixed {fixed}, plain JOIN {plain}",
            targets.len()
        );
        let (mut fixed, mut plain, mut rows) = (0_i64, 0_i64, 0_usize);
        let groups = pairs("SELECT id,series_id FROM character_groups ORDER BY id");
        for (group_id, series_id) in &groups {
            let count = compare(
                &connection,
                &format!("SELECT COUNT(*) FROM ({GROUP_GALLERY_SCOPE})"),
                &format!("SELECT COUNT(*) FROM ({PRE_FIX_GROUP_GALLERY_SCOPE})"),
                params![series_id, group_id],
            );
            assert_eq!(count.fixed_rows, count.plain_rows, "group {group_id}");
            let page = compare(
                &connection,
                &format!("{GROUP_GALLERY_SCOPE} ORDER BY a.collected_at DESC,a.id DESC"),
                &format!("{PRE_FIX_GROUP_GALLERY_SCOPE} ORDER BY a.collected_at DESC,a.id DESC"),
                params![series_id, group_id],
            );
            assert_eq!(page.fixed_rows, page.plain_rows, "group {group_id}");
            rows += page.fixed_rows.len();
            fixed += i64::from(count.fixed_steps);
            plain += i64::from(count.plain_steps);
        }
        eprintln!(
            "{} groups, {rows} gallery rows; count VM steps: fixed {fixed}, pre-fix {plain}",
            groups.len()
        );
    }

    /// [`GROUP_GALLERY_SCOPE`] before PERF-ALL-001 (every normal asset drives the join).
    const PRE_FIX_GROUP_GALLERY_SCOPE: &str = "WITH RECURSIVE scope(id) AS (SELECT id FROM classification_entries WHERE id=?1 UNION SELECT c.id FROM classification_entries c JOIN scope s ON c.parent_id=s.id),
              ancestors(id,parent_id) AS (SELECT id,parent_id FROM classification_entries WHERE id=?1 UNION ALL SELECT c.id,c.parent_id FROM classification_entries c JOIN ancestors p ON c.id=p.parent_id)
              SELECT a.id,a.collected_at FROM assets a WHERE a.status='normal'
              AND (EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM scope))
                OR (EXISTS(SELECT 1 FROM asset_classifications ac WHERE ac.asset_id=a.id AND ac.classification_id IN (SELECT id FROM ancestors))
                  AND EXISTS(SELECT 1 FROM character_relations r JOIN character_group_members gm ON gm.target_id=r.target_id WHERE r.asset_id=a.id AND gm.group_id=?2)))
              AND (EXISTS(SELECT 1 FROM character_relations r JOIN character_group_members gm ON gm.target_id=r.target_id WHERE r.asset_id=a.id AND gm.group_id=?2)
                OR EXISTS(SELECT 1 FROM character_references r JOIN character_group_members gm ON gm.target_id=r.target_id WHERE r.asset_id=a.id AND gm.group_id=?2)
                OR EXISTS(SELECT 1 FROM character_learned_references r JOIN character_group_members gm ON gm.target_id=r.target_id WHERE r.asset_id=a.id AND gm.group_id=?2))";

    struct Compared {
        fixed_rows: Vec<Vec<rusqlite::types::Value>>,
        fixed_steps: i32,
        plain_rows: Vec<Vec<rusqlite::types::Value>>,
        plain_steps: i32,
    }

    /// Runs a product statement and its pre-fix form with the same parameters; returns every
    /// column of every row (in statement order) with each statement's VM steps.
    fn compare(
        connection: &Connection,
        fixed_sql: &str,
        plain_sql: &str,
        values: &[&dyn rusqlite::ToSql],
    ) -> Compared {
        let run = |sql: &str| {
            let mut statement = connection.prepare(sql).unwrap();
            let columns = statement.column_count();
            let rows = statement
                .query_map(values, |row| {
                    (0..columns)
                        .map(|index| row.get::<_, rusqlite::types::Value>(index))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (
                rows,
                statement.get_status(rusqlite::StatementStatus::VmStep),
            )
        };
        let (fixed_rows, fixed_steps) = run(fixed_sql);
        let (plain_rows, plain_steps) = run(plain_sql);
        Compared {
            fixed_rows,
            fixed_steps,
            plain_rows,
            plain_steps,
        }
    }
}

// The same eligibility rule protects thumbnail/reference saves if a concurrent decision changes ownership.
pub(super) fn validate_character_selection(
    connection: &Connection,
    series: &str,
    target: Option<&str>,
    asset: &str,
) -> Result<()> {
    super::characters::scoped_image(connection, series, asset)?;
    if series_asset_excluded(connection, series, asset)? {
        return Err(Error::Invalid(
            "캐릭터 분류에서 제외된 이미지는 선택할 수 없습니다.",
        ));
    }
    let excluded: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM character_relations WHERE asset_id=?1 AND (?2 IS NULL OR target_id<>?2)) OR EXISTS(SELECT 1 FROM character_references WHERE asset_id=?1 AND (?2 IS NULL OR target_id<>?2)) OR EXISTS(SELECT 1 FROM character_learned_references WHERE asset_id=?1 AND (?2 IS NULL OR target_id<>?2))", params![asset,target], |r| r.get(0))?;
    if excluded {
        return Err(Error::Invalid(
            "다른 캐릭터에 등록된 이미지입니다. 선택을 다시 확인해 주세요.",
        ));
    }
    Ok(())
}
