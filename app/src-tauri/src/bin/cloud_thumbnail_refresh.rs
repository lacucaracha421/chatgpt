use std::{env, path::PathBuf, process::ExitCode, time::Instant};

use app_lib::{refresh_cloud_thumbnails, CloudThumbnailRefreshOptions};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let (root, options) = parse_args()?;
    println!("Lakomics cloud thumbnail refresh");
    println!("library: {}", root.display());
    println!("mode: {}", if options.apply { "apply" } else { "dry-run" });
    let started = Instant::now();
    let report = refresh_cloud_thumbnails(&root, options)?;
    println!(
        "eligible={} current={} selected={} uploaded={} failed={} eligible_mib={:.2} selected_mib={:.2}",
        report.eligible,
        report.current,
        report.selected,
        report.uploaded,
        report.failed,
        report.bytes_eligible as f64 / 1024.0 / 1024.0,
        report.bytes_selected as f64 / 1024.0 / 1024.0
    );
    for failure in report.failures.iter().take(20) {
        eprintln!("failure: {failure}");
    }
    println!("wall_ms={:.1}", started.elapsed().as_secs_f64() * 1000.0);
    if report.failed > 0 {
        return Err("one or more uploads failed".into());
    }
    Ok(())
}

fn parse_args() -> Result<(PathBuf, CloudThumbnailRefreshOptions), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let mut root = None;
    let mut apply = false;
    let mut limit = None;
    let mut all = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--library" => {
                root = Some(PathBuf::from(args.next().ok_or("missing --library value")?))
            }
            "--apply" => apply = true,
            "--limit" => {
                let value: usize = args.next().ok_or("missing --limit value")?.parse()?;
                limit = Some(value);
            }
            "--all" => all = true,
            _ => return Err(format!("unknown argument: {arg}").into()),
        }
    }
    let root =
        root.ok_or("usage: cloud_thumbnail_refresh --library <path> [--apply (--limit N|--all)]")?;
    Ok((root, CloudThumbnailRefreshOptions { apply, limit, all }))
}
