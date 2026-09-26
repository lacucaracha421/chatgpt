use rusqlite::{params, Connection, OptionalExtension};

use super::LibraryError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CharacterScope {
    pub series_classification_ids: Vec<String>,
}

/// The broad-folder rule (2026-09-12): an image filed directly in a folder without a
/// registered series ancestor is compared with every registered series below that folder.
/// A library setting, off by default since 2026-09-27.
pub(super) fn broad_folder_scope_enabled(
    connection: &Connection,
) -> std::result::Result<bool, LibraryError> {
    Ok(connection
        .query_row(
            "SELECT broad_folder_scope FROM character_autotag_control WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(false))
}

/// SQL condition on a `character_autotag_jobs` row aliased `j`: the job may run now, because
/// the broad-folder rule is on or its folder has a registered series ancestor (or is one).
/// Broad-folder jobs kept while the rule is off wait, unclaimed, until it is turned back on.
pub(super) const JOB_SCOPE_ALLOWED_SQL: &str = "(EXISTS(SELECT 1 FROM character_autotag_control WHERE singleton=1 AND broad_folder_scope=1)
    OR EXISTS(SELECT 1 FROM json_each(j.classification_ids) k WHERE k.value IN (
        WITH RECURSIVE covered(id) AS (
            SELECT classification_id FROM character_series
            UNION SELECT c.id FROM classification_entries c JOIN covered p ON c.parent_id=p.id
        ) SELECT id FROM covered)))";

/// Registered-series folders and everything below them. An image whose folder is outside
/// this set is a broad-folder image.
pub(super) fn series_covered_folders(
    connection: &Connection,
) -> std::result::Result<std::collections::HashSet<String>, LibraryError> {
    Ok(connection
        .prepare(
            "WITH RECURSIVE covered(id) AS (
                SELECT classification_id FROM character_series
                UNION SELECT c.id FROM classification_entries c JOIN covered p ON c.parent_id=p.id
             ) SELECT id FROM covered",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<_, _>>()?)
}

pub(super) fn resolve_character_scope(
    connection: &Connection,
    asset_id: &str,
) -> std::result::Result<Option<CharacterScope>, LibraryError> {
    let broad = broad_folder_scope_enabled(connection)?;
    resolve_character_scope_with(connection, asset_id, broad)
}

/// True when only the switched-off broad-folder rule keeps the image out of scope.
pub(super) fn broad_scope_switched_off(
    connection: &Connection,
    asset_id: &str,
) -> std::result::Result<bool, LibraryError> {
    Ok(!broad_folder_scope_enabled(connection)?
        && resolve_character_scope_with(connection, asset_id, true)?.is_some())
}

fn resolve_character_scope_with(
    connection: &Connection,
    asset_id: &str,
    broad: bool,
) -> std::result::Result<Option<CharacterScope>, LibraryError> {
    let classification_ids = connection
        .prepare(
            "SELECT classification_id FROM asset_classifications
             WHERE asset_id=?1 ORDER BY classification_id",
        )?
        .query_map([asset_id], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let [classification_id] = classification_ids.as_slice() else {
        return Ok(None);
    };

    let folder_excluded: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM character_excluded_folders WHERE id=?1)",
        [classification_id],
        |row| row.get(0),
    )?;
    if folder_excluded {
        return Ok(None);
    }

    let in_originals: bool = connection.query_row(
        "WITH RECURSIVE lineage(id,parent_id) AS (
            SELECT id,parent_id FROM classification_entries WHERE id=?1
            UNION ALL
            SELECT c.id,c.parent_id FROM classification_entries c JOIN lineage p ON c.id=p.parent_id
         )
         SELECT EXISTS(
            SELECT 1 FROM lineage l JOIN classification_roles r ON r.classification_id=l.id
            WHERE r.role='originals'
         )",
        [classification_id],
        |row| row.get(0),
    )?;
    if in_originals {
        return Ok(None);
    }

    let series: Option<(String, bool)> = connection
        .query_row(
            "WITH RECURSIVE lineage(id,parent_id,depth) AS (
                SELECT id,parent_id,0 FROM classification_entries WHERE id=?1
                UNION ALL
                SELECT c.id,c.parent_id,p.depth+1
                FROM classification_entries c JOIN lineage p ON c.id=p.parent_id
             )
             SELECT l.id,s.auto_classify FROM lineage l
             JOIN character_series s ON s.classification_id=l.id
             ORDER BY l.depth,l.id LIMIT 1",
            [classification_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    // An explicit series remains authoritative, including its opt-out. Only a
    // source without a registered ancestor may infer among descendant series.
    let candidates = match series {
        Some((id, true)) => vec![id],
        Some((_, false)) => return Ok(None),
        None if !broad => return Ok(None),
        None => connection
            .prepare(
                "WITH RECURSIVE descendants(id) AS (
                SELECT id FROM classification_entries WHERE id=?1
                UNION SELECT c.id FROM classification_entries c JOIN descendants d ON c.parent_id=d.id
             )
             SELECT s.classification_id FROM character_series s
             JOIN descendants d ON d.id=s.classification_id
             WHERE s.auto_classify=1 AND s.classification_id NOT IN (SELECT id FROM character_excluded_folders) ORDER BY s.classification_id",
            )?
            .query_map([classification_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?,
    };
    let mut series_classification_ids = Vec::new();
    for id in candidates {
        let excluded: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM character_series_asset_exclusions WHERE series_id=?1 AND asset_id=?2)",
            params![id, asset_id], |row| row.get(0),
        )?;
        if !excluded
            && !super::classification::classification_in_role_scope(connection, &id, "originals")?
        {
            series_classification_ids.push(id);
        }
    }
    Ok((!series_classification_ids.is_empty()).then_some(CharacterScope {
        series_classification_ids,
    }))
}
