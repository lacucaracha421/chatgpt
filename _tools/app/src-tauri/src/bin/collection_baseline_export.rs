//! Offline, read-only source export. Never starts Library, credentials or HTTP.
use app_lib::library::Library;
use std::{collections::BTreeMap, path::PathBuf};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut options = BTreeMap::new();
    while let Some(key) = args.next() {
        if !["--library", "--snapshot-dir", "--endpoint", "--revision"].contains(&key.as_str()) {
            return Err("Usage: collection_baseline_export --library PATH --snapshot-dir NEW_PATH --endpoint URL --revision REVISION".into());
        }
        let value = args.next().ok_or("Missing option value")?;
        if options.insert(key, value).is_some() {
            return Err("Duplicate option".into());
        }
    }
    let get = |key: &str| options.get(key).ok_or_else(|| format!("Missing {key}"));
    let source = PathBuf::from(get("--library")?);
    let destination = PathBuf::from(get("--snapshot-dir")?);
    let (baseline, legacy) = Library::export_collection_baseline(
        &source,
        &destination,
        get("--endpoint")?,
        get("--revision")?,
    )?;
    for (name, value) in [("baseline.json", &baseline), ("legacy.json", &legacy)] {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination.join(name))?;
        serde_json::to_writer_pretty(file, value)?;
    }
    for section in [
        "works",
        "bindings",
        "artworks",
        "volumes",
        "volumeSources",
        "ownership",
        "people",
        "memberships",
    ] {
        println!(
            "{section}: {}",
            baseline[section].as_array().map_or(0, Vec::len)
        );
    }
    println!("Baseline: {}", destination.join("baseline.json").display());
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Export failed: {error}");
        std::process::exit(1);
    }
}
