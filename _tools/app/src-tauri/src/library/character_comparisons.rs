//! Disposable, versioned comparison checkpoints. The library remains authoritative.
use super::*;
use rusqlite::{Connection, OptionalExtension};

pub(super) struct Comparisons(Connection);

impl Comparisons {
    pub(super) fn open(library: &Library) -> Result<Self> {
        let directory = library.root.join(".cache/characters");
        std::fs::create_dir_all(&directory)?;
        let connection = Connection::open(directory.join("comparisons.sqlite"))?;
        connection.execute_batch("CREATE TABLE IF NOT EXISTS comparisons (
            cache_key TEXT PRIMARY KEY, target_id TEXT NOT NULL, asset_id TEXT NOT NULL,
            result TEXT NOT NULL, UNIQUE(target_id,asset_id)
        )")?;
        Ok(Self(connection))
    }

    pub(super) fn key(library: &Library, target: &Target, runtime: &str, input: &ScanInput) -> Result<String> {
        let metadata = library.open_library_media(&input.path)?.file.metadata()?;
        let modified = metadata.modified()?.duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::Stale)?.as_nanos().to_string();
        let bytes = serde_json::to_vec(&(
            "comparison-v1", &target.fingerprint, target.usable_learned_references().collect::<Vec<_>>(),
            runtime, &input.id, &input.hash, metadata.len(), modified,
        ))?;
        Ok(Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect())
    }

    pub(super) fn get(&self, key: &str) -> Result<Option<ScanResult>> {
        let json: Option<String> = self.0.query_row(
            "SELECT result FROM comparisons WHERE cache_key=?1", [key], |r| r.get(0),
        ).optional()?;
        // A damaged disposable row is recomputed, never used as approval evidence.
        Ok(json.and_then(|value| serde_json::from_str(&value).ok()))
    }

    pub(super) fn put(&self, target: &str, key: &str, row: &ScanResult) -> Result<()> {
        if matches!(row.state.as_str(), "recommended" | "unmatched") {
            self.0.execute("INSERT OR REPLACE INTO comparisons(cache_key,target_id,asset_id,result) VALUES(?1,?2,?3,?4)",
                params![key, target, row.asset_id, serde_json::to_string(row)?])?;
        }
        Ok(())
    }
}
