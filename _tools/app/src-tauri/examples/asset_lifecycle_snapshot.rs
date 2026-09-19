//! Read-only PC-side lifecycle snapshot for the Asset Authority activation baseline.
//!
//! Prints one JSON document describing the canonical PC library's Asset identity and
//! lifecycle, for comparison against the server's committed inventory. It is a
//! reconciliation *input*, not a mutation: the database is opened read-only, no
//! migrations run, no background workers start, and no library lock is taken beyond the
//! read transaction.
//!
//! Run:
//!   cargo run --release --example asset_lifecycle_snapshot -- <library.sqlite>
//!
//! The library id is read from `library_settings`; if that row is absent the field is
//! reported as null rather than invented, because a wrong library id would make the
//! baseline validate against the wrong authority.

use std::collections::BTreeMap;
use std::error::Error;
use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

#[derive(Serialize)]
struct Snapshot {
    libraryId: Option<String>,
    userVersion: i64,
    total: usize,
    counts: BTreeMap<String, usize>,
    assets: Vec<AssetRow>,
}

#[derive(Serialize)]
struct AssetRow {
    assetId: String,
    status: String,
    contentHash: Option<String>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args().nth(1).ok_or("usage: asset_lifecycle_snapshot <library.sqlite>")?;
    let path = Path::new(&path);
    if !path.is_file() {
        return Err(format!("not a file: {}", path.display()).into());
    }

    // READ_ONLY is the load-bearing flag: it makes every write fail at the SQLite level,
    // so this tool cannot migrate or repair the library even by accident.
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let user_version: i64 =
        connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    let library_id: Option<String> = connection
        .query_row(
            "SELECT library_id FROM library_settings WHERE singleton=1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();

    // Identity is the Asset id; integrity binding is the content hash. Status is the
    // lifecycle the operator reviews. Nothing here is inferred from a path or timestamp.
    let mut statement = connection.prepare(
        "SELECT id, status, content_hash FROM assets ORDER BY id",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(AssetRow {
                assetId: row.get(0)?,
                status: row.get(1)?,
                contentHash: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for row in &rows {
        *counts.entry(row.status.clone()).or_default() += 1;
    }

    let snapshot = Snapshot {
        libraryId: library_id,
        userVersion: user_version,
        total: rows.len(),
        counts,
        assets: rows,
    };
    println!("{}", serde_json::to_string(&snapshot)?);
    Ok(())
}
