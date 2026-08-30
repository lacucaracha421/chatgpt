use std::collections::BTreeSet;

use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension};

use super::error::LibraryError;
use super::models::{AssetSummary, RevisitBundle, RevisitSlate};
use super::query::asset_summary_from_row;

pub(crate) fn parse_utc_timestamp(value: &str) -> Result<DateTime<chrono::Utc>, LibraryError> {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| parsed.with_timezone(&chrono::Utc))
        .map_err(|_| LibraryError::InvalidCollectedAt)
}

pub(crate) fn parse_local_date(local_date: &str) -> Result<chrono::NaiveDate, LibraryError> {
    chrono::NaiveDate::parse_from_str(local_date, "%Y-%m-%d")
        .map_err(|_| LibraryError::InvalidCollectedAt)
}

pub(crate) fn record_asset_opened(
    connection: &Connection,
    asset_id: &str,
    opened_at: &str,
) -> Result<(), LibraryError> {
    parse_utc_timestamp(opened_at)?;
    asset_exists(connection, asset_id)?;
    connection.execute(
        "INSERT INTO asset_activity (asset_id, last_opened_at, open_count)
         VALUES (?1, ?2, 1)
         ON CONFLICT(asset_id) DO UPDATE SET
            last_opened_at = excluded.last_opened_at,
            open_count = open_count + 1",
        params![asset_id, opened_at],
    )?;
    Ok(())
}

