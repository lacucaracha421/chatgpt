use std::{env, path::PathBuf};

use app_lib::library::thumbnail_maintenance::{
    recompress_thumbnails, ThumbnailRecompressOptions, ThumbnailRecompressReport,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (root, options) = parse_args()?;
    println!("Lakomics thumbnail recompression maintenance");
    println!("library: {}", root.display());
    println!("mode: {}", if options.apply { "apply" } else { "dry-run" });

    let report = recompress_thumbnails(&root, options)?;
    print_report(&report);
    if report.failed > 0 {
        std::process::exit(2);
    }
    Ok(())
}

fn parse_args() -> Result<(PathBuf, ThumbnailRecompressOptions), String> {
    let mut args = env::args().skip(1);
    let mut root = None;
    let mut apply = false;
    let mut limit = None;
    let mut all = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--library" => root = Some(PathBuf::from(args.next().ok_or("--library needs a path")?)),
            "--apply" => apply = true,
            "--limit" => {
                let value = args.next().ok_or("--limit needs a number")?;
                limit = Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| "--limit must be a number")?,
                );
            }
            "--all" => all = true,
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }

    let root = root.ok_or("--library PATH is required")?;
    Ok((root, ThumbnailRecompressOptions { apply, limit, all }))
}

fn print_report(report: &ThumbnailRecompressReport) {
    println!(
        "scan: files={} complete={} lossless={} lossy={} missing={} unknown={} total_mib={:.2} ms={:.1}",
        report.scanned,
        report.scan_complete,
        report.lossless,
        report.lossy,
        report.missing,
        report.unknown,
        mib(report.thumbnail_bytes),
        report.scan_ms,
    );
    if report.attempted > 0 || report.stale_temp_removed > 0 {
        println!(
            "apply: attempted={} recompressed={} not_smaller={} failed={} stale_temp_removed={} before_mib={:.2} after_mib={:.2} saved_mib={:.2} ms={:.1}",
            report.attempted,
            report.recompressed,
            report.skipped_not_smaller,
            report.failed,
            report.stale_temp_removed,
            mib(report.bytes_before),
            mib(report.bytes_after),
            mib(report.bytes_saved()),
            report.apply_ms,
        );
    }
    for failure in report.failures.iter().take(20) {
        eprintln!("failure: {failure}");
    }
    if report.failures.len() > 20 {
        eprintln!("... {} more failures", report.failures.len() - 20);
    }
}

fn mib(bytes: u64) -> f64 {
    bytes as f64 / 1024.0 / 1024.0
}

fn print_usage() {
    println!("Usage:");
    println!("  thumbnail_recompress --library PATH");
    println!("  thumbnail_recompress --library PATH --apply --limit N");
    println!("  thumbnail_recompress --library PATH --apply --all");
    println!();
    println!("Dry-run is the default. Apply mode requires an explicit batch limit or --all.");
}
