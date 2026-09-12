use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use app_lib::library::{
    legacy_migration::{inspect_legacy_migration, LegacyMigrationPaths, LegacyMigrationPlan},
    Library,
};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    DryRun,
    Execute,
}

#[derive(Debug, PartialEq, Eq)]
struct Config {
    library: PathBuf,
    legacy_root: PathBuf,
    primary_metadata: PathBuf,
    fallback_metadata: PathBuf,
    mode: Mode,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanSummary<'a> {
    mode: &'static str,
    planned: usize,
    metadata_matched: usize,
    unclassified: usize,
    metadata_unmatched: usize,
    total_bytes: u64,
    tree_nodes: usize,
    classification_paths: &'a [Vec<String>],
    metadata_unmatched_files: Vec<String>,
    unclassified_files: Vec<String>,
    warnings: &'a [String],
    current_library: Option<LibraryBaseline>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryBaseline {
    normal_assets: i64,
    assets_by_status: BTreeMap<String, i64>,
    classifications: i64,
    classification_links: i64,
}

fn main() {
    let exit_code = match parse_args(std::env::args_os().skip(1)).and_then(run) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    };
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

fn parse_args<I, S>(args: I) -> Result<Config, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut values = BTreeMap::new();
    let mut mode = None;
    let mut args = args.into_iter().map(Into::into);
    while let Some(argument) = args.next() {
        match argument.to_str() {
            Some("--dry-run") => set_mode(&mut mode, Mode::DryRun)?,
            Some("--execute") => set_mode(&mut mode, Mode::Execute)?,
            Some(
                flag @ ("--library"
                | "--legacy-root"
                | "--primary-metadata"
                | "--fallback-metadata"),
            ) => {
                let value = args
                    .next()
                    .ok_or_else(|| format!("{flag} 뒤에 경로가 필요합니다"))?;
                if values
                    .insert(flag.to_owned(), PathBuf::from(value))
                    .is_some()
                {
                    return Err(format!("중복 인수입니다: {flag}"));
                }
            }
            Some(flag) => return Err(format!("알 수 없는 인수입니다: {flag}")),
            None => return Err("UTF-8이 아닌 인수는 사용할 수 없습니다".into()),
        }
    }
    Ok(Config {
        library: take_required(&mut values, "--library")?,
        legacy_root: take_required(&mut values, "--legacy-root")?,
        primary_metadata: take_required(&mut values, "--primary-metadata")?,
        fallback_metadata: take_required(&mut values, "--fallback-metadata")?,
        mode: mode.ok_or("--dry-run 또는 --execute 중 하나가 필요합니다")?,
    })
}

fn set_mode(mode: &mut Option<Mode>, next: Mode) -> Result<(), String> {
    if mode.replace(next).is_some() {
        return Err("--dry-run과 --execute는 함께 또는 중복해서 사용할 수 없습니다".into());
    }
    Ok(())
}

fn take_required(values: &mut BTreeMap<String, PathBuf>, name: &str) -> Result<PathBuf, String> {
    values
        .remove(name)
        .ok_or_else(|| format!("필수 인수가 없습니다: {name}"))
}

fn run(mut config: Config) -> Result<i32, String> {
    config.library = canonical(&config.library)?;
    config.legacy_root = canonical(&config.legacy_root)?;
    config.primary_metadata = canonical(&config.primary_metadata)?;
    config.fallback_metadata = canonical(&config.fallback_metadata)?;
    let plan = inspect_legacy_migration(LegacyMigrationPaths {
        library_root: config.library.clone(),
        legacy_root: config.legacy_root,
        primary_snapshot: config.primary_metadata,
        fallback_snapshot: config.fallback_metadata,
    })
    .map_err(|error| error.to_string())?;
    let summary = plan_summary(&plan, config.mode);

    if config.mode == Mode::DryRun {
        println!(
            "{}",
            serde_json::to_string_pretty(&summary).map_err(|error| error.to_string())?
        );
        return Ok(0);
    }
    eprintln!(
        "{}",
        serde_json::to_string_pretty(&summary).map_err(|error| error.to_string())?
    );
    let library = Library::open(&config.library).map_err(|error| error.to_string())?;
    let backup = library
        .create_pre_migration_backup("legacy-lakomics")
        .map_err(|error| error.to_string())?;
    let report = library
        .execute_legacy_migration(&plan, |progress| {
            if progress.processed % 100 == 0 || progress.processed == progress.total {
                eprintln!(
                    "{}/{} {}",
                    progress.processed, progress.total, progress.current_file
                );
            }
        })
        .map_err(|error| error.to_string())?;
    let output = serde_json::json!({ "backup": backup, "report": report });
    let report_path = report_path(&config.library);
    fs::write(
        &report_path,
        serde_json::to_vec_pretty(&output).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("{}: {error}", report_path.display()))?;
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?
    );
    Ok(if report.failed == 0 { 0 } else { 2 })
}

fn plan_summary(plan: &LegacyMigrationPlan, mode: Mode) -> PlanSummary<'_> {
    PlanSummary {
        mode: if mode == Mode::DryRun {
            "dry_run"
        } else {
            "execute"
        },
        planned: plan.images.len(),
        metadata_matched: plan.metadata_matched,
        unclassified: plan.unclassified,
        metadata_unmatched: plan.images.len().saturating_sub(plan.metadata_matched),
        total_bytes: plan.total_bytes,
        tree_nodes: plan.tree_nodes,
        classification_paths: &plan.classification_paths,
        metadata_unmatched_files: plan
            .images
            .iter()
            .filter(|image| image.metadata_source.is_none())
            .map(|image| file_name(&image.source_path))
            .collect(),
        unclassified_files: plan
            .images
            .iter()
            .filter(|image| image.classification_path.is_empty())
            .map(|image| file_name(&image.source_path))
            .collect(),
        warnings: &plan.warnings,
        current_library: read_library_baseline(&plan.paths.library_root)
            .ok()
            .flatten(),
    }
}

