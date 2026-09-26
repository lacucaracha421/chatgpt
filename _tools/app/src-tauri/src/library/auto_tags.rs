//! 자동 태그 (automatic image tags). PC-only; nothing here is published to the server.
//!
//! An external tagger's output arrives as an import file written by
//! `character-runtime/auto_tags_export.py`: a small SQLite database with a `meta` table
//! (`format`, `version`, `model`), the tagger `vocabulary` (Danbooru name, category) and
//! `asset_tags` (asset id, tag, score). Tags are Danbooru names, so a different tagger with
//! the same naming can replace the output. Only one output is active: an import replaces
//! every machine row and the vocabulary in one transaction and never touches user edits.
//!
//! The effective tags of an asset are its machine tags minus edits in state `removed` plus
//! edits in state `added`. One edit row per asset and tag decides that tag for the asset,
//! so a removed tag stays removed after any later import. Korean labels and grouping live
//! in the desktop frontend's dictionary; this module only knows names and categories.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use chrono::Utc;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::error::LibraryError;
use super::models::AutoTagFilter;

pub(crate) const IMPORT_FORMAT: &str = "lakomics-auto-tags";
pub(crate) const IMPORT_VERSION: &str = "1";
/// Included plus excluded tags in one asset filter.
pub(crate) const MAX_FILTER_TAGS: usize = 8;
const MAX_TAG_CHARS: usize = 200;
const MAX_MODEL_CHARS: usize = 100;
const CATEGORIES: [&str; 6] = [
    "general",
    "character",
    "copyright",
    "artist",
    "meta",
    "rating",
];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutoTagSource {
    /// From the imported tagger output.
    Model,
    /// Added by the user to this asset.
    Added,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssetAutoTag {
    pub tag: String,
    pub category: String,
    /// The tagger score; `None` for a user-added tag the tagger did not emit.
    pub score: Option<f64>,
    pub source: AutoTagSource,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssetAutoTags {
    pub tags: Vec<AssetAutoTag>,
    /// The asset already has a confirmed character (accepted decision or reference), so
    /// guessed character tags are not shown.
    pub has_confirmed_character: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoTagVocabularyEntry {
    pub tag: String,
    pub category: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutoTagImportSummary {
    pub model: String,
    pub imported_at: String,
    /// The import file's name (not its path).
    pub source_name: String,
    pub tagged_assets: u64,
    pub tag_rows: u64,
    /// Asset ids in the file that are not in this library.
    pub skipped_assets: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutoTagEdit {
    /// Show the tag on this asset whatever the tagger says.
    Add,
    /// Hide the tag on this asset, now and after later imports.
    Remove,
    /// Forget the user's edit; the tagger output decides again.
    Reset,
}

fn invalid(message: &str) -> LibraryError {
    LibraryError::InvalidAutoTag(message.to_owned())
}

fn validate_tag(tag: &str) -> Result<(), LibraryError> {
    if tag.is_empty()
        || tag.trim() != tag
        || tag.chars().count() > MAX_TAG_CHARS
        || tag.chars().any(char::is_control)
    {
        return Err(invalid("태그 이름이 올바르지 않습니다"));
    }
    Ok(())
}

/// Guessed characters count only from this score, as in the inspector (`CHARACTER_MIN_SCORE`
/// in `autoTagModel.ts`); weaker character guesses stay stored but never match or count.
const CHARACTER_MIN_SCORE: f64 = 0.85;

/// Whether the machine row aliased `tagged` counts as carried.
fn machine_row_counts_sql(alias: &str) -> String {
    format!("({alias}.score >= {CHARACTER_MIN_SCORE} OR NOT EXISTS (SELECT 1 FROM auto_tag_vocabulary AS character_vocabulary WHERE character_vocabulary.tag = {alias}.tag AND character_vocabulary.category = 'character'))")
}

fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Whether `asset.id` effectively carries the tag: an edit row decides, else the tagger row.
fn carries_tag_sql(tag: &str) -> String {
    let literal = sql_literal(tag);
    format!(
        "COALESCE((SELECT auto_tag_edit.state = 'added' FROM asset_auto_tag_edits AS auto_tag_edit WHERE auto_tag_edit.asset_id = asset.id AND auto_tag_edit.tag = {literal}), EXISTS (SELECT 1 FROM asset_auto_tags AS auto_tag WHERE auto_tag.asset_id = asset.id AND auto_tag.tag = {literal} AND {counts}))",
        counts = machine_row_counts_sql("auto_tag")
    )
}

/// SQL conditions (each starting with ` AND `) for an asset listing whose asset alias is
/// `asset`. Tags are validated and quoted as string literals so the listing statements keep
/// their positional parameters.
pub(crate) fn filter_conditions(filter: Option<&AutoTagFilter>) -> Result<String, LibraryError> {
    let Some(filter) = filter else {
        return Ok(String::new());
    };
    if filter.include.len() + filter.exclude.len() > MAX_FILTER_TAGS {
        return Err(invalid("자동 태그 필터는 8개까지 쓸 수 있습니다"));
    }
    let mut conditions = String::new();
    for tag in &filter.include {
        validate_tag(tag)?;
        conditions.push_str(" AND ");
        conditions.push_str(&carries_tag_sql(tag));
    }
    for tag in &filter.exclude {
        validate_tag(tag)?;
        conditions.push_str(" AND NOT ");
        conditions.push_str(&carries_tag_sql(tag));
    }
    Ok(conditions)
}

fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn ensure_asset(connection: &Connection, asset_id: &str) -> Result<(), LibraryError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)",
        [asset_id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(LibraryError::AssetNotFound)
    }
}

pub(crate) fn asset_tags(
    connection: &Connection,
    asset_id: &str,
) -> Result<AssetAutoTags, LibraryError> {
    ensure_asset(connection, asset_id)?;
    let mut statement = connection.prepare(
        "SELECT effective.tag, COALESCE(vocabulary.category, 'general'), effective.score, effective.source
         FROM (
           SELECT tagged.tag AS tag, tagged.score AS score, 'model' AS source FROM asset_auto_tags AS tagged
           WHERE tagged.asset_id = ?1
             AND NOT EXISTS (SELECT 1 FROM asset_auto_tag_edits AS edit WHERE edit.asset_id = ?1 AND edit.tag = tagged.tag)
           UNION ALL
           SELECT edit.tag, (SELECT tagged.score FROM asset_auto_tags AS tagged WHERE tagged.asset_id = ?1 AND tagged.tag = edit.tag), 'added'
           FROM asset_auto_tag_edits AS edit WHERE edit.asset_id = ?1 AND edit.state = 'added'
         ) AS effective
         LEFT JOIN auto_tag_vocabulary AS vocabulary ON vocabulary.tag = effective.tag
         ORDER BY effective.score IS NULL, effective.score DESC, effective.tag",
    )?;
    let rows = statement.query_map([asset_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<f64>>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut tags = Vec::new();
    for row in rows {
        let (tag, category, score, source) = row?;
        tags.push(AssetAutoTag {
            tag,
            category,
            score,
            source: if source == "added" {
                AutoTagSource::Added
            } else {
                AutoTagSource::Model
            },
        });
    }
    // The same membership sources the character hub uses: a current accepted decision,
    // a reference image or a learned reference.
    let has_confirmed_character: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM character_relations WHERE asset_id = ?1)
             OR EXISTS (SELECT 1 FROM character_references WHERE asset_id = ?1)
             OR EXISTS (SELECT 1 FROM character_learned_references WHERE asset_id = ?1)",
        [asset_id],
        |row| row.get(0),
    )?;
    Ok(AssetAutoTags {
        tags,
        has_confirmed_character,
    })
}

/// Every vocabulary tag and every tag in use, with effective counts over normal assets.
/// Library counts are read from here (cached by the frontend), not per asset: summing the
/// counts of one asset's tags walks most of the tag index.
pub(crate) fn vocabulary(
    connection: &Connection,
) -> Result<Vec<AutoTagVocabularyEntry>, LibraryError> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    {
        let mut statement = connection.prepare(&format!(
            "SELECT tagged.tag, COUNT(*) FROM asset_auto_tags AS tagged
             JOIN assets AS asset ON asset.id = tagged.asset_id AND asset.status = 'normal'
             WHERE {}
             GROUP BY tagged.tag",
            machine_row_counts_sql("tagged")
        ))?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (tag, count) = row?;
            counts.insert(tag, count);
        }
        // Edits are few: correct the machine counts per edited tag.
        let mut statement = connection.prepare(&format!(
            "SELECT edit.tag,
                    SUM(CASE WHEN edit.state = 'added' AND tagged.asset_id IS NULL THEN 1
                             WHEN edit.state = 'removed' AND tagged.asset_id IS NOT NULL THEN -1 ELSE 0 END)
             FROM asset_auto_tag_edits AS edit
             JOIN assets AS asset ON asset.id = edit.asset_id AND asset.status = 'normal'
             LEFT JOIN asset_auto_tags AS tagged ON tagged.asset_id = edit.asset_id AND tagged.tag = edit.tag AND {}
             GROUP BY edit.tag",
            machine_row_counts_sql("tagged")
        ))?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (tag, delta) = row?;
            *counts.entry(tag).or_insert(0) += delta;
        }
    }
    let mut entries = Vec::with_capacity(counts.len().max(1024));
    let mut seen = HashSet::new();
    let mut statement = connection.prepare("SELECT tag, category FROM auto_tag_vocabulary")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (tag, category) = row?;
        let count = counts.get(&tag).copied().unwrap_or(0);
        seen.insert(tag.clone());
        entries.push(AutoTagVocabularyEntry {
            tag,
            category,
            count: u64::try_from(count.max(0)).unwrap_or(0),
        });
    }
    for (tag, count) in counts {
        if !seen.contains(&tag) && count > 0 {
            entries.push(AutoTagVocabularyEntry {
                tag,
                category: "general".to_owned(),
                count: u64::try_from(count).unwrap_or(0),
            });
        }
    }
    entries.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.tag.cmp(&right.tag))
    });
    Ok(entries)
}

