use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::collection::{collection_type_str, normalized_name};
use super::collection_source::{collection_source_root, set_collection_source_root};
use super::error::LibraryError;
use super::models::{CollectionType, ExternalBindingInput};
use super::Library;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LegacyCollectionKind {
    Game,
    Manga,
    Movie,
    Gacha,
}

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
    pub legacy_kind: Option<LegacyCollectionKind>,
    pub name: String,
    pub year: Option<i64>,
    pub author: Option<String>,
    pub director: Option<String>,
    pub my_score: Option<i64>,
    pub genres: Option<String>,
    pub overview: Option<String>,
    pub external_bindings: Vec<BookExternalBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookExternalBinding {
    pub provider: String,
    pub external_id: String,
}

impl Library {
    pub(crate) fn backfill_legacy_collection_kinds(&self) -> Result<u64, LibraryError> {
        let connection = self.connection()?;
        let Some(root) = collection_source_root(&connection)? else {
            return Ok(0);
        };
        let Ok(canonical_root) = fs::canonicalize(&root) else {
            return Ok(0);
        };
        let rows = pending_legacy_sources(&connection)?;
        let mut updated = 0;
        for (id, source_path) in rows {
            let Ok(folder) = fs::canonicalize(canonical_root.join(source_path)) else {
                continue;
            };
            if !folder.starts_with(&canonical_root) {
                continue;
            }
            let Ok(Some(parsed)) = parse_info_txt(&folder) else {
                continue;
            };
            let Some(kind) = parsed.legacy_kind else {
                continue;
            };
            updated += connection.execute(
                "UPDATE collections SET legacy_kind = ?1 WHERE id = ?2 AND legacy_kind IS NULL",
                params![legacy_kind_str(kind), id],
            )? as u64;
        }
        Ok(updated)
    }

    pub fn inspect_book_import(&self, root: &str) -> Result<BookImportPlan, LibraryError> {
        let mut plan = scan_book_import(Path::new(root))?;
        let connection = self.connection()?;
        let mut pending = Vec::new();
        for entry in plan.entries {
            if collection_exists_by_name(&connection, &entry.name)? {
                plan.skipped.push(BookMigrationError {
                    folder: entry.folder,
                    message: "collection with same name already exists".into(),
                });
            } else {
                pending.push(entry);
            }
        }
        plan.entries = pending;
        Ok(plan)
    }

    pub fn import_book_collections(&self, root: &str) -> Result<BookMigrationReport, LibraryError> {
        let plan = scan_book_import(Path::new(root))?;
        self.apply_book_import_plan(&plan)
    }

    pub(crate) fn apply_book_import_plan(
        &self,
        plan: &BookImportPlan,
    ) -> Result<BookMigrationReport, LibraryError> {
        let connection = self.connection()?;
        set_collection_source_root(&connection, Some(&plan.root))?;
        let mut report = BookMigrationReport {
            scanned: plan.entries.len() as u64 + plan.skipped.len() as u64,
            created: 0,
            updated: 0,
            skipped: plan.skipped.len() as u64,
            errors: plan.skipped.clone(),
        };
        for entry in &plan.entries {
            if collection_exists_by_name(&connection, &entry.name)? {
                report.skipped += 1;
                report.errors.push(BookMigrationError {
                    folder: entry.folder.clone(),
                    message: "collection with same name already exists".into(),
                });
                continue;
            }
            match upsert_collection(&connection, &entry) {
                Ok(true) => report.created += 1,
                Ok(false) => report.updated += 1,
                Err(message) => report.errors.push(BookMigrationError {
                    folder: entry.folder.clone(),
                    message,
                }),
            }
        }
        Ok(report)
    }
}

