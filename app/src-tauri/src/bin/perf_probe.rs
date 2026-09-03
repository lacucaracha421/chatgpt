use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use app_lib::library::{
    models::{AssetPage, AssetQuery, AssetSort, MediaKindFilter},
    Library,
};
use rusqlite::{Connection, OpenFlags, MAIN_DB};

const ITERATIONS: usize = 8;
const PAGE_SIZE: u32 = 50;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = parse_library_arg()?;
    println!("Lakomics PERF-001 Phase B probe");
    println!("library: {}", root.display());

    print_disk_stats(&root)?;

    let snapshot_root = snapshot_library_db(&root)?;
    let open_started = Instant::now();
    let library = Library::open(&snapshot_root)?;
    println!(
        "snapshot_open_ms: {:.3}",
        open_started.elapsed().as_secs_f64() * 1000.0
    );

    let classifications_started = Instant::now();
    let mut classifications = library.list_classifications()?;
    let classifications_ms = classifications_started.elapsed().as_secs_f64() * 1000.0;
    classifications.sort_by_key(|entry| std::cmp::Reverse(entry.asset_count));
    println!("list_classifications_ms: {:.3}", classifications_ms);
    if let Some(largest) = classifications.first() {
        println!(
            "largest_classification: {} | assets={} | id={}",
            largest.name, largest.asset_count, largest.id
        );
    }

    bench_query("root_newest", &library, base_query());
    bench_query(
        "root_images",
        &library,
        AssetQuery {
            media_kind: Some(MediaKindFilter::Images),
            ..base_query()
        },
    );
    bench_query(
        "root_videos",
        &library,
        AssetQuery {
            media_kind: Some(MediaKindFilter::Videos),
            ..base_query()
        },
    );

    if let Some(largest) = classifications.first() {
        bench_query(
            "largest_classification_recursive",
            &library,
            AssetQuery {
                classification_id: Some(largest.id.clone()),
                direct_only: false,
                ..base_query()
            },
        );
        bench_query(
            "largest_classification_direct",
            &library,
            AssetQuery {
                classification_id: Some(largest.id.clone()),
                direct_only: true,
                ..base_query()
            },
        );
    }

    bench_next_page(&library)?;
    drop(library);
    fs::remove_dir_all(&snapshot_root)?;
    Ok(())
}

fn base_query() -> AssetQuery {
    AssetQuery {
        sort: AssetSort::Newest,
        limit: PAGE_SIZE,
        ..AssetQuery::default()
    }
}

fn bench_query(label: &str, library: &Library, query: AssetQuery) {
    let mut samples = Vec::with_capacity(ITERATIONS);
    let mut count = 0usize;
    for _ in 0..ITERATIONS {
        let started = Instant::now();
        let page = library
            .list_assets(query.clone())
            .expect("benchmark query failed");
        samples.push(started.elapsed());
        count = page.items.len();
    }
    print_samples(label, count, &samples);
}

fn bench_next_page(library: &Library) -> Result<(), Box<dyn std::error::Error>> {
    let first = library.list_assets(base_query())?;
    let Some(cursor) = first.next_cursor else {
        println!("root_next_page: skipped (no cursor)");
        return Ok(());
    };
    let query = AssetQuery {
        after: Some(cursor),
        ..base_query()
    };
    let mut samples = Vec::with_capacity(ITERATIONS);
    let mut count = 0usize;
    for _ in 0..ITERATIONS {
        let started = Instant::now();
        let page: AssetPage = library.list_assets(query.clone())?;
        samples.push(started.elapsed());
        count = page.items.len();
    }
    print_samples("root_next_page", count, &samples);
    Ok(())
}

fn print_samples(label: &str, count: usize, samples: &[Duration]) {
    let first_ms = samples[0].as_secs_f64() * 1000.0;
    let mut warm = samples[1..]
        .iter()
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .collect::<Vec<_>>();
    warm.sort_by(f64::total_cmp);
    let median = warm[warm.len() / 2];
    let max = warm.iter().copied().fold(0.0_f64, f64::max);
    println!(
        "{label}: items={count} first_ms={first_ms:.3} warm_median_ms={median:.3} warm_max_ms={max:.3}"
    );
}

fn parse_library_arg() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    match (args.next().as_deref(), args.next()) {
        (Some("--library"), Some(path)) if args.next().is_none() => Ok(PathBuf::from(path)),
        _ => Err("usage: cargo run --bin perf_probe -- --library <path>".into()),
    }
}

fn snapshot_library_db(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let source_path = root.join("library.sqlite");
    let source = Connection::open_with_flags(&source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let snapshot_root = env::temp_dir().join(format!("lakomics-perf-probe-{}", std::process::id()));
    if snapshot_root.exists() {
        fs::remove_dir_all(&snapshot_root)?;
    }
    fs::create_dir_all(&snapshot_root)?;
    let destination = snapshot_root.join("library.sqlite");
    let started = Instant::now();
    source.backup(MAIN_DB, &destination, None)?;
    println!(
        "snapshot_copy_ms: {:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );

    let media_started = Instant::now();
    hard_link_tree(
        &root.join("video-media"),
        &snapshot_root.join("video-media"),
    )?;
    println!(
        "snapshot_video_media_links_ms: {:.3}",
        media_started.elapsed().as_secs_f64() * 1000.0
    );
    Ok(snapshot_root)
}

fn hard_link_tree(source: &Path, destination: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            hard_link_tree(&source_path, &destination_path)?;
        } else {
            fs::hard_link(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn print_disk_stats(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    for name in [
        "assets",
        "thumbnails",
        "video-media",
        "cache",
        "collection-thumbnails",
        "work-artwork",
        "work-artwork-thumbnails",
        "catalogs",
        "backups",
    ] {
        let path = root.join(name);
        if path.exists() {
            let (files, bytes) = directory_stats(&path)?;
            println!(
                "disk_{name}: files={files} mib={:.2}",
                bytes as f64 / 1024.0 / 1024.0
            );
        }
    }
    println!(
        "disk_scan_ms: {:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}

fn directory_stats(root: &Path) -> Result<(u64, u64), Box<dyn std::error::Error>> {
    let mut stack = vec![root.to_path_buf()];
    let mut files = 0u64;
    let mut bytes = 0u64;
    while let Some(path) = stack.pop() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                stack.push(entry.path());
            } else if metadata.is_file() {
                files += 1;
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok((files, bytes))
}