pub(crate) fn edit_tag(
    connection: &Connection,
    asset_id: &str,
    tag: &str,
    edit: AutoTagEdit,
    now_utc: &str,
) -> Result<(), LibraryError> {
    validate_tag(tag)?;
    ensure_asset(connection, asset_id)?;
    match edit {
        AutoTagEdit::Reset => {
            connection.execute(
                "DELETE FROM asset_auto_tag_edits WHERE asset_id = ?1 AND tag = ?2",
                params![asset_id, tag],
            )?;
        }
        AutoTagEdit::Add | AutoTagEdit::Remove => {
            if edit == AutoTagEdit::Add {
                let known: bool = connection.query_row(
                    "SELECT EXISTS (SELECT 1 FROM auto_tag_vocabulary WHERE tag = ?2)
                         OR EXISTS (SELECT 1 FROM asset_auto_tags WHERE asset_id = ?1 AND tag = ?2)
                         OR EXISTS (SELECT 1 FROM asset_auto_tag_edits WHERE asset_id = ?1 AND tag = ?2)",
                    params![asset_id, tag],
                    |row| row.get(0),
                )?;
                if !known {
                    return Err(invalid("자동 태그 목록에 없는 태그입니다"));
                }
            }
            let state = if edit == AutoTagEdit::Add {
                "added"
            } else {
                "removed"
            };
            connection.execute(
                "INSERT INTO asset_auto_tag_edits (asset_id, tag, state, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(asset_id, tag) DO UPDATE SET state = excluded.state, created_at = excluded.created_at",
                params![asset_id, tag, state, now_utc],
            )?;
        }
    }
    Ok(())
}