pub(crate) fn scan_book_import(root: &Path) -> Result<BookImportPlan, LibraryError> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err(LibraryError::ReadMedia {
            path: root_path,
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "book root not found"),
        });
    }
    let mut entries = Vec::new();
    let mut skipped = Vec::new();
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
            Ok(Some(parsed)) => entries.push(BookImportEntry {
                folder: folder_name,
                relative_path: relative_path_for(&root_path, &entry.path()),
                collection_type: parsed.collection_type,
                legacy_kind: parsed.legacy_kind,
                name: parsed.name,
                year: parsed.year,
                author: parsed.author,
                director: parsed.director,
                my_score: parsed.my_score,
                genres: parsed.genres,
                overview: parsed.overview,
                external_bindings: parsed.external_bindings,
            }),
            Ok(None) => skipped.push(BookMigrationError {
                folder: folder_name,
                message: "no info.txt found".into(),
            }),
            Err(message) => skipped.push(BookMigrationError {
                folder: folder_name,
                message,
            }),
        }
    }
    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.folder.cmp(&right.folder))
    });
    skipped.sort_by(|left, right| left.folder.cmp(&right.folder));
    Ok(BookImportPlan {
        root: root_path.to_string_lossy().into_owned(),
        entries,
        skipped,
    })
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
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO collections (
                id, name, description, type, cover_asset_id,
                year, author, director, external_score, my_score,
                genres, overview, showcase, created_at, updated_at, source_path, legacy_kind
             ) VALUES (?1, ?2, NULL, ?3, NULL,
                ?4, ?5, ?6, NULL, ?7,
                ?8, ?9, 0, ?10, ?10, ?11, ?12)",
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
                now,
                entry.relative_path,
                entry.legacy_kind.map(legacy_kind_str)
            ],
        )
        .map_err(|e| map_duplicate_name_err(e, &entry.name))?;
    for binding in &entry.external_bindings {
        super::external_binding::upsert_external_binding(
            &transaction,
            &id,
            ExternalBindingInput {
                provider: binding.provider.clone(),
                external_id: binding.external_id.clone(),
                provider_config_json: None,
                provider_data_json: None,
                last_synced_at: Some(now.clone()),
            },
            &now,
        )
        .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

fn map_duplicate_name_err(e: rusqlite::Error, name: &str) -> String {
    match e {
        rusqlite::Error::SqliteFailure(ref fail, _)
            if fail.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            format!("a collection named '{name}' already exists")
        }
        other => other.to_string(),
    }
}

struct ParsedInfo {
    name: String,
    collection_type: CollectionType,
    legacy_kind: Option<LegacyCollectionKind>,
    year: Option<i64>,
    author: Option<String>,
    director: Option<String>,
    my_score: Option<i64>,
    genres: Option<String>,
    overview: Option<String>,
    external_bindings: Vec<BookExternalBinding>,
}

fn pending_legacy_sources(
    connection: &rusqlite::Connection,
) -> Result<Vec<(String, String)>, LibraryError> {
    let mut statement = connection.prepare(
        "SELECT id, source_path FROM collections
         WHERE source_path IS NOT NULL AND legacy_kind IS NULL",
    )?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<(String, String)>, _>>()?;
    Ok(rows)
}

fn legacy_kind_str(kind: LegacyCollectionKind) -> &'static str {
    match kind {
        LegacyCollectionKind::Game => "game",
        LegacyCollectionKind::Manga => "manga",
        LegacyCollectionKind::Movie => "movie",
        LegacyCollectionKind::Gacha => "gacha",
    }
}

fn parse_info_txt(folder: &Path) -> Result<Option<ParsedInfo>, String> {
    let info_path = folder.join("info.txt");
    if !info_path.is_file() {
        return Ok(None);
    }
    let raw =
        fs::read_to_string(&info_path).map_err(|e| format!("failed to read info.txt: {e}"))?;
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
    let (collection_type, legacy_kind) =
        match first_value(&fields, "Type").map(|v| v.trim().to_lowercase()) {
            Some(t) if t == "game" => (CollectionType::Game, Some(LegacyCollectionKind::Game)),
            Some(t) if t == "manga" => (CollectionType::Manga, Some(LegacyCollectionKind::Manga)),
            Some(t) if t == "movie" => (CollectionType::Movie, Some(LegacyCollectionKind::Movie)),
            Some(t) if t == "gacha" => (CollectionType::Game, Some(LegacyCollectionKind::Gacha)),
            _ => (CollectionType::Manga, None),
        };
    let year = first_value(&fields, "Publication Year").and_then(|v| v.trim().parse::<i64>().ok());
    let author = first_value(&fields, "Authors").map(trim_field);
    let director = first_value(&fields, "Director").map(trim_field);
    let my_score = first_value(&fields, "Rating").and_then(|v| {
        let v = v.trim();
        if v.eq_ignore_ascii_case("unknown") || v.is_empty() {
            None
        } else {
            v.parse::<i64>().ok()
        }
    });
    let genres = first_value(&fields, "Genres").map(trim_field);
    let overview = first_value(&fields, "Overview").map(trim_field);
    let external_bindings = external_bindings(&fields);
    Ok(Some(ParsedInfo {
        name,
        collection_type,
        legacy_kind,
        year,
        author,
        director,
        my_score,
        genres,
        overview,
        external_bindings,
    }))
}

