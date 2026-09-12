use std::{ffi::OsString, path::PathBuf};

use app_lib::library::legacy_package_migration::{self, LegacyPackagePaths};

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

#[derive(Debug, PartialEq, Eq)]
struct Config {
    library: PathBuf,
    package_root: PathBuf,
    metadata_snapshot: PathBuf,
    book_root: PathBuf,
}

fn parse_args<I, S>(args: I) -> Result<Config, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut values = std::collections::BTreeMap::new();
    let mut args = args.into_iter().map(Into::into);
    while let Some(argument) = args.next() {
        let flag = argument
            .to_str()
            .ok_or_else(|| "UTF-8이 아닌 인수는 사용할 수 없습니다".to_string())?;
        match flag {
            "--library" | "--package-root" | "--metadata-snapshot" | "--book-root" => {
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
            flag => return Err(format!("알 수 없는 인수입니다: {flag}")),
        }
    }
    Ok(Config {
        library: take_required(&mut values, "--library")?,
        package_root: take_required(&mut values, "--package-root")?,
        metadata_snapshot: take_required(&mut values, "--metadata-snapshot")?,
        book_root: take_required(&mut values, "--book-root")?,
    })
}

fn take_required(
    values: &mut std::collections::BTreeMap<String, PathBuf>,
    name: &str,
) -> Result<PathBuf, String> {
    values
        .remove(name)
        .ok_or_else(|| format!("필수 인수가 없습니다: {name}"))
}

fn run(config: Config) -> Result<i32, String> {
    let library = canonical(&config.library)?;
    let package_root = canonical(&config.package_root)?;
    let metadata_snapshot = canonical(&config.metadata_snapshot)?;
    let book_root = canonical(&config.book_root)?;
    let plan = legacy_package_migration::inspect_legacy_package_migration(&LegacyPackagePaths {
        library_root: library,
        package_root,
        metadata_snapshot,
        book_root,
    })
    .map_err(|error| error.to_string())?;
    let summary = serde_json::json!({
        "libraryId": plan.source.library_id,
        "fingerprint": plan.source.fingerprint,
        "items": plan.source.items.len(),
        "images": plan.source.image_count,
        "videos": plan.source.video_count,
        "favorites": plan.source.favorite_count,
        "folders": plan.source.folders.len(),
        "preview": plan.preview,
        "targetBefore": plan.target_before,
        "booksEntries": plan.books.entries.len(),
        "booksSkipped": plan.books.skipped.len(),
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&summary).map_err(|error| error.to_string())?
    );
    Ok(0)
}

fn canonical(path: &std::path::Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("{}: {error}", path.display()))
}