pub(crate) fn import_summary(
    connection: &Connection,
) -> Result<Option<AutoTagImportSummary>, LibraryError> {
    connection
        .query_row(
            "SELECT model, imported_at, source_name, tagged_assets, tag_rows, skipped_assets FROM auto_tag_import WHERE singleton = 1",
            [],
            |row| {
                Ok(AutoTagImportSummary {
                    model: row.get(0)?,
                    imported_at: row.get(1)?,
                    source_name: row.get(2)?,
                    tagged_assets: row.get::<_, i64>(3)?.max(0) as u64,
                    tag_rows: row.get::<_, i64>(4)?.max(0) as u64,
                    skipped_assets: row.get::<_, i64>(5)?.max(0) as u64,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn import_error(message: impl Into<String>) -> LibraryError {
    LibraryError::InvalidAutoTag(message.into())
}

fn read_meta(source: &Connection, key: &str) -> Result<Option<String>, LibraryError> {
    source
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|_| import_error("자동 태그 파일 형식이 아닙니다"))
}

/// Replace the active tagger output with the file's content in one transaction.
/// User edits are kept; rows for assets that are not in this library are skipped.
pub(crate) fn import_file(
    connection: &Connection,
    path: &Path,
    now_utc: &str,
) -> Result<AutoTagImportSummary, LibraryError> {
    let source = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| import_error("자동 태그 파일을 열 수 없습니다"))?;
    if read_meta(&source, "format")?.as_deref() != Some(IMPORT_FORMAT) {
        return Err(import_error("자동 태그 파일 형식이 아닙니다"));
    }
    if read_meta(&source, "version")?.as_deref() != Some(IMPORT_VERSION) {
        return Err(import_error("지원하지 않는 자동 태그 파일 버전입니다"));
    }
    let model = read_meta(&source, "model")?
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty() && model.chars().count() <= MAX_MODEL_CHARS)
        .ok_or_else(|| import_error("자동 태그 파일에 모델 이름이 없습니다"))?;
    let source_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let library_assets: HashSet<String> = {
        let mut statement = connection.prepare("SELECT id FROM assets")?;
        let ids = statement.query_map([], |row| row.get::<_, String>(0))?;
        ids.collect::<Result<_, _>>()?
    };

    let transaction = connection.unchecked_transaction()?;
    transaction.execute("DELETE FROM asset_auto_tags", [])?;
    transaction.execute("DELETE FROM auto_tag_vocabulary", [])?;
    {
        let mut insert = transaction.prepare(
            "INSERT OR REPLACE INTO auto_tag_vocabulary (tag, category) VALUES (?1, ?2)",
        )?;
        let mut rows = source
            .prepare("SELECT tag, category FROM vocabulary")
            .map_err(|_| import_error("자동 태그 파일에 태그 목록이 없습니다"))?;
        let mut rows = rows.query([])?;
        while let Some(row) = rows.next()? {
            let tag: String = row.get(0)?;
            let category: String = row.get(1)?;
            validate_tag(&tag)
                .map_err(|_| import_error(format!("태그 이름이 올바르지 않습니다: {tag}")))?;
            if !CATEGORIES.contains(&category.as_str()) {
                return Err(import_error(format!(
                    "알 수 없는 태그 종류입니다: {category}"
                )));
            }
            insert.execute(params![tag, category])?;
        }
    }
    let mut tagged = HashSet::new();
    let mut skipped = HashSet::new();
    let mut tag_rows = 0_u64;
    {
        let mut insert = transaction.prepare(
            "INSERT OR REPLACE INTO asset_auto_tags (asset_id, tag, score) VALUES (?1, ?2, ?3)",
        )?;
        let mut rows = source
            .prepare("SELECT asset_id, tag, score FROM asset_tags")
            .map_err(|_| import_error("자동 태그 파일에 에셋 태그가 없습니다"))?;
        let mut rows = rows.query([])?;
        while let Some(row) = rows.next()? {
            let asset_id: String = row.get(0)?;
            let tag: String = row.get(1)?;
            let score: f64 = row.get(2)?;
            if !library_assets.contains(&asset_id) {
                skipped.insert(asset_id);
                continue;
            }
            validate_tag(&tag)
                .map_err(|_| import_error(format!("태그 이름이 올바르지 않습니다: {tag}")))?;
            if !(0.0..=1.0).contains(&score) {
                return Err(import_error("태그 점수가 0과 1 사이가 아닙니다"));
            }
            insert.execute(params![asset_id, tag, score])?;
            tagged.insert(asset_id);
            tag_rows += 1;
        }
    }
    let summary = AutoTagImportSummary {
        model,
        imported_at: now_utc.to_owned(),
        source_name,
        tagged_assets: tagged.len() as u64,
        tag_rows,
        skipped_assets: skipped.len() as u64,
    };
    transaction.execute(
        "INSERT INTO auto_tag_import (singleton, model, imported_at, source_name, tagged_assets, tag_rows, skipped_assets)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(singleton) DO UPDATE SET model = excluded.model, imported_at = excluded.imported_at,
           source_name = excluded.source_name, tagged_assets = excluded.tagged_assets,
           tag_rows = excluded.tag_rows, skipped_assets = excluded.skipped_assets",
        params![
            summary.model,
            summary.imported_at,
            summary.source_name,
            summary.tagged_assets as i64,
            summary.tag_rows as i64,
            summary.skipped_assets as i64,
        ],
    )?;
    transaction.commit()?;
    Ok(summary)
}

impl super::Library {
    pub fn asset_auto_tags(&self, asset_id: &str) -> Result<AssetAutoTags, LibraryError> {
        asset_tags(&*self.connection()?, asset_id)
    }

    pub fn auto_tag_vocabulary(&self) -> Result<Vec<AutoTagVocabularyEntry>, LibraryError> {
        vocabulary(&*self.connection()?)
    }

    pub fn edit_asset_auto_tag(
        &self,
        asset_id: &str,
        tag: &str,
        edit: AutoTagEdit,
    ) -> Result<(), LibraryError> {
        edit_tag(&*self.connection()?, asset_id, tag, edit, &now_utc())
    }

    pub fn auto_tag_import_summary(&self) -> Result<Option<AutoTagImportSummary>, LibraryError> {
        import_summary(&*self.connection()?)
    }

    pub fn import_auto_tags(&self, path: &Path) -> Result<AutoTagImportSummary, LibraryError> {
        import_file(&*self.connection()?, path, &now_utc())
    }
}