fn external_bindings(fields: &[(String, String)]) -> Vec<BookExternalBinding> {
    [
        ("TMDB ID", "tmdb"),
        ("Steam App ID", "steam"),
        ("IGDB ID", "igdb"),
        ("MangaDex ID", "mangadex"),
    ]
    .into_iter()
    .filter_map(|(key, provider)| {
        let external_id = first_value(fields, key)?.trim();
        (!external_id.is_empty()).then(|| BookExternalBinding {
            provider: provider.into(),
            external_id: external_id.into(),
        })
    })
    .collect()
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
    fn backfills_safe_legacy_kinds_without_overwriting_or_guessing() {
        let source = tempfile::tempdir().unwrap();
        let gacha = source.path().join("gacha");
        fs::create_dir(&gacha).unwrap();
        fs::write(gacha.join("info.txt"), "Title: Gacha\nType: gacha\n").unwrap();
        let outside = source.path().parent().unwrap().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("info.txt"), "Title: Outside\nType: gacha\n").unwrap();

        let target = tempfile::tempdir().unwrap();
        let library = Library::open(target.path()).unwrap();
        library
            .set_collection_source_root(Some(source.path().to_string_lossy().as_ref()))
            .unwrap();
        let connection = library.connection().unwrap();
        for (id, source_path, legacy_kind) in [
            ("gacha-1", Some("gacha"), None),
            ("missing-1", Some("missing"), None),
            ("existing-1", Some("gacha"), Some("game")),
            ("unsafe-1", Some("../outside"), None),
        ] {
            connection
                .execute(
                    "INSERT INTO collections (id, name, type, created_at, updated_at, source_path, legacy_kind)
                     VALUES (?1, ?2, 'game', '2026-01-01', '2026-01-01', ?3, ?4)",
                    rusqlite::params![id, id, source_path, legacy_kind],
                )
                .unwrap();
        }
        drop(connection);

        assert_eq!(library.backfill_legacy_collection_kinds().unwrap(), 1);
        let stored = |id: &str| {
            library
                .connection()
                .unwrap()
                .query_row(
                    "SELECT legacy_kind FROM collections WHERE id = ?1",
                    [id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap()
        };
        assert_eq!(stored("gacha-1").as_deref(), Some("gacha"));
        assert_eq!(library.backfill_legacy_collection_kinds().unwrap(), 0);
        assert_eq!(stored("missing-1"), None);
        assert_eq!(stored("existing-1").as_deref(), Some("game"));
        assert_eq!(stored("unsafe-1"), None);
    }

    #[test]
    fn parses_manga_info_txt() {
        let raw = "Title: 나루토\n\
                   Authors: Kishimoto Masashi\n\
                   Publication Year: 1999\n\
                   Rating: 3\n\
                   MangaDex ID: 6b1eb93e-473a-4ab3-9922-1a66d2a29a4a\n";
        let fields = parse_key_value(raw);
        assert_eq!(first_value(&fields, "Title"), Some("나루토"));
        assert_eq!(
            first_value(&fields, "MangaDex ID"),
            Some("6b1eb93e-473a-4ab3-9922-1a66d2a29a4a")
        );
        assert_eq!(
            external_bindings(&fields),
            vec![BookExternalBinding {
                provider: "mangadex".into(),
                external_id: "6b1eb93e-473a-4ab3-9922-1a66d2a29a4a".into(),
            }]
        );
    }

    #[test]
    fn parses_every_game_provider_identity() {
        let raw = "Steam App ID: 1245620\n\
                   IGDB ID: 119133\n\
                   Title: 엘든 링\n\
                   Authors: FromSoftware\n\
                   Publication Year: 2022\n\
                   Rating: 5\n\
                   Type: game\n";
        let fields = parse_key_value(raw);
        assert_eq!(first_value(&fields, "Type"), Some("game"));
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("info.txt"), raw).unwrap();
        let parsed = parse_info_txt(temp.path()).unwrap().unwrap();
        assert_eq!(parsed.collection_type, CollectionType::Game);
        assert_eq!(parsed.legacy_kind, Some(LegacyCollectionKind::Game));
        assert_eq!(
            external_bindings(&fields),
            vec![
                BookExternalBinding {
                    provider: "steam".into(),
                    external_id: "1245620".into(),
                },
                BookExternalBinding {
                    provider: "igdb".into(),
                    external_id: "119133".into(),
                },
            ]
        );
    }

    #[test]
    fn binding_failure_rolls_back_collection_import() {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();
        let connection = library.connection().unwrap();
        let entry = BookImportEntry {
            folder: "Elden Ring".into(),
            relative_path: "Elden Ring".into(),
            collection_type: CollectionType::Game,
            legacy_kind: Some(LegacyCollectionKind::Game),
            name: "Elden Ring".into(),
            year: Some(2022),
            author: Some("FromSoftware".into()),
            director: None,
            my_score: None,
            genres: None,
            overview: None,
            external_bindings: vec![
                BookExternalBinding {
                    provider: "steam".into(),
                    external_id: "1245620".into(),
                },
                BookExternalBinding {
                    provider: "igdb".into(),
                    external_id: "   ".into(),
                },
            ],
        };

        assert!(upsert_collection(&connection, &entry).is_err());
        for table in ["collections", "collection_external_bindings"] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} should be rolled back");
        }
    }

    #[test]
    fn scans_without_a_library_and_applies_existing_names_idempotently() {
        let source = tempfile::tempdir().unwrap();
        let book = source.path().join("Blue Archive");
        fs::create_dir(&book).unwrap();
        fs::write(
            book.join("info.txt"),
            "Title: Blue Archive\nType: game\nPublication Year: 2021\n",
        )
        .unwrap();

        let plan = scan_book_import(source.path()).unwrap();

        assert_eq!(plan.entries.len(), 1);
        assert!(plan.skipped.is_empty());
        let target = tempfile::tempdir().unwrap();
        let library = Library::open(target.path()).unwrap();
        let first = library.apply_book_import_plan(&plan).unwrap();
        let before: (String, String, Option<i64>) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT id, created_at, year FROM collections WHERE name = 'Blue Archive'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let second = library.apply_book_import_plan(&plan).unwrap();
        let after: (String, String, Option<i64>) = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT id, created_at, year FROM collections WHERE name = 'Blue Archive'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!((first.created, first.skipped), (1, 0));
        assert_eq!((second.created, second.skipped), (0, 1));
        assert_eq!(before, after);
        assert_eq!(
            library
                .connection()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM collections", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
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
        assert_eq!(
            external_bindings(&fields),
            vec![BookExternalBinding {
                provider: "tmdb".into(),
                external_id: "1218925".into(),
            }]
        );
    }

    #[test]
    fn persists_gacha_legacy_kind_during_import() {
        let source = tempfile::tempdir().unwrap();
        let book = source.path().join("Gacha Work");
        fs::create_dir(&book).unwrap();
        fs::write(book.join("info.txt"), "Title: Gacha Work\nType: gacha\n").unwrap();
        let plan = scan_book_import(source.path()).unwrap();
        let target = tempfile::tempdir().unwrap();
        let library = Library::open(target.path()).unwrap();
        library.apply_book_import_plan(&plan).unwrap();
        let stored: Option<String> = library
            .connection()
            .unwrap()
            .query_row(
                "SELECT legacy_kind FROM collections WHERE name = 'Gacha Work'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored.as_deref(), Some("gacha"));
    }

    #[test]
    fn parses_gacha_type_as_game_with_legacy_provenance() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("info.txt"),
            "Title: Gacha Work\nType: gacha\n",
        )
        .unwrap();
        let parsed = parse_info_txt(temp.path()).unwrap().unwrap();
        assert_eq!(parsed.collection_type, CollectionType::Game);
        assert_eq!(parsed.legacy_kind, Some(LegacyCollectionKind::Gacha));
    }

    #[test]
    fn treats_missing_type_as_manga() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("info.txt"),
            "Title: Chainsaw Man\nAuthors: Fujimoto Tatsuki\n",
        )
        .unwrap();
        let parsed = parse_info_txt(temp.path()).unwrap().unwrap();
        assert_eq!(parsed.collection_type, CollectionType::Manga);
        assert_eq!(parsed.legacy_kind, None);
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
