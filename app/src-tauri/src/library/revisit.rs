use std::collections::{BTreeMap, BTreeSet, HashMap};

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
    if let Some(existing) = load_daily_slate(connection, local_date)? {
        if slate_uses_current_algorithm(&existing) {
            return Ok(existing);
        }
        let mut slate = generate_daily_slate(connection, local_date, now_utc, existing.revision + 1)?;
        save_daily_slate(connection, &slate)?;
        slate.revision = load_revision(connection, local_date)?;
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
    now_utc: &str,
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
    let preferences = load_preference_weights(connection)?;
    let now = parse_utc_timestamp(now_utc)?;
    let bundle_revision = bundle.revision + 1;
    if let Some(regenerated) = generate_bundle(&context, &preferences, &bundle.kind, local_date, &now, bundle_revision, &other) {
        bundle.asset_ids = regenerated.asset_ids.into_iter().filter(|id| !other.contains(id)).collect();
        bundle.revision = bundle_revision;
        bundle.title = regenerated.meta.title.to_string();
        bundle.reason = regenerated.reason;
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

const BUNDLE_ID_PREFIX: &str = "revisit-v2-";
const BUNDLE_KINDS: [&str; 4] = ["rediscovery", "creator", "date", "surprise"];
const MAX_BUNDLES: usize = 10;
const MIN_BUNDLE_ASSETS: usize = 6;
const MAX_BUNDLE_ASSETS: usize = 20;
const STRICT_EXPOSURE_COOLDOWN_DAYS: i64 = 14;
const STRICT_OPEN_COOLDOWN_DAYS: i64 = 30;
const RELAXED_EXPOSURE_COOLDOWN_DAYS: i64 = 3;
const RELAXED_OPEN_COOLDOWN_DAYS: i64 = 7;
const MIN_PREFERENCE_WEIGHT: i64 = -5;

type PreferenceWeights = HashMap<(String, String), i64>;

#[derive(Clone)]
struct Candidate {
    asset: AssetSummary,
    score: i64,
}

struct BundleMeta {
    title: &'static str,
    reason_key: &'static str,
}

struct GeneratedBundle {
    meta: BundleMeta,
    reason: String,
    asset_ids: Vec<String>,
}

fn bundle_meta(kind: &str) -> BundleMeta {
    match kind {
        "rediscovery" => BundleMeta { title: "다시 만난 자산", reason_key: "forgotten" },
        "creator" => BundleMeta { title: "작가 다시보기", reason_key: "creator" },
        "date" => BundleMeta { title: "이맘때 모은 자산", reason_key: "date" },
        _ => BundleMeta { title: "뜻밖의 다시보기", reason_key: "surprise" },
    }
}

struct RecommendationContext {
    assets: Vec<AssetSummary>,
    activity: HashMap<String, ActivityRow>,
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
            .collect::<Result<HashMap<String, ActivityRow>, _>>()?;
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

fn slate_uses_current_algorithm(slate: &RevisitSlate) -> bool {
    !slate.bundles.is_empty() && slate.bundles.iter().all(|bundle| bundle.id.starts_with(BUNDLE_ID_PREFIX))
}

fn generate_daily_slate(
    connection: &Connection,
    local_date: &str,
    now_utc: &str,
    revision: i64,
) -> Result<RevisitSlate, LibraryError> {
    let context = RecommendationContext::load(connection)?;
    let preferences = load_preference_weights(connection)?;
    let now = parse_utc_timestamp(now_utc)?;
    let mut used = BTreeSet::new();
    let mut bundles = Vec::new();
    let mut attempt = 0_i64;

    let mut schedule = kind_schedule(&preferences, &format!("{local_date}-{revision}"));
    if schedule.is_empty() {
        schedule.extend(BUNDLE_KINDS);
    }
    for kind in schedule {
        if bundles.len() >= MAX_BUNDLES { break; }
        let kind_revision = revision + attempt;
        attempt += 1;
        if let Some(generated) = generate_bundle(&context, &preferences, kind, local_date, &now, kind_revision, &used) {
            let unique: Vec<String> = generated.asset_ids.into_iter().filter(|id| !used.contains(id)).collect();
            if unique.len() < 2 { continue; }
            for id in &unique { used.insert(id.clone()); }
            bundles.push(RevisitBundle {
                id: format!("{BUNDLE_ID_PREFIX}{local_date}-{kind}-{kind_revision}"),
                kind: kind.to_string(),
                title: generated.meta.title.to_string(),
                reason: generated.reason,
                asset_ids: unique,
                revision: 0,
            });
        }
    }

    if bundles.len() < 4 {
        for kind in BUNDLE_KINDS {
            if bundles.len() >= 4 || bundles.len() >= MAX_BUNDLES { break; }
            let kind_revision = revision + 100 + attempt;
            attempt += 1;
            if let Some(generated) = generate_bundle(&context, &preferences, kind, local_date, &now, kind_revision, &used) {
                let unique: Vec<String> = generated.asset_ids.into_iter().filter(|id| !used.contains(id)).collect();
                if unique.len() < 2 { continue; }
                for id in &unique { used.insert(id.clone()); }
                bundles.push(RevisitBundle {
                    id: format!("{BUNDLE_ID_PREFIX}{local_date}-{kind}-{kind_revision}"),
                    kind: kind.to_string(),
                    title: generated.meta.title.to_string(),
                    reason: generated.reason,
                    asset_ids: unique,
                    revision: 0,
                });
            }
        }
    }

    Ok(RevisitSlate { local_date: local_date.to_string(), created_at: now_utc.to_string(), revision, bundles })
}

fn load_preference_weights(connection: &Connection) -> Result<PreferenceWeights, LibraryError> {
    let mut statement = connection.prepare("SELECT dimension, value, weight FROM revisit_preferences")?;
    let rows = statement.query_map([], |row| Ok(((row.get(0)?, row.get(1)?), row.get(2)?)))?;
    rows.collect::<Result<PreferenceWeights, _>>().map_err(LibraryError::from)
}

fn preference_weight(preferences: &PreferenceWeights, dimension: &str, value: &str) -> i64 {
    preferences.get(&(dimension.to_string(), value.to_string())).copied().unwrap_or(0)
}

fn kind_schedule(preferences: &PreferenceWeights, seed: &str) -> Vec<&'static str> {
    let mut schedule = Vec::new();
    for kind in BUNDLE_KINDS {
        let weight = preference_weight(preferences, "recommendation_type", kind);
        let repetitions = match weight {
            0.. => 3,
            -1 => 2,
            -2 => 1,
            _ => 0,
        };
        schedule.extend(std::iter::repeat_n(kind, repetitions));
    }
    shuffle_values(schedule, seed)
}

fn seed_from(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn shuffle_values<T>(mut values: Vec<T>, seed: &str) -> Vec<T> {
    let mut state = seed_from(seed);
    if !values.is_empty() {
        for index in (1..values.len()).rev() {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let swap = (state >> 33) as usize % (index + 1);
            values.swap(index, swap);
        }
    }
    values
}

fn ordered_candidates(candidates: Vec<Candidate>, seed: &str) -> Vec<Candidate> {
    let mut candidates = shuffle_values(candidates, seed);
    candidates.sort_by(|left, right| right.score.cmp(&left.score));
    candidates
}

fn reason_text(reason_key: &str) -> String {
    match reason_key {
        "forgotten" => "오랫동안 다시 열지 않은 자산".to_string(),
        "date" => "이맘때 수집한 자산".to_string(),
        "surprise" => "최근 노출이 적었던 자산".to_string(),
        _ => "한동안 덜 본 작가의 자산".to_string(),
    }
}

fn generate_bundle(
    context: &RecommendationContext,
    preferences: &PreferenceWeights,
    kind: &str,
    local_date: &str,
    now: &DateTime<chrono::Utc>,
    revision: i64,
    excluded: &BTreeSet<String>,
) -> Option<GeneratedBundle> {
    let seed = seed_from(&format!("{local_date}-{kind}-{revision}"));
    let (candidates, custom_reason) = match kind {
        "rediscovery" => (rediscovery_candidates(context, now), None),
        "creator" => creator_spotlight(context, preferences, now, seed),
        "date" => (date_capsule(context, local_date, now), None),
        _ => (surprise_mix(context, now, seed), None),
    };
    let candidates = candidates.into_iter().filter(|candidate| !excluded.contains(&candidate.asset.id)).collect();
    let candidates = apply_cooldown(candidates, context, now);
    let ordered = ordered_candidates(candidates, &format!("{local_date}-{kind}-{revision}"));
    let mut chosen = Vec::new();
    for candidate in ordered {
        if chosen.len() >= MAX_BUNDLE_ASSETS { break; }
        if !chosen.contains(&candidate.asset.id) {
            chosen.push(candidate.asset.id);
        }
    }
    if chosen.len() < 2 { return None; }
    let meta = bundle_meta(kind);
    Some(GeneratedBundle {
        reason: custom_reason.unwrap_or_else(|| reason_text(meta.reason_key)),
        meta,
        asset_ids: chosen,
    })
}

#[derive(Clone, Copy)]
enum CooldownTier { Strict, Relaxed, Open }

fn apply_cooldown(
    candidates: Vec<Candidate>,
    context: &RecommendationContext,
    now: &DateTime<chrono::Utc>,
) -> Vec<Candidate> {
    if candidates.len() < 2 { return candidates; }
    let target = candidates.len().min(MIN_BUNDLE_ASSETS).max(2);
    for tier in [CooldownTier::Strict, CooldownTier::Relaxed] {
        let filtered: Vec<Candidate> = candidates.iter().filter(|candidate| passes_cooldown(context, &candidate.asset.id, now, tier)).cloned().collect();
        if filtered.len() >= target { return filtered; }
    }
    candidates.into_iter().filter(|candidate| passes_cooldown(context, &candidate.asset.id, now, CooldownTier::Open)).collect()
}

fn passes_cooldown(
    context: &RecommendationContext,
    asset_id: &str,
    now: &DateTime<chrono::Utc>,
    tier: CooldownTier,
) -> bool {
    let Some(row) = context.activity(asset_id) else { return true };
    let (exposure_days, open_days) = match tier {
        CooldownTier::Strict => (STRICT_EXPOSURE_COOLDOWN_DAYS, STRICT_OPEN_COOLDOWN_DAYS),
        CooldownTier::Relaxed => (RELAXED_EXPOSURE_COOLDOWN_DAYS, RELAXED_OPEN_COOLDOWN_DAYS),
        CooldownTier::Open => return true,
    };
    is_older_than(row.last_exposed_at.as_deref(), now, exposure_days)
        && is_older_than(row.last_opened_at.as_deref(), now, open_days)
}

fn is_older_than(value: Option<&str>, now: &DateTime<chrono::Utc>, days: i64) -> bool {
    let Some(parsed) = value.and_then(|value| DateTime::parse_from_rfc3339(value).ok()).map(|value| value.with_timezone(&chrono::Utc)) else { return true };
    now.signed_duration_since(parsed).num_days() >= days
}

fn days_since(value: Option<&str>, now: &DateTime<chrono::Utc>, missing: i64) -> i64 {
    value.and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| now.signed_duration_since(value.with_timezone(&chrono::Utc)).num_days().max(0))
        .unwrap_or(missing)
}

fn collected_age_days(asset: &AssetSummary, now: &DateTime<chrono::Utc>) -> i64 {
    days_since(Some(asset.collected_at.as_str()), now, 0)
}

fn base_score(context: &RecommendationContext, asset: &AssetSummary, now: &DateTime<chrono::Utc>) -> i64 {
    let row = context.activity(&asset.id);
    let open_days = days_since(row.and_then(|row| row.last_opened_at.as_deref()), now, 365).min(730);
    let exposure_days = days_since(row.and_then(|row| row.last_exposed_at.as_deref()), now, 180).min(365);
    let collected_days = collected_age_days(asset, now).min(1825);
    let open_count = row.map(|row| row.open_count).unwrap_or(0).clamp(0, 50);
    let exposure_count = row.map(|row| row.exposure_count).unwrap_or(0).clamp(0, 100);
    open_days * 4 + exposure_days * 3 + collected_days / 10
        - open_count * 24 - exposure_count * 10
        + if asset.favorite { 180 } else { 0 }
}

fn rediscovery_candidates(context: &RecommendationContext, now: &DateTime<chrono::Utc>) -> Vec<Candidate> {
    context.assets.iter().map(|asset| {
        let row = context.activity(&asset.id);
        let never_opened = row.and_then(|row| row.last_opened_at.as_ref()).is_none();
        Candidate {
            asset: asset.clone(),
            score: base_score(context, asset, now)
                + collected_age_days(asset, now).min(1825) / 4
                + if never_opened { 120 } else { 0 },
        }
    }).collect()
}

fn creator_spotlight(
    context: &RecommendationContext,
    preferences: &PreferenceWeights,
    now: &DateTime<chrono::Utc>,
    seed: u64,
) -> (Vec<Candidate>, Option<String>) {
    let mut groups: BTreeMap<String, Vec<&AssetSummary>> = BTreeMap::new();
    for asset in &context.assets {
        if let Some(key) = creator_key(asset) {
            groups.entry(key).or_default().push(asset);
        }
    }
    let mut ranked = Vec::new();
    for (key, group) in groups {
        if group.len() < 3 { continue; }
        let creator_penalty = preference_weight(preferences, "creator", &key) * 300;
        let mut candidates: Vec<Candidate> = group.iter().map(|asset| Candidate {
            asset: (*asset).clone(),
            score: base_score(context, asset, now) + creator_penalty,
        }).collect();
        candidates.sort_by(|left, right| right.score.cmp(&left.score));
        let group_score = candidates.iter().take(6).map(|candidate| candidate.score).sum::<i64>() + creator_penalty;
        let tie = seed_from(&format!("{seed}-{key}"));
        let label = group[0].creator_name.clone()
            .or_else(|| group[0].creator_handle.clone())
            .or_else(|| group[0].creator_url.clone())
            .unwrap_or_else(|| "한 작가".to_string());
        ranked.push((group_score, tie, candidates, label));
    }
    ranked.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    ranked.into_iter().next().map(|(_, _, candidates, label)| {
        (candidates, Some(format!("{label} · 한동안 덜 본 자산")))
    }).unwrap_or_default()
}

fn creator_key(asset: &AssetSummary) -> Option<String> {
    asset.creator_handle.clone().or_else(|| asset.creator_url.clone())
}

fn date_capsule(context: &RecommendationContext, local_date: &str, now: &DateTime<chrono::Utc>) -> Vec<Candidate> {
    let Some(today_month) = local_date.get(5..7).and_then(|part| part.parse::<u32>().ok()) else { return Vec::new() };
    context.assets.iter().filter(|asset| {
        asset.collected_at.get(5..7).and_then(|part| part.parse::<u32>().ok()).unwrap_or(0) == today_month
    }).map(|asset| Candidate {
        asset: asset.clone(),
        score: base_score(context, asset, now) + collected_age_days(asset, now).min(3650) / 12,
    }).collect()
}

fn surprise_mix(context: &RecommendationContext, now: &DateTime<chrono::Utc>, seed: u64) -> Vec<Candidate> {
    let target_kind = match (seed as usize) % 3 {
        0 => crate::library::models::MediaSummary::Gif,
        _ => crate::library::models::MediaSummary::Image,
    };
    let matched: Vec<&AssetSummary> = context.assets.iter()
        .filter(|asset| std::mem::discriminant(&asset.media) == std::mem::discriminant(&target_kind))
        .collect();
    if matched.len() < MIN_BUNDLE_ASSETS { return Vec::new(); }
    matched.into_iter().map(|asset| {
        let row = context.activity(&asset.id);
        let unseen_bonus = if row.map(|row| row.exposure_count).unwrap_or(0) == 0 { 120 } else { 0 };
        Candidate { asset: asset.clone(), score: base_score(context, asset, now) + unseen_bonus }
    }).collect()
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
         assert!((2..=10).contains(&slate.bundles.len()));
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
    fn recent_exposure_is_a_hard_first_tier_when_fresh_alternatives_exist() {
        let library = fixture();
        for index in 0..12 {
            insert_favorite_with_creator(&library, &format!("asset-{index}"), "creator", false, "2025-01-01T00:00:00Z");
        }
        let connection = library.connection().unwrap();
        for index in 0..6 {
            record_assets_exposed(&connection, &[format!("asset-{index}")], "2026-09-08T00:00:00Z").unwrap();
        }
        let context = RecommendationContext::load(&connection).unwrap();
        let now = parse_utc_timestamp("2026-09-08T01:00:00Z").unwrap();
        let filtered = apply_cooldown(rediscovery_candidates(&context, &now), &context, &now);
        assert_eq!(filtered.len(), 6);
        let recent: BTreeSet<String> = (0..6).map(|index| format!("asset-{index}")).collect();
        assert!(filtered.iter().all(|candidate| !recent.contains(&candidate.asset.id)));
    }

    #[test]
    fn less_view_feedback_is_bounded_and_removes_a_disliked_type_from_primary_schedule() {
        let library = fixture();
        for _ in 0..10 {
            library.set_revisit_preference("recommendation_type", "surprise", "2026-09-08T01:00:00Z").unwrap();
        }
        let connection = library.connection().unwrap();
        let preferences = load_preference_weights(&connection).unwrap();
        assert_eq!(preference_weight(&preferences, "recommendation_type", "surprise"), -5);
        assert!(!kind_schedule(&preferences, "day").contains(&"surprise"));
    }

    #[test]
    fn creator_feedback_moves_creator_spotlight_to_another_creator() {
        let library = fixture();
        for index in 0..3 {
            insert_favorite_with_creator(&library, &format!("a-{index}"), "creator-a", false, "2025-01-01T00:00:00Z");
            insert_favorite_with_creator(&library, &format!("b-{index}"), "creator-b", false, "2025-01-01T00:00:00Z");
        }
        for _ in 0..5 { library.set_revisit_preference("creator", "creator-a", "2026-09-08T01:00:00Z").unwrap(); }
        let connection = library.connection().unwrap();
        let context = RecommendationContext::load(&connection).unwrap();
        let preferences = load_preference_weights(&connection).unwrap();
        let now = parse_utc_timestamp("2026-09-08T01:00:00Z").unwrap();
        let (candidates, _) = creator_spotlight(&context, &preferences, &now, 7);
        assert!(!candidates.is_empty());
        assert!(candidates.iter().all(|candidate| candidate.asset.creator_handle.as_deref() == Some("creator-b")));
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
        parse_utc_timestamp(now_utc)?;
        self.connection()?.with_lock(|connection| {
            connection.execute(
                "INSERT INTO revisit_preferences (dimension, value, weight, updated_at) VALUES (?1, ?2, -1, ?3)
                 ON CONFLICT(dimension, value) DO UPDATE SET
                    weight = CASE WHEN revisit_preferences.weight > ?4 THEN revisit_preferences.weight - 1 ELSE ?4 END,
                    updated_at = ?3",
                params![dimension, value, now_utc, MIN_PREFERENCE_WEIGHT],
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
