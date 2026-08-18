use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::collection::{collection_by_id, collection_type_str, normalized_name};
use super::collection_source::set_collection_source_root;
use super::error::LibraryError;
use super::models::CollectionType;
use super::Library;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMigrationReport {
    pub scanned: u64,
    pub created: u64,
    pub updated: u64,
    pub skipped: u64,
    pub errors: Vec<BookMigrationError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMigrationError {
    pub folder: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImportPlan {
    pub root: String,
    pub entries: Vec<BookImportEntry>,
    pub skipped: Vec<BookMigrationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookImportEntry {
    pub folder: String,
    pub relative_path: String,
    pub collection_type: CollectionType,
    pub name: String,
    pub year: Option<i64>,
    pub author: Option<String>,
    pub director: Option<String>,
    pub my_score: Option<i64>,
    pub genres: Option<String>,
    pub overview: Option<String>,
    pub external_id: Option<String>,
    pub external_source: Option<String>,
}

impl Library {
    pub fn inspect_book_import(&self, root: &str) -> Result<BookImportPlan, LibraryError> {
        let root_path = PathBuf::from(root);
        if !root_path.is_dir() {
            return Err(LibraryError::ReadMedia {
                path: root_path,
                source: std::io::Error::new(std::io::ErrorKind::NotFound, "book root not found"),
            });
        }
        let mut entries = Vec::new();
        let mut skipped = Vec::new();
        let connection = self.connection()?;
        let dir_entries = fs::read_dir(&root_path).map_err(|source| LibraryError::ReadMedia {
            path: root_path.clone(),
            source,
        })?;
        for entry in dir_entries {
            let entry = entry.map_err(|source| LibraryError::ReadMedia {
                path: root_path.clone(),
                source,
            })?;
            let file_type = entry
                .file_type()
                .map_err(|source| LibraryError::ReadMedia {
                    path: entry.path(),
                    source,
                })?;
            if !file_type.is_dir() {
                continue;
            }
            let folder_name = entry.file_name().to_string_lossy().into_owned();
            if folder_name.starts_with('.') {
                continue;
            }
            match parse_info_txt(&entry.path()) {
                Ok(Some(parsed)) => {
                    if collection_exists_by_name(&connection, &parsed.name)? {
                        skipped.push(BookMigrationError {
                            folder: folder_name,
                            message: "collection with same name already exists".into(),
                        });
                        continue;
                    }
                    entries.push(BookImportEntry {
                        folder: folder_name.clone(),
                        relative_path: relative_path_for(&root_path, &entry.path()),
                        collection_type: parsed.collection_type,
                        name: parsed.name,
                        year: parsed.year,
                        author: parsed.author,
                        director: parsed.director,
                        my_score: parsed.my_score,
                        genres: parsed.genres,
                        overview: parsed.overview,
                        external_id: parsed.external_id,
                        external_source: parsed.external_source,
                    });
                }
                Ok(None) => {
                    skipped.push(BookMigrationError {
                        folder: folder_name,
                        message: "no info.txt found".into(),
                    });
                }
                Err(message) => {
                    skipped.push(BookMigrationError {
                        folder: folder_name,
                        message,
                    });
                }
            }
        }
        Ok(BookImportPlan {
            root: root_path.to_string_lossy().into_owned(),
            entries,
            skipped,
        })
    }

    pub fn import_book_collections(&self, root: &str) -> Result<BookMigrationReport, LibraryError> {
        let plan = self.inspect_book_import(root)?;
        let connection = self.connection()?;
        set_collection_source_root(&connection, Some(root))?;
        let mut report = BookMigrationReport {
            scanned: plan.entries.len() as u64 + plan.skipped.len() as u64,
            created: 0,
            updated: 0,
            skipped: plan.skipped.len() as u64,
            errors: plan.skipped,
        };
        for entry in plan.entries {
            match upsert_collection(&connection, &entry) {
                Ok(true) => report.created += 1,
                Ok(false) => report.updated += 1,
                Err(message) => report.errors.push(BookMigrationError {
                    folder: entry.folder,
                    message,
                }),
            }
        }
        Ok(report)
    }
}

fn collection_exists_by_name(
    connection: &rusqlite::Connection,
    name: &str,
) -> Result<bool, LibraryError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM collections WHERE name = ?1 COLLATE NOCASE)",
        params![name],
        |row| row.get(0),
    )?;
    Ok(exists)
}