pub(crate) fn record_assets_exposed(
    connection: &Connection,
    asset_ids: &[String],
    exposed_at: &str,
) -> Result<(), LibraryError> {
    parse_utc_timestamp(exposed_at)?;
    let unique: BTreeSet<&str> = asset_ids.iter().map(String::as_str).collect();
    let transaction = connection.unchecked_transaction()?;
    for asset_id in &unique {
        asset_exists(&transaction, asset_id)?;
        transaction.execute(
            "INSERT INTO asset_activity (asset_id, last_exposed_at, exposure_count)
             VALUES (?1, ?2, 1)
             ON CONFLICT(asset_id) DO UPDATE SET
                last_exposed_at = excluded.last_exposed_at,
                exposure_count = exposure_count + 1",
            params![asset_id, exposed_at],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn save_daily_slate(
    connection: &Connection,
    slate: &RevisitSlate,
) -> Result<(), LibraryError> {
    let mut seen = BTreeSet::new();
    for bundle in &slate.bundles {
        for asset_id in &bundle.asset_ids {
            if !seen.insert(asset_id.as_str()) {
                return Err(LibraryError::InvalidCollectedAt);
            }
        }
    }
    let transaction = connection.unchecked_transaction()?;
    for asset_id in &seen {
        asset_exists(&transaction, asset_id)?;
    }
    transaction.execute(
        "DELETE FROM revisit_slates WHERE local_date = ?1",
        params![slate.local_date],
    )?;
    transaction.execute(
        "INSERT INTO revisit_slates (local_date, created_at, revision) VALUES (?1, ?2, ?3)",
        params![slate.local_date, slate.created_at, slate.revision],
    )?;
    for (position, bundle) in slate.bundles.iter().enumerate() {
        transaction.execute(
            "INSERT INTO revisit_bundles (id, local_date, position, kind, title, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![bundle.id, slate.local_date, position as i64, bundle.kind, bundle.title, bundle.reason],
        )?;
        for (asset_position, asset_id) in bundle.asset_ids.iter().enumerate() {
            transaction.execute(
                "INSERT INTO revisit_bundle_assets (bundle_id, asset_id, position) VALUES (?1, ?2, ?3)",
                params![bundle.id, asset_id, asset_position as i64],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn load_daily_slate(
    connection: &Connection,
    local_date: &str,
) -> Result<Option<RevisitSlate>, LibraryError> {
    parse_local_date(local_date)?;
    let head = connection
        .query_row(
            "SELECT created_at, revision FROM revisit_slates WHERE local_date = ?1",
            params![local_date],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let Some((created_at, revision)) = head else { return Ok(None) };

    let mut bundles_statement = connection.prepare(
        "SELECT id, kind, title, reason FROM revisit_bundles WHERE local_date = ?1 ORDER BY position ASC",
    )?;
    let bundle_rows = bundles_statement.query_map(params![local_date], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
    })?;
    let mut bundles = Vec::new();
    for row in bundle_rows {
        let (id, kind, title, reason) = row?;
        let mut assets_statement = connection.prepare(
            "SELECT asset_id FROM revisit_bundle_assets WHERE bundle_id = ?1 ORDER BY position ASC",
        )?;
        let asset_ids = assets_statement
            .query_map(params![id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<String>, _>>()?;
        bundles.push(RevisitBundle { id, kind, title, reason, asset_ids, revision });
    }
    Ok(Some(RevisitSlate { local_date: local_date.to_string(), created_at, revision, bundles }))
}

pub(crate) fn get_or_create_revisit_slate(
    connection: &Connection,
    local_date: &str,
    now_utc: &str,
) -> Result<RevisitSlate, LibraryError> {
    parse_utc_timestamp(now_utc)?;
    parse_local_date(local_date)?;
    if let Some(slate) = load_daily_slate(connection, local_date)? {
        return Ok(slate);
    }
    let mut slate = generate_daily_slate(connection, local_date, now_utc, 0)?;
    save_daily_slate(connection, &slate)?;
    slate.revision = load_revision(connection, local_date)?;
    Ok(slate)
}

pub(crate) fn reshuffle_revisit_bundle(
    connection: &Connection,
    local_date: &str,
    bundle_id: &str,
    _now_utc: &str,
) -> Result<RevisitSlate, LibraryError> {
    let mut slate = load_daily_slate(connection, local_date)?.ok_or(LibraryError::AssetNotFound)?;
    let bundle_index = slate.bundles.iter().position(|bundle| bundle.id == bundle_id).ok_or(LibraryError::AssetNotFound)?;
    let other: std::collections::BTreeSet<String> = slate
        .bundles
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != bundle_index)
        .flat_map(|(_, other)| other.asset_ids.iter().cloned())
        .collect();
    let bundle = &mut slate.bundles[bundle_index];
    let context = RecommendationContext::load(connection)?;
    let bundle_revision = bundle.revision + 1;
    if let Some(regenerated) = generate_bundle(connection, &context, &bundle.kind, local_date, bundle_revision) {
        bundle.asset_ids = regenerated.1.into_iter().filter(|id| !other.contains(id)).collect();
        bundle.revision = bundle_revision;
        bundle.title = regenerated.0.title.to_string();
        bundle.reason = reason_text(regenerated.0.reason_key, &bundle.asset_ids.len());
    }
    if bundle.asset_ids.len() < 2 { return Err(LibraryError::InvalidCollectedAt); }
    save_daily_slate(connection, &slate)?;
    Ok(slate)
}

pub(crate) fn reshuffle_revisit_slate(
    connection: &Connection,
    local_date: &str,
    now_utc: &str,
) -> Result<RevisitSlate, LibraryError> {
    let current = load_daily_slate(connection, local_date)?.ok_or(LibraryError::AssetNotFound)?;
    let revision = current.revision + 1;
    let mut slate = generate_daily_slate(connection, local_date, now_utc, revision)?;
    save_daily_slate(connection, &slate)?;
    slate.revision = revision;
    Ok(slate)
}

fn load_revision(connection: &Connection, local_date: &str) -> Result<i64, LibraryError> {
    Ok(connection.query_row(
        "SELECT revision FROM revisit_slates WHERE local_date = ?1",
        params![local_date],
        |row| row.get(0),
    )?)
}

const BUNDLE_KINDS: [&str; 4] = ["rediscovery", "creator", "date", "surprise"];
const MAX_BUNDLES: usize = 10;
const MIN_BUNDLE_ASSETS: usize = 6;
const MAX_BUNDLE_ASSETS: usize = 20;

struct Candidate {
    asset: AssetSummary,
    score: i64,
}

struct BundleMeta {
    title: &'static str,
    reason_key: &'static str,
}

fn bundle_meta(kind: &str) -> BundleMeta {
    match kind {
        "rediscovery" => BundleMeta { title: "다시 만난 자산", reason_key: "forgotten" },
        "creator" => BundleMeta { title: "작가", reason_key: "creator" },
        "date" => BundleMeta { title: "과거의 이날", reason_key: "date" },
        _ => BundleMeta { title: "뜻밖의 연결", reason_key: "surprise" },
    }
}

struct RecommendationContext {
    assets: Vec<AssetSummary>,
    activity: std::collections::HashMap<String, ActivityRow>,
}

struct ActivityRow {
    last_opened_at: Option<String>,
    open_count: i64,
    last_exposed_at: Option<String>,
    exposure_count: i64,
}

impl RecommendationContext {
    fn load(connection: &Connection) -> Result<Self, LibraryError> {
        let assets = load_assets_for_recommendation(connection)?;
        let mut statement = connection.prepare(
            "SELECT asset_id, last_opened_at, open_count, last_exposed_at, exposure_count FROM asset_activity",
        )?;
        let activity = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ActivityRow {
                        last_opened_at: row.get(1)?,
                        open_count: row.get(2)?,
                        last_exposed_at: row.get(3)?,
                        exposure_count: row.get(4)?,
                    },
                ))
            })?
            .collect::<Result<std::collections::HashMap<String, ActivityRow>, _>>()?;
        Ok(Self { assets, activity })
    }

    fn activity(&self, asset_id: &str) -> Option<&ActivityRow> {
        self.activity.get(asset_id)
    }
}

fn load_assets_for_recommendation(connection: &Connection) -> Result<Vec<AssetSummary>, LibraryError> {
    let mut statement = connection.prepare(&format!(
        "SELECT asset.id, asset.title, asset.original_name, asset.relative_path, asset.thumbnail_relative_path, asset.byte_size, asset.width, asset.height, asset.collected_at, asset.favorite, asset.source_url, \
         asset.media_kind, video.duration_ms, video.preparation_state, video.scrub_frame_count, \
         asset.source_published_at, asset.creator_name, asset.creator_handle, asset.creator_url, \
         asset.import_source, asset.import_batch_id, asset.original_modified_at \
         FROM assets AS asset LEFT JOIN video_assets AS video ON video.asset_id = asset.id \
         WHERE asset.status = 'normal'"
    ))?;
    let rows = statement.query_map([], asset_summary_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(LibraryError::from)
}

type Generated = (BundleMeta, Vec<String>);

fn generate_daily_slate(
    connection: &Connection,
    local_date: &str,
    now_utc: &str,
    revision: i64,
) -> Result<RevisitSlate, LibraryError> {
    let context = RecommendationContext::load(connection)?;
    let mut preference_weights = load_preference_weights(connection)?;

    let mut used: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut bundles: Vec<RevisitBundle> = Vec::new();
    let _ = now_utc;

    // 주인공 묶음 유형은 날짜에 따라 순환한다.
    let day_seed = seed_from(&format!("{local_date}"));
    let hero_kind = BUNDLE_KINDS[(day_seed as usize) % BUNDLE_KINDS.len()];
    let mut kinds: Vec<&str> = BUNDLE_KINDS.iter().copied().filter(|kind| *kind != hero_kind).collect();

    if let Some(generated) = generate_bundle(connection, &context, hero_kind, local_date, revision) {
        let (meta, asset_ids) = generated;
        for id in &asset_ids { used.insert(id.clone()); }
        bundles.push(RevisitBundle {
            id: format!("{local_date}-{kind}-{revision}", kind = meta.reason_key),
            kind: meta.reason_key.to_string(),
            title: meta.title.to_string(),
            reason: reason_text(meta.reason_key, &asset_ids.len()),
            asset_ids,
            revision: 0,
        });
    }

    for round in 0..12usize {
        if bundles.len() >= MAX_BUNDLES { break; }
        let kind = kinds[round % kinds.len()];
        let kind_revision = revision + round as i64;
        if let Some(generated) = generate_bundle(connection, &context, kind, local_date, kind_revision) {
            let (meta, asset_ids) = generated;
            let unique: Vec<String> = asset_ids.into_iter().filter(|id| !used.contains(id)).collect();
            if unique.len() < 2 { continue; }
            for id in &unique { used.insert(id.clone()); }
            bundles.push(RevisitBundle {
                id: format!("{local_date}-{kind}-{kind_revision}"),
                kind: kind.to_string(),
                title: meta.title.to_string(),
                reason: reason_text(meta.reason_key, &unique.len()),
                asset_ids: unique,
                revision: 0,
            });
        }
    }
    let _ = &mut preference_weights;
    Ok(RevisitSlate { local_date: local_date.to_string(), created_at: now_utc.to_string(), revision, bundles })
}

fn load_preference_weights(connection: &Connection) -> Result<Vec<(String, String, i64)>, LibraryError> {
    let mut statement = connection.prepare("SELECT dimension, value, weight FROM revisit_preferences")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(LibraryError::from)
}

fn seed_from(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn shuffled_candidates(candidates: Vec<Candidate>, seed: &str) -> Vec<Candidate> {
    let mut candidates = candidates;
    let mut state = seed_from(seed);
    if !candidates.is_empty() {
        for index in (1..candidates.len()).rev() {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let swap = (state >> 33) as usize % (index + 1);
            candidates.swap(index, swap);
        }
    }
    candidates
}

fn reason_text(reason_key: &str, count: &usize) -> String {
    let _ = count;
    match reason_key {
        "forgotten" => "오랫동안 열지 않은 자산".to_string(),
        "date" => "같은 시기에 수집한 자산".to_string(),
        _ => String::new(),
    }
}

fn generate_bundle(
    connection: &Connection,
    context: &RecommendationContext,
    kind: &str,
    local_date: &str,
    revision: i64,
) -> Option<Generated> {
    let seed = seed_from(&format!("{local_date}-{kind}-{revision}"));
    let candidates = match kind {
        "rediscovery" => forgotten_favorites(context),
        "creator" => creator_spotlight(connection, context),
        "date" => date_capsule(context, local_date),
        _ => surprise_mix(context, seed),
    };
    let ordered = shuffled_candidates(candidates, &format!("{local_date}-{kind}-{revision}"));
    let mut chosen: Vec<String> = Vec::new();
    for candidate in ordered {
        if chosen.len() >= MAX_BUNDLE_ASSETS { break; }
        if !chosen.contains(&candidate.asset.id) {
            chosen.push(candidate.asset.id);
        }
    }
    if chosen.len() < 2 { return None; }
    let meta = bundle_meta(kind);
    Some((meta, chosen))
}

fn forgotten_favorites(context: &RecommendationContext) -> Vec<Candidate> {
    context
        .assets
        .iter()
        .filter(|asset| asset.favorite)
        .filter(|asset| {
            context
                .activity(&asset.id)
                .map(|row| row.last_opened_at.is_none())
                .unwrap_or(true)
        })
        .map(|asset| Candidate { asset: asset.clone(), score: 1 })
        .collect()
}

fn creator_spotlight(connection: &Connection, context: &RecommendationContext) -> Vec<Candidate> {
    let mut counts: std::collections::HashMap<String, Vec<&AssetSummary>> = std::collections::HashMap::new();
    for asset in &context.assets {
        if let Some(key) = asset.creator_handle.as_ref().or(asset.creator_url.as_ref()).cloned() {
            counts.entry(key).or_default().push(asset);
        }
    }
    let _ = connection;
    let mut candidates = Vec::new();
    for (_, group) in counts {
        if group.len() >= 3 {
            for asset in group {
                candidates.push(Candidate { asset: asset.clone(), score: 1 });
            }
        }
    }
    candidates
}

fn date_capsule(context: &RecommendationContext, local_date: &str) -> Vec<Candidate> {
    let Some(today_month) = local_date.get(5..7).and_then(|part| part.parse::<u32>().ok()) else { return Vec::new() };
    context
        .assets
        .iter()
        .filter(|asset| {
            let month = asset.collected_at.get(5..7).and_then(|part| part.parse::<u32>().ok()).unwrap_or(0);
            month == today_month
        })
        .map(|asset| Candidate { asset: asset.clone(), score: 1 })
        .collect()
}

fn surprise_mix(context: &RecommendationContext, seed: u64) -> Vec<Candidate> {
    let target_kind = match (seed as usize) % 3 {
        0 => crate::library::models::MediaSummary::Gif,
        _ => crate::library::models::MediaSummary::Image,
    };
    let matched: Vec<&AssetSummary> = context.assets.iter().filter(|asset| std::mem::discriminant(&asset.media) == std::mem::discriminant(&target_kind)).collect();
    let chosen_kind = if matched.len() >= MIN_BUNDLE_ASSETS { target_kind } else { return Vec::new() };
    matched
        .into_iter()
        .map(|asset| Candidate { asset: asset.clone(), score: 1 })
        .collect::<Vec<_>>()
        .into_iter()
        .filter(|candidate| std::mem::discriminant(&candidate.asset.media) == std::mem::discriminant(&chosen_kind))
        .collect()
}

fn asset_exists(connection: &Connection, asset_id: &str) -> Result<(), LibraryError> {
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM assets WHERE id = ?1",
            params![asset_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(LibraryError::AssetNotFound);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Library;
    use rusqlite::params;

    fn fixture() -> Library {
        let temp = tempfile::tempdir().unwrap();
        let library = Library::open(temp.path()).unwrap();;
        library
    }

    fn insert_asset(library: &Library, id: &str, collected_at: &str) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at
                 ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 400, 200, ?6)",
                params![id, format!("hash-{id}"), format!("{id}.png"), format!("assets/{id}.png"), format!("thumbnails/{id}.webp"), collected_at],
            )
            .unwrap();
    }

    #[test]
    fn opening_and_exposure_update_aggregates_without_event_rows() {
        let library = fixture();
        insert_asset(&library, "asset-a", "2026-08-30T00:00:00Z");
        let connection = library.connection().unwrap();
        record_asset_opened(&connection, "asset-a", "2026-08-30T01:00:00Z").unwrap();
        record_asset_opened(&connection, "asset-a", "2026-08-30T02:00:00Z").unwrap();
        record_assets_exposed(&connection, &["asset-a".into()], "2026-08-30T03:00:00Z").unwrap();
        record_assets_exposed(&connection, &["asset-a".into()], "2026-08-30T04:00:00Z").unwrap();

        let row = connection
            .query_row(
                "SELECT open_count, exposure_count, last_opened_at, last_exposed_at FROM asset_activity WHERE asset_id = 'asset-a'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row, (2, 2, "2026-08-30T02:00:00Z".to_string(), "2026-08-30T04:00:00Z".to_string()));
    }

    #[test]
    fn rejects_unknown_assets_and_unparsable_timestamps() {
        let library = fixture();
        insert_asset(&library, "asset-a", "2026-08-30T00:00:00Z");
        let connection = library.connection().unwrap();
        assert!(matches!(
            record_asset_opened(&connection, "asset-missing", "2026-08-30T01:00:00Z"),
            Err(LibraryError::AssetNotFound)
        ));
        assert!(matches!(
            record_assets_exposed(&connection, &["asset-missing".into()], "2026-08-30T01:00:00Z"),
            Err(LibraryError::AssetNotFound)
        ));
        assert!(record_asset_opened(&connection, "asset-a", "not-a-time").is_err());
 assert_eq!(
            connection
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM asset_activity", [], |row| row.get(0))
                .unwrap(),
            0,
        );
    }

    #[test]
    fn persists_and_loads_a_daily_slate_transactionally() {
        let library = fixture();
        for id in ["asset-a", "asset-b", "asset-c", "asset-d"] {
            insert_asset(&library, id, "2026-08-30T00:00:00Z");
        }
        let connection = library.connection().unwrap();
        let slate = RevisitSlate {
            local_date: "2026-08-30".into(),
            created_at: "2026-08-30T09:00:00Z".into(),
            revision: 3,
            bundles: vec![
                RevisitBundle { id: "bundle-0".into(), kind: "rediscovery".into(), title: "다시 만난 자산".into(), reason: "8개월 동안 열지 않은 즐겨찾기".into(), asset_ids: vec!["asset-a".into(), "asset-b".into()], revision: 0 },
                RevisitBundle { id: "bundle-1".into(), kind: "creator".into(), title: "작가 집중 보기".into(), reason: "최근 열어본 자산의 작가".into(), asset_ids: vec!["asset-c".into(), "asset-d".into()], revision: 0 },
            ],
        };
        save_daily_slate(&connection, &slate).unwrap();
        save_daily_slate(&connection, &slate).unwrap();

        let loaded = load_daily_slate(&connection, "2026-08-30").unwrap().unwrap();
        assert_eq!(loaded.local_date, "2026-08-30");
        assert_eq!(loaded.revision, 3);
        assert_eq!(loaded.bundles.len(), 2);
        assert_eq!(loaded.bundles[0].asset_ids, vec!["asset-a".to_string(), "asset-b".to_string()]);
        assert_eq!(loaded.bundles[1].reason, "최근 열어본 자산의 작가");
        assert!(load_daily_slate(&connection, "2026-08-29").unwrap().is_none());


        let duplicate = RevisitSlate {
            bundles: vec![
                RevisitBundle { id: "dup-0".into(), kind: "rediscovery".into(), title: "중복".into(), reason: "이유".into(), asset_ids: vec!["asset-a".into(), "asset-b".into()], revision: 0 },
                RevisitBundle { id: "dup-1".into(), kind: "creator".into(), title: "중복".into(), reason: "이유".into(), asset_ids: vec!["asset-b".into(), "asset-c".into()], revision: 0 },
            ],
            ..slate.clone()
        };
        assert!(save_daily_slate(&connection, &duplicate).is_err());
    }

    fn insert_favorite_with_creator(library: &Library, id: &str, creator_handle: &str, favorite: bool, collected_at: &str) {
        library
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO assets (
                    id, content_hash, media_kind, original_name, relative_path,
                    thumbnail_relative_path, byte_size, width, height, collected_at, favorite, creator_handle
                 ) VALUES (?1, ?2, 'image', ?3, ?4, ?5, 1, 400, 200, ?6, ?7, ?8)",
                params![id, format!("hash-{id}"), format!("{id}.png"), format!("assets/{id}.png"), format!("thumbnails/{id}.webp"), collected_at, favorite, creator_handle],
            )
            .unwrap();
    }

    #[test]
    fn generated_slate_is_bounded_unique_and_fixed_for_the_day() {
        let library = fixture();
        for index in 0..60 {
            insert_favorite_with_creator(&library, &format!("asset-{index}"), "creator", index % 3 == 0, "2026-08-30T00:00:00Z");
        }
        let connection = library.connection().unwrap();

        let slate = get_or_create_revisit_slate(&connection, "2026-08-30", "2026-08-30T09:00:00Z").unwrap();
         assert!((6..=10).contains(&slate.bundles.len()));
        let mut all_assets = std::collections::BTreeSet::new();
        for bundle in &slate.bundles {
            assert!((2..=20).contains(&bundle.asset_ids.len()));
            let before = all_assets.len();
            for id in &bundle.asset_ids {
                all_assets.insert(id.clone());
            }
        }

        let again = get_or_create_revisit_slate(&connection, "2026-08-30", "2026-08-30T10:00:00Z").unwrap();
        assert_eq!(again.bundles, slate.bundles);
    }

    #[test]
    fn bundle_reshuffle_keeps_neighbors_and_bumps_only_target() {
        let library = fixture();
        for index in 0..60 {
            insert_favorite_with_creator(&library, &format!("asset-{index}"), "creator", index % 3 == 0, "2026-08-30T00:00:00Z");
        };
        let slate = {
            let connection = library.connection().unwrap();
            get_or_create_revisit_slate(&connection, "2026-08-30", "2026-08-30T09:00:00Z").unwrap()
        };;
        let target_index = 1;
        let target = slate.bundles[target_index].clone();
        let previous = slate.bundles[0].clone();
        let next = slate.bundles.get(target_index + 1).cloned();
;
        let reshuffled = {
            let connection = library.connection().unwrap();
            reshuffle_revisit_bundle(&connection, "2026-08-30", &target.id, "2026-08-30T09:30:00Z").unwrap()
        };;;
        assert_ne!(reshuffled.bundles[target_index].asset_ids, Vec::<String>::new());
        assert_eq!(reshuffled.bundles[target_index].revision, target.revision + 1);
        assert_eq!(reshuffled.bundles[0], previous);
        if let Some(next) = next {
            assert_eq!(reshuffled.bundles[target_index + 1], next);
        };
        {
            let connection = library.connection().unwrap();;
            let count = connection.query_row::<i64, _, _>("SELECT COUNT(*) FROM revisit_preferences", [], |row| row.get(0)).unwrap();;
            assert_eq!(count, 0);
        };
    }

    #[test]
    fn slate_reshuffle_regenerates_every_bundle() {
        let library = fixture();
        for index in 0..60 {
            insert_favorite_with_creator(&library, &format!("asset-{index}"), "creator", index % 3 == 0, "2026-08-30T00:00:00Z");
        }
        let slate = {
            let connection = library.connection().unwrap();
            get_or_create_revisit_slate(&connection, "2026-08-30", "2026-08-30T09:00:00Z").unwrap()
        };
        let first = slate.bundles[0].clone();

        let reshuffled = {
            let connection = library.connection().unwrap();
            reshuffle_revisit_slate(&connection, "2026-08-30", "2026-08-30T10:00:00Z").unwrap()
        };
        assert_eq!(reshuffled.revision, slate.revision + 1);
        assert_eq!(reshuffled.bundles.len(), slate.bundles.len());
        for (before, after) in slate.bundles.iter().zip(reshuffled.bundles.iter()) {
            assert_ne!(before.id, after.id);
        }
        let _ = first;
        let count = {
            let connection = library.connection().unwrap();
            connection.query_row::<i64, _, _>("SELECT COUNT(*) FROM revisit_preferences", [], |row| row.get(0)).unwrap()
        };
        assert_eq!(count, 0);
    }
}
impl super::Library {
    pub fn get_or_create_revisit_slate(&self, local_date: &str, now_utc: &str) -> Result<RevisitSlate, LibraryError> {
        self.connection()?.with_lock(|connection| get_or_create_revisit_slate(connection, local_date, now_utc))
    }

    pub fn reshuffle_revisit_bundle(&self, local_date: &str, bundle_id: &str, now_utc: &str) -> Result<RevisitSlate, LibraryError> {
        self.connection()?.with_lock(|connection| reshuffle_revisit_bundle(connection, local_date, bundle_id, now_utc))
    }

    pub fn reshuffle_revisit_slate(&self, local_date: &str, now_utc: &str) -> Result<RevisitSlate, LibraryError> {
        self.connection()?.with_lock(|connection| reshuffle_revisit_slate(connection, local_date, now_utc))
    }

    pub fn record_asset_opened(&self, asset_id: &str, opened_at: &str) -> Result<(), LibraryError> {
        self.connection()?.with_lock(|connection| record_asset_opened(connection, asset_id, opened_at))
    }

    pub fn record_assets_exposed(&self, asset_ids: &[String], exposed_at: &str) -> Result<(), LibraryError> {
        self.connection()?.with_lock(|connection| record_assets_exposed(connection, asset_ids, exposed_at))
    }

    pub fn set_revisit_preference(&self, dimension: &str, value: &str, now_utc: &str) -> Result<(), LibraryError> {
        self.connection()?.with_lock(|connection| {
            connection.execute(
                "INSERT INTO revisit_preferences (dimension, value, weight, updated_at) VALUES (?1, ?2, -1, ?3)
                 ON CONFLICT(dimension, value) DO UPDATE SET weight = revisit_preferences.weight - 1, updated_at = ?3",
                params![dimension, value, now_utc],
            )?;
            Ok(())
        })
    }
}

trait WithLock {
    fn with_lock<T>(self, f: impl FnOnce(&Connection) -> Result<T, LibraryError>) -> Result<T, LibraryError>;
}

impl WithLock for super::LockedConnection<'_> {
    fn with_lock<T>(self, f: impl FnOnce(&Connection) -> Result<T, LibraryError>) -> Result<T, LibraryError> {
        f(&self)
    }
}
