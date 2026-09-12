use rusqlite::{params, Connection, OptionalExtension};

use super::LibraryError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CharacterScope {
    pub series_classification_ids: Vec<String>,
}

pub(super) fn resolve_character_scope(
    connection: &Connection,
    asset_id: &str,
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