fn upsert_collection(
    connection: &rusqlite::Connection,
    entry: &BookImportEntry,
) -> Result<bool, String> {
    let name = normalized_name(entry.name.clone()).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let type_str = collection_type_str(entry.collection_type);
    let external_synced_at: Option<String> = if entry.external_id.is_some() {
        Some(now.clone())
    } else {
        None
    };
    connection
        .execute(
            "INSERT INTO collections (
                id, name, description, type, cover_asset_id,
                year, author, director, external_score, my_score,
                genres, overview, external_id, external_source, external_synced_at,
                showcase, external_metadata_json, created_at, updated_at, source_path
             ) VALUES (?1, ?2, NULL, ?3, NULL,
                ?4, ?5, ?6, NULL, ?7,
                ?8, ?9, ?10, ?11, ?12,
                0, NULL, ?13, ?13, ?14)",
            params![
                id,
                name,
                type_str,
                entry.year,
                entry.author,
                entry.director,
                entry.my_score,
                entry.genres,
                entry.overview,
                entry.external_id,
                entry.external_source,
                external_synced_at,
                now,
                entry.relative_path
            ],
        )
        .map_err(|e| map_duplicate_name_err(e, &entry.name))?;
    let _ = collection_by_id(connection, &id).map_err(|e| e.to_string())?;
    Ok(true)
}

fn map_duplicate_name_err(e: rusqlite::Error, name: &str) -> String {
    match e {
        rusqlite::Error::SqliteFailure(ref fail, _) if fail.code == rusqlite::ErrorCode::ConstraintViolation => {
            format!("a collection named '{name}' already exists")
        }
        other => other.to_string(),
    }
}

struct ParsedInfo {
    name: String,
    collection_type: CollectionType,
    year: Option<i64>,
    author: Option<String>,
    director: Option<String>,
    my_score: Option<i64>,
    genres: Option<String>,
    overview: Option<String>,
    external_id: Option<String>,
    external_source: Option<String>,
}

fn parse_info_txt(folder: &Path) -> Result<Option<ParsedInfo>, String> {
    let info_path = folder.join("info.txt");
    if !info_path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&info_path)
        .map_err(|e| format!("failed to read info.txt: {e}"))?;
    let fields = parse_key_value(&raw);
    let name = match first_value(&fields, "Title") {
        Some(name) => trim_field(name),
        None => match folder_name(folder) {
            Some(name) => trim_field(&name),
            None => return Err("missing Title and folder name".into()),
        },
    };
    if name.is_empty() {
        return Err("empty name".into());
    }
    let collection_type = match first_value(&fields, "Type").map(|v| v.trim().to_lowercase()) {
        Some(ref t) if t == "game" => CollectionType::Game,
        Some(ref t) if t == "movie" => CollectionType::Movie,
        Some(ref t) if t == "gacha" => CollectionType::Game,
        _ => CollectionType::Manga,
    };
    let year = first_value(&fields, "Publication Year")
        .and_then(|v| v.trim().parse::<i64>().ok());
    let author = first_value(&fields, "Authors").map(|v| trim_field(&v));
    let director = first_value(&fields, "Director").map(|v| trim_field(&v));
    let my_score = first_value(&fields, "Rating").and_then(|v| {
        let v = v.trim();
        if v.eq_ignore_ascii_case("unknown") || v.is_empty() {
            None
        } else {
            v.parse::<i64>().ok()
        }
    });
    let genres = first_value(&fields, "Genres").map(|v| trim_field(&v));
    let overview = first_value(&fields, "Overview").map(|v| trim_field(&v));
    let (external_id, external_source) = pick_external_id(&fields);
    Ok(Some(ParsedInfo {
        name,
        collection_type,
        year,
        author,
        director,
        my_score,
        genres,
        overview,
        external_id,
        external_source,
    }))
}