fn read_library_baseline(library: &Path) -> Result<Option<LibraryBaseline>, String> {
    let database = library.join("library.sqlite");
    if !database.is_file() {
        return Ok(None);
    }
    let connection = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| error.to_string())?;
    let normal_assets = connection
        .query_row(
            "SELECT COUNT(*) FROM assets WHERE status = 'normal'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let assets_by_status = {
        let mut statement = connection
            .prepare("SELECT status, COUNT(*) FROM assets GROUP BY status ORDER BY status")
            .map_err(|error| error.to_string())?;
        let counts = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<BTreeMap<_, _>, _>>()
            .map_err(|error| error.to_string())?;
        counts
    };
    let classifications = connection
        .query_row("SELECT COUNT(*) FROM classification_entries", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    let classification_links = connection
        .query_row("SELECT COUNT(*) FROM asset_classifications", [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    Ok(Some(LibraryBaseline {
        normal_assets,
        assets_by_status,
        classifications,
        classification_links,
    }))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_owned()
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn report_path(library: &Path) -> PathBuf {
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let directory = library.join("backups");
    let first = directory.join(format!("legacy-migration-{timestamp}.json"));
    if !first.exists() {
        return first;
    }
    (1..)
        .map(|index| directory.join(format!("legacy-migration-{timestamp}-{index}.json")))
        .find(|path| !path.exists())
        .expect("an unused report path exists")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use image::{DynamicImage, ImageFormat};
    use serde_json::json;

    use super::{parse_args, run, Mode};

    #[test]
    fn parses_one_explicit_mode_and_rejects_invalid_combinations() {
        let valid = [
            "--library",
            "library",
            "--legacy-root",
            "legacy",
            "--primary-metadata",
            "primary.json",
            "--fallback-metadata",
            "fallback.json",
            "--dry-run",
        ];
        assert_eq!(parse_args(valid).unwrap().mode, Mode::DryRun);
        assert!(parse_args(valid.into_iter().chain(["--execute"])).is_err());
        assert!(parse_args([
            "--library",
            "library",
            "--legacy-root",
            "legacy",
            "--fallback-metadata",
            "fallback.json",
            "--dry-run",
        ])
        .is_err());
    }

    #[test]
    fn dry_run_does_not_create_a_library_database_or_backup() {
        let fixture = Fixture::new();
        let config = fixture.config("--dry-run");

        assert_eq!(run(parse_args(config).unwrap()).unwrap(), 0);
        assert!(!fixture.library.join("library.sqlite").exists());
        assert!(!fixture.library.join("backups").exists());
    }

    #[test]
    fn execute_preserves_sources_and_creates_backup_and_report() {
        let fixture = Fixture::new();
        let before = fs::read(&fixture.source).unwrap();

        assert_eq!(
            run(parse_args(fixture.config("--execute")).unwrap()).unwrap(),
            0
        );

        assert_eq!(fs::read(&fixture.source).unwrap(), before);
        let backups = fs::read_dir(fixture.library.join("backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert!(backups
            .iter()
            .any(|path| path.extension().and_then(|value| value.to_str()) == Some("sqlite")));
        assert!(backups
            .iter()
            .any(|path| path.extension().and_then(|value| value.to_str()) == Some("json")));
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        library: std::path::PathBuf,
        legacy: std::path::PathBuf,
        primary: std::path::PathBuf,
        fallback: std::path::PathBuf,
        source: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let library = temp.path().join("library");
            let legacy = temp.path().join("legacy");
            fs::create_dir(&library).unwrap();
            fs::create_dir(&legacy).unwrap();
            let source = legacy.join("alpha.png");
            DynamicImage::new_rgb8(8, 8)
                .save_with_format(&source, ImageFormat::Png)
                .unwrap();
            let tree = json!([{
                "id": "games", "name": "게임", "autoTags": ["g:게임"], "children": []
            }]);
            let primary = temp.path().join("primary.json");
            fs::write(&primary, serde_json::to_vec(&json!({
                "items": [{ "relativePath": "alpha.png", "tags": ["g:게임"], "sourceId": null, "customTitle": null, "modifiedAt": "2026-01-01T00:00:00Z" }],
                "contentPreferences": { "storage_tag_tree": tree.to_string() }
            })).unwrap()).unwrap();
            let fallback = temp.path().join("fallback.json");
            fs::write(&fallback, br#"{"items":[]}"#).unwrap();
            Self {
                _temp: temp,
                library,
                legacy,
                primary,
                fallback,
                source,
            }
        }

        fn config(&self, mode: &'static str) -> Vec<std::ffi::OsString> {
            vec![
                "--library".into(),
                self.library.as_os_str().into(),
                "--legacy-root".into(),
                self.legacy.as_os_str().into(),
                "--primary-metadata".into(),
                self.primary.as_os_str().into(),
                "--fallback-metadata".into(),
                self.fallback.as_os_str().into(),
                mode.into(),
            ]
        }
    }
}