fn pick_external_id(fields: &[(String, String)]) -> (Option<String>, Option<String>) {
    if let Some(id) = first_value(fields, "TMDB ID") {
        return (Some(id.trim().to_string()), Some("tmdb".into()));
    }
    if let Some(id) = first_value(fields, "Steam App ID") {
        return (Some(id.trim().to_string()), Some("steam".into()));
    }
    if let Some(id) = first_value(fields, "IGDB ID") {
        return (Some(id.trim().to_string()), Some("igdb".into()));
    }
    if let Some(id) = first_value(fields, "MangaDex ID") {
        return (Some(id.trim().to_string()), Some("mangadex".into()));
    }
    (None, None)
}

fn first_value<'a>(fields: &'a [(String, String)], key: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
}

fn trim_field(value: &str) -> String {
    value.trim().trim_matches('"').to_string()
}

fn folder_name(path: &Path) -> Option<String> {
    path.file_name().map(|n| n.to_string_lossy().into_owned())
}

fn relative_path_for(root: &Path, folder: &Path) -> String {
    folder
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| folder.to_string_lossy().into_owned())
}

fn parse_key_value(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_string();
            let value = value.trim().to_string();
            if !key.is_empty() {
                out.push((key, value));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_manga_info_txt() {
        let raw = "Title: 나루토\n\
                   Authors: Kishimoto Masashi\n\
                   Publication Year: 1999\n\
                   Rating: 3\n\
                   MangaDex ID: 6b1eb93e-473a-4ab3-9922-1a66d2a29a4a\n";
        let fields = parse_key_value(raw);
        assert_eq!(first_value(&fields, "Title"), Some("나루토"));
        assert_eq!(first_value(&fields, "MangaDex ID"), Some("6b1eb93e-473a-4ab3-9922-1a66d2a29a4a"));
        let (id, src) = pick_external_id(&fields);
        assert_eq!(id.as_deref(), Some("6b1eb93e-473a-4ab3-9922-1a66d2a29a4a"));
        assert_eq!(src.as_deref(), Some("mangadex"));
    }

    #[test]
    fn parses_game_info_txt_with_steam_and_igdb() {
        let raw = "Steam App ID: 1245620\n\
                   IGDB ID: 119133\n\
                   Title: 엘든 링\n\
                   Authors: FromSoftware\n\
                   Publication Year: 2022\n\
                   Rating: 5\n\
                   Type: game\n";
        let fields = parse_key_value(raw);
        assert_eq!(first_value(&fields, "Type"), Some("game"));
        let (id, src) = pick_external_id(&fields);
        assert_eq!(id.as_deref(), Some("1245620"));
        assert_eq!(src.as_deref(), Some("steam"));
    }

    #[test]
    fn parses_movie_info_txt() {
        let raw = "Title: 극장판 체인소 맨: 레제편\n\
                   Publication Year: 2025\n\
                   Rating: 4\n\
                   Type: movie\n\
                   TMDB ID: 1218925\n\
                   Director: 후지모토 타츠키\n";
        let fields = parse_key_value(raw);
        assert_eq!(first_value(&fields, "Type"), Some("movie"));
        let (id, src) = pick_external_id(&fields);
        assert_eq!(id.as_deref(), Some("1218925"));
        assert_eq!(src.as_deref(), Some("tmdb"));
    }

    #[test]
    fn treats_missing_type_as_manga() {
        let raw = "Title: Chainsaw Man\nAuthors: Fujimoto Tatsuki\n";
        let fields = parse_key_value(raw);
        let parsed = parse_info_txt(Path::new("Chainsaw Man")).unwrap();
        assert!(parsed.is_none());
        let _ = fields;
    }

    #[test]
    fn rating_unknown_yields_none() {
        let raw = "Title: x\nRating: Unknown\n";
        let fields = parse_key_value(raw);
        let rating = first_value(&fields, "Rating").and_then(|v| {
            let v = v.trim();
            if v.eq_ignore_ascii_case("unknown") || v.is_empty() {
                None
            } else {
                v.parse::<i64>().ok()
            }
        });
        assert!(rating.is_none());
    }
}