//! Artist hub (ARTIST-001): artists grouped from asset creator keys, PC-authoritative.
//!
//! An asset's creator key is `COALESCE(creator_handle, creator_url)`. A key the user never
//! touched is an *implicit* artist whose id is the bare key; renaming, pinning, hiding,
//! merging or assigning creates an `artists` row and the id becomes `artist:<id>`. Assets
//! without a creator are `unknown:none` (no source either) or `unknown:source`.
//! Everything here is a link record: asset creator fields are never written.
//!
//! The scope rules mirror the `asset_artist_scope` view (migration 0100), which the asset
//! filter uses, so an artist page lists exactly the assets its summary counts.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::error::LibraryError;
use super::revisit::{parse_local_date, parse_utc_timestamp};

pub(crate) const ARTIST_PREFIX: &str = "artist:";
pub(crate) const UNKNOWN_NONE: &str = "unknown:none";
pub(crate) const UNKNOWN_SOURCE: &str = "unknown:source";
const COVER_LIMIT: usize = 12;
const ROW_ASSET_LIMIT: usize = 12;
const MAX_NAME_CHARS: usize = 120;
const MAX_ASSIGN_ASSETS: usize = 5000;
const DEFAULT_LIST_LIMIT: u32 = 200;
const MAX_LIST_LIMIT: u32 = 2000;
const LONG_UNSEEN_DAYS: i64 = 365;
const FRESH_DAYS: i64 = 7;

// ---------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSettings {
    pub main_min_count: u32,
    pub recent_min_count: u32,
    pub recent_days: u32,
}

impl Default for ArtistSettings {
    fn default() -> Self {
        Self {
            main_min_count: 5,
            recent_min_count: 2,
            recent_days: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSummary {
    /// `artist:<id>` or the bare creator key of an implicit artist.
    pub id: String,
    pub label: String,
    /// The user-defined name, when set.
    pub display_name: Option<String>,
    /// The name the sources give (most frequent creator name, else the handle).
    pub source_name: Option<String>,
    /// Creator keys on this artist (handles or creator URLs).
    pub keys: Vec<String>,
    pub asset_count: u32,
    /// Assets saved within the tier's recent window.
    pub recent_count: u32,
    pub first_saved_at: Option<String>,
    pub last_saved_at: Option<String>,
    pub last_opened_at: Option<String>,
    pub pinned: bool,
    pub hidden: bool,
    /// 주요 작가 by the tier rule (pins and hiding do not change it).
    pub main: bool,
    /// Newest first.
    pub cover_asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistOverview {
    pub settings: ArtistSettings,
    /// Every visible (not hidden) artist.
    pub total: u32,
    pub main: u32,
    pub other: u32,
    pub two_to_four: u32,
    pub single: u32,
    pub hidden: u32,
    pub unknown_none: u32,
    pub unknown_source: u32,
    pub merge_suggestions: u32,
    /// Assets 출처에서 작가 채우기 can fill offline (x.com status URLs).
    pub source_fillable: u32,
    pub pinned: Vec<ArtistSummary>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArtistBucket {
    /// Every visible artist, pinned first.
    #[default]
    All,
    Pinned,
    Main,
    Other,
    TwoToFour,
    Single,
    Hidden,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ArtistSort {
    #[default]
    Recent,
    Count,
    Name,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArtistListQuery {
    pub search: Option<String>,
    pub bucket: ArtistBucket,
    pub sort: ArtistSort,
    pub offset: u32,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistListPage {
    pub total: u32,
    pub artists: Vec<ArtistSummary>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistMemberInfo {
    pub key: String,
    pub name: Option<String>,
    pub host: Option<String>,
    pub asset_count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistAssignmentInfo {
    /// `manual` (직접 지정) or `source_url` (출처에서 채움).
    pub source: String,
    pub asset_count: u32,
    pub latest_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSourceCount {
    /// `x.com`, `pixiv`, …, or `manual` for 직접 지정.
    pub host: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistRediscovery {
    pub total: u32,
    pub asset_ids: Vec<String>,
    /// For N년 전 오늘: how many years ago and that local date.
    pub years_ago: Option<u32>,
    pub local_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistDetail {
    pub summary: ArtistSummary,
    pub members: Vec<ArtistMemberInfo>,
    pub assignments: Vec<ArtistAssignmentInfo>,
    pub sources: Vec<ArtistSourceCount>,
    pub on_this_day: Option<ArtistRediscovery>,
    pub long_unseen: Option<ArtistRediscovery>,
    pub merge_suggestions: Vec<ArtistMergeSuggestion>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistTodayRow {
    pub artist: ArtistSummary,
    /// `anniversary`, `unseen` or `fresh`.
    pub kind: String,
    pub reason: String,
    pub asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistMergeSuggestion {
    /// The dismissal key pair, `key_a < key_b`.
    pub key_a: String,
    pub key_b: String,
    /// `handle` (same handle up to case), `name` (same name on different sites) or
    /// `similar` (handles differ only by trailing digits).
    pub kind: String,
    /// Weak evidence: a forum source or a merely similar handle.
    pub uncertain: bool,
    pub left: ArtistSummary,
    pub right: ArtistSummary,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFillSite {
    pub host: String,
    pub asset_count: u32,
    /// `auto` (read offline from the URL) or `manual` (작가 지정 by hand).
    pub method: String,
    pub fillable: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFillGroup {
    pub handle: String,
    pub asset_count: u32,
    pub sample_asset_ids: Vec<String>,
    /// The existing artist the handle joins; `None` creates a new artist.
    pub target_id: Option<String>,
    pub target_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFillPreview {
    /// Assets with a source URL but no artist.
    pub total: u32,
    pub sites: Vec<SourceFillSite>,
    pub fillable: u32,
    /// x.com URLs that carry no handle (for example `/i/web/status/…`).
    pub without_handle: u32,
    pub existing_artists: u32,
    pub new_artists: u32,
    pub groups: Vec<SourceFillGroup>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFillResult {
    pub assigned: u32,
    pub created_artists: u32,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtistCaptionLabels {
    /// Creator key -> artist label, for keys on an artist row (renamed or merged).
    pub by_key: HashMap<String, String>,
    /// Asset id -> artist label, for assigned assets.
    pub by_asset: HashMap<String, String>,
}

// ---------------------------------------------------------------------------------------
// Search (name, handle, 초성)
// ---------------------------------------------------------------------------------------

const CHOSEONG: [char; 19] = [
    'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ',
    'ㅌ', 'ㅍ', 'ㅎ',
];

fn initial_consonant(character: char) -> Option<char> {
    let code = character as u32;
    (0xAC00..=0xD7A3)
        .contains(&code)
        .then(|| CHOSEONG[((code - 0xAC00) / 588) as usize])
}

fn search_chars(text: &str) -> Vec<char> {
    text.chars()
        .filter(|character| !character.is_whitespace() && *character != '@')
        .flat_map(char::to_lowercase)
        .collect()
}

/// Case-insensitive substring match where a query consonant (ㅅ) also matches any Hangul
/// syllable with that initial (서, 소, 스), so `ㅅㄹ` finds 서리 and 소리꾼 and `하ㄴ` finds 하늘.
pub(crate) fn matches_search(text: &str, query: &str) -> bool {
    let query = search_chars(query);
    if query.is_empty() {
        return true;
    }
    let text = search_chars(text);
    text.windows(query.len()).any(|window| {
        window.iter().zip(&query).all(|(target, wanted)| {
            target == wanted
                || (CHOSEONG.contains(wanted) && initial_consonant(*target) == Some(*wanted))
        })
    })
}

// ---------------------------------------------------------------------------------------
// Snapshot: one read of everything the hub needs
// ---------------------------------------------------------------------------------------

struct AssetRow {
    id: String,
    creator_name: Option<String>,
    key: Option<String>,
    creator_url: Option<String>,
    source_url: Option<String>,
    collected_at: String,
}

struct ArtistRow {
    display_name: Option<String>,
    pinned: bool,
    hidden: bool,
}

struct Assignment {
    artist_id: String,
    source: String,
    created_at: String,
}

struct Snapshot {
    settings: ArtistSettings,
    artists: HashMap<String, ArtistRow>,
    members: HashMap<String, String>,
    assignments: HashMap<String, Assignment>,
    /// Normal assets, newest first.
    assets: Vec<AssetRow>,
    opened: HashMap<String, String>,
    dismissals: HashSet<(String, String)>,
}

#[derive(Default)]
struct Group<'a> {
    assets: Vec<&'a AssetRow>,
    names: BTreeMap<String, u32>,
    keys: BTreeMap<String, u32>,
}

fn load_settings(connection: &Connection) -> Result<ArtistSettings, LibraryError> {
    Ok(connection
        .query_row("SELECT main_min_count, recent_min_count, recent_days FROM artist_settings WHERE singleton = 1", [], |row| {
            Ok(ArtistSettings { main_min_count: row.get(0)?, recent_min_count: row.get(1)?, recent_days: row.get(2)? })
        })
        .optional()?
        .unwrap_or_default())
}

impl Snapshot {
    fn load(connection: &Connection) -> Result<Self, LibraryError> {
        let settings = load_settings(connection)?;
        let artists = connection
            .prepare("SELECT id, display_name, pinned, hidden FROM artists")?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ArtistRow {
                        display_name: row.get(1)?,
                        pinned: row.get(2)?,
                        hidden: row.get(3)?,
                    },
                ))
            })?
            .collect::<Result<HashMap<_, _>, _>>()?;
        let members = connection
            .prepare("SELECT creator_key, artist_id FROM artist_members")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<HashMap<_, _>, _>>()?;
        let assignments = connection
            .prepare(
                "SELECT asset_id, artist_id, source, created_at FROM asset_artist_assignments",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Assignment {
                        artist_id: row.get(1)?,
                        source: row.get(2)?,
                        created_at: row.get(3)?,
                    },
                ))
            })?
            .collect::<Result<HashMap<_, _>, _>>()?;
        let assets = connection
            .prepare(
                "SELECT id, creator_name, COALESCE(creator_handle, creator_url), creator_url, source_url, collected_at
                 FROM assets WHERE status = 'normal' ORDER BY collected_at DESC, id DESC",
            )?
            .query_map([], |row| {
                Ok(AssetRow {
                    id: row.get(0)?,
                    creator_name: row.get::<_, Option<String>>(1)?.map(|name| name.trim().to_owned()).filter(|name| !name.is_empty()),
                    key: row.get(2)?,
                    creator_url: row.get(3)?,
                    source_url: row.get(4)?,
                    collected_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let opened = connection
            .prepare("SELECT asset_id, last_opened_at FROM asset_activity WHERE last_opened_at IS NOT NULL")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<Result<HashMap<_, _>, _>>()?;
        let dismissals = connection
            .prepare("SELECT key_a, key_b FROM artist_merge_dismissals")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<HashSet<_>, _>>()?;
        Ok(Self {
            settings,
            artists,
            members,
            assignments,
            assets,
            opened,
            dismissals,
        })
    }

    /// Same rules as the `asset_artist_scope` view.
    fn scope_of(&self, asset: &AssetRow) -> String {
        if let Some(assignment) = self.assignments.get(&asset.id) {
            return format!("{ARTIST_PREFIX}{}", assignment.artist_id);
        }
        match &asset.key {
            None if asset
                .source_url
                .as_deref()
                .is_none_or(|url| url.trim().is_empty()) =>
            {
                UNKNOWN_NONE.to_owned()
            }
            None => UNKNOWN_SOURCE.to_owned(),
            Some(key) => self.scope_of_key(key),
        }
    }

    fn scope_of_key(&self, key: &str) -> String {
        self.members
            .get(key)
            .map(|id| format!("{ARTIST_PREFIX}{id}"))
            .unwrap_or_else(|| key.to_owned())
    }

    fn groups(&self) -> BTreeMap<String, Group<'_>> {
        let mut groups: BTreeMap<String, Group<'_>> = BTreeMap::new();
        for asset in &self.assets {
            let scope = self.scope_of(asset);
            if is_unknown(&scope) || scope.is_empty() {
                continue;
            }
            let group = groups.entry(scope).or_default();
            group.assets.push(asset);
            if let Some(name) = &asset.creator_name {
                *group.names.entry(name.clone()).or_default() += 1;
            }
            // A key only counts for the artist its asset actually belongs to (an assignment
            // can move a keyed asset elsewhere).
            if let Some(key) = &asset.key {
                *group.keys.entry(key.clone()).or_default() += 1;
            }
        }
        for (key, artist_id) in &self.members {
            if let Some(group) = groups.get_mut(&format!("{ARTIST_PREFIX}{artist_id}")) {
                group.keys.entry(key.clone()).or_default();
            }
        }
        groups
    }

    fn row(&self, scope: &str) -> Option<&ArtistRow> {
        scope
            .strip_prefix(ARTIST_PREFIX)
            .and_then(|id| self.artists.get(id))
    }

    fn summary(&self, scope: &str, group: &Group<'_>, now: &DateTime<Utc>) -> ArtistSummary {
        let row = self.row(scope);
        let display_name = row.and_then(|row| row.display_name.clone());
        // Most frequent source name; ties go to the name seen on the newest asset.
        let source_name = group
            .names
            .iter()
            .max_by(|left, right| {
                left.1.cmp(right.1).then_with(|| {
                    let position = |name: &str| {
                        group
                            .assets
                            .iter()
                            .position(|asset| asset.creator_name.as_deref() == Some(name))
                            .unwrap_or(usize::MAX)
                    };
                    position(right.0).cmp(&position(left.0))
                })
            })
            .map(|(name, _)| name.clone())
            .or_else(|| {
                group
                    .keys
                    .iter()
                    .max_by_key(|(_, count)| **count)
                    .map(|(key, _)| key_label(key))
            });
        let label = display_name
            .clone()
            .or_else(|| source_name.clone())
            .unwrap_or_else(|| scope.to_owned());
        let recent_since = *now - Duration::days(i64::from(self.settings.recent_days));
        let recent_count = group
            .assets
            .iter()
            .filter(|asset| parse_time(&asset.collected_at).is_some_and(|at| at >= recent_since))
            .count() as u32;
        let asset_count = group.assets.len() as u32;
        let last_opened_at = group
            .assets
            .iter()
            .filter_map(|asset| self.opened.get(&asset.id))
            .max()
            .cloned();
        ArtistSummary {
            id: scope.to_owned(),
            label,
            display_name,
            source_name,
            keys: group.keys.keys().cloned().collect(),
            asset_count,
            recent_count,
            first_saved_at: group.assets.last().map(|asset| asset.collected_at.clone()),
            last_saved_at: group.assets.first().map(|asset| asset.collected_at.clone()),
            last_opened_at,
            pinned: row.is_some_and(|row| row.pinned),
            hidden: row.is_some_and(|row| row.hidden),
            main: asset_count >= self.settings.main_min_count
                || recent_count >= self.settings.recent_min_count,
            cover_asset_ids: group
                .assets
                .iter()
                .take(COVER_LIMIT)
                .map(|asset| asset.id.clone())
                .collect(),
        }
    }

    fn summaries(&self, now: &DateTime<Utc>) -> Vec<ArtistSummary> {
        self.groups()
            .iter()
            .map(|(scope, group)| self.summary(scope, group, now))
            .collect()
    }

    fn unknown_counts(&self) -> (u32, u32) {
        let mut none = 0;
        let mut source = 0;
        for asset in &self.assets {
            match self.scope_of(asset).as_str() {
                UNKNOWN_NONE => none += 1,
                UNKNOWN_SOURCE => source += 1,
                _ => {}
            }
        }
        (none, source)
    }

    fn search_text(&self, summary: &ArtistSummary, group: &Group<'_>) -> String {
        let mut parts = vec![summary.label.clone()];
        parts.extend(summary.display_name.clone());
        parts.extend(group.names.keys().cloned());
        parts.extend(group.keys.keys().cloned());
        parts.join("\n")
    }
}

fn is_unknown(scope: &str) -> bool {
    scope.starts_with("unknown:")
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn is_url(key: &str) -> bool {
    key.starts_with("http://") || key.starts_with("https://")
}

/// A handle stays as is; a creator URL shows its last path segment.
fn key_label(key: &str) -> String {
    if !is_url(key) {
        return key.to_owned();
    }
    url::Url::parse(key)
        .ok()
        .and_then(|url| {
            url.path_segments().and_then(|segments| {
                segments
                    .filter(|segment| !segment.is_empty())
                    .last()
                    .map(str::to_owned)
            })
        })
        .unwrap_or_else(|| key.to_owned())
}

/// A short site name for a URL: `x.com`, `pixiv`, `arca.live`, `dcinside`, else the host.
pub(crate) fn site_of(url: &str) -> Option<String> {
    let host = url::Url::parse(url).ok()?.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    Some(match host.as_str() {
        "x.com" | "twitter.com" | "mobile.x.com" | "mobile.twitter.com" => "x.com".to_owned(),
        value if value == "pixiv.net" || value.ends_with(".pixiv.net") => "pixiv".to_owned(),
        value if value == "arca.live" || value.ends_with(".arca.live") => "arca.live".to_owned(),
        value if value == "dcinside.com" || value.ends_with(".dcinside.com") => {
            "dcinside".to_owned()
        }
        _ => host,
    })
}

fn is_forum(site: &str) -> bool {
    matches!(site, "arca.live" | "dcinside")
}

fn local_date_of(value: &str, offset_minutes: i32) -> Option<chrono::NaiveDate> {
    parse_time(value).map(|at| (at + Duration::minutes(i64::from(offset_minutes))).date_naive())
}

fn validate_offset(offset_minutes: i32) -> Result<(), LibraryError> {
    if (-18 * 60..=18 * 60).contains(&offset_minutes) {
        Ok(())
    } else {
        Err(LibraryError::InvalidAssetDateRange)
    }
}

fn seeded_pick(len: usize, seed: u32, spread: usize) -> usize {
    if len == 0 {
        0
    } else {
        seed as usize % len.min(spread.max(1))
    }
}

// ---------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------

pub(crate) fn overview(
    connection: &Connection,
    now_utc: &str,
) -> Result<ArtistOverview, LibraryError> {
    let now = parse_utc_timestamp(now_utc)?;
    let snapshot = Snapshot::load(connection)?;
    let summaries = snapshot.summaries(&now);
    let visible = summaries.iter().filter(|artist| !artist.hidden);
    let listed = || {
        summaries
            .iter()
            .filter(|artist| !artist.hidden && !artist.pinned)
    };
    let (unknown_none, unknown_source) = snapshot.unknown_counts();
    let mut pinned: Vec<ArtistSummary> = summaries
        .iter()
        .filter(|artist| artist.pinned && !artist.hidden)
        .cloned()
        .collect();
    sort_summaries(&mut pinned, ArtistSort::Count);
    Ok(ArtistOverview {
        settings: snapshot.settings,
        total: visible.count() as u32,
        main: listed().filter(|artist| artist.main).count() as u32,
        other: listed().filter(|artist| !artist.main).count() as u32,
        two_to_four: listed()
            .filter(|artist| !artist.main && (2..=4).contains(&artist.asset_count))
            .count() as u32,
        single: listed()
            .filter(|artist| !artist.main && artist.asset_count == 1)
            .count() as u32,
        hidden: summaries.iter().filter(|artist| artist.hidden).count() as u32,
        unknown_none,
        unknown_source,
        merge_suggestions: merge_suggestions_from(&snapshot, &now).len() as u32,
        source_fillable: source_fill_from(&snapshot, &now).fillable,
        pinned,
    })
}

fn sort_summaries(artists: &mut [ArtistSummary], sort: ArtistSort) {
    artists.sort_by(|left, right| {
        let order = match sort {
            ArtistSort::Recent => right.last_saved_at.cmp(&left.last_saved_at),
            ArtistSort::Count => right
                .asset_count
                .cmp(&left.asset_count)
                .then_with(|| right.last_saved_at.cmp(&left.last_saved_at)),
            ArtistSort::Name => std::cmp::Ordering::Equal,
        };
        order
            .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
            .then_with(|| left.id.cmp(&right.id))
    });
}

pub(crate) fn list(
    connection: &Connection,
    query: &ArtistListQuery,
    now_utc: &str,
) -> Result<ArtistListPage, LibraryError> {
    let now = parse_utc_timestamp(now_utc)?;
    let snapshot = Snapshot::load(connection)?;
    let search = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let groups = snapshot.groups();
    let mut matched: Vec<ArtistSummary> = groups
        .iter()
        .map(|(scope, group)| (snapshot.summary(scope, group, &now), group))
        .filter(|(artist, _)| match query.bucket {
            ArtistBucket::All => !artist.hidden,
            ArtistBucket::Pinned => artist.pinned && !artist.hidden,
            ArtistBucket::Main => artist.main && !artist.pinned && !artist.hidden,
            ArtistBucket::Other => !artist.main && !artist.pinned && !artist.hidden,
            ArtistBucket::TwoToFour => {
                !artist.main
                    && !artist.pinned
                    && !artist.hidden
                    && (2..=4).contains(&artist.asset_count)
            }
            ArtistBucket::Single => {
                !artist.main && !artist.pinned && !artist.hidden && artist.asset_count == 1
            }
            ArtistBucket::Hidden => artist.hidden,
        })
        .filter(|(artist, group)| {
            search.is_none_or(|search| matches_search(&snapshot.search_text(artist, group), search))
        })
        .map(|(artist, _)| artist)
        .collect();
    sort_summaries(&mut matched, query.sort);
    if query.bucket == ArtistBucket::All {
        matched.sort_by_key(|artist| !artist.pinned);
    }
    let total = matched.len() as u32;
    let limit = query
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT) as usize;
    let artists = matched
        .into_iter()
        .skip(query.offset as usize)
        .take(limit)
        .collect();
    Ok(ArtistListPage { total, artists })
}

fn find_group<'a>(
    snapshot: &'a Snapshot,
    groups: &'a BTreeMap<String, Group<'a>>,
    id: &str,
) -> Result<(String, &'a Group<'a>), LibraryError> {
    // A bare key that has since joined an artist resolves to that artist.
    let scope = if id.starts_with(ARTIST_PREFIX) {
        id.to_owned()
    } else {
        snapshot.scope_of_key(id)
    };
    groups
        .get(&scope)
        .map(|group| (scope, group))
        .ok_or(LibraryError::ArtistNotFound)
}

pub(crate) fn detail(
    connection: &Connection,
    id: &str,
    local_date: &str,
    offset_minutes: i32,
    now_utc: &str,
) -> Result<ArtistDetail, LibraryError> {
    let now = parse_utc_timestamp(now_utc)?;
    let today = parse_local_date(local_date)?;
    validate_offset(offset_minutes)?;
    let snapshot = Snapshot::load(connection)?;
    let groups = snapshot.groups();
    let (scope, group) = find_group(&snapshot, &groups, id)?;
    let summary = snapshot.summary(&scope, group, &now);

    let mut members: Vec<ArtistMemberInfo> = group
        .keys
        .iter()
        .map(|(key, count)| {
            let keyed = group
                .assets
                .iter()
                .filter(|asset| asset.key.as_deref() == Some(key.as_str()));
            let mut names: BTreeMap<&str, u32> = BTreeMap::new();
            let mut host = None;
            for asset in keyed {
                if let Some(name) = asset.creator_name.as_deref() {
                    *names.entry(name).or_default() += 1;
                }
                if host.is_none() {
                    host = asset
                        .creator_url
                        .as_deref()
                        .and_then(site_of)
                        .or_else(|| asset.source_url.as_deref().and_then(site_of));
                }
            }
            if host.is_none() && is_url(key) {
                host = site_of(key);
            }
            ArtistMemberInfo {
                key: key.clone(),
                name: names
                    .into_iter()
                    .max_by_key(|(_, count)| *count)
                    .map(|(name, _)| name.to_owned()),
                host,
                asset_count: *count,
            }
        })
        .collect();
    members.sort_by(|left, right| {
        right
            .asset_count
            .cmp(&left.asset_count)
            .then_with(|| left.key.cmp(&right.key))
    });

    let mut assignment_counts: BTreeMap<&str, (u32, Option<&str>)> = BTreeMap::new();
    let mut sources: BTreeMap<String, u32> = BTreeMap::new();
    for asset in &group.assets {
        let site = if let Some(assignment) = snapshot.assignments.get(&asset.id) {
            let entry = assignment_counts
                .entry(assignment.source.as_str())
                .or_default();
            entry.0 += 1;
            entry.1 = entry.1.max(Some(assignment.created_at.as_str()));
            if assignment.source == "manual" {
                Some("manual".to_owned())
            } else {
                asset.source_url.as_deref().and_then(site_of)
            }
        } else {
            asset
                .creator_url
                .as_deref()
                .and_then(site_of)
                .or_else(|| asset.source_url.as_deref().and_then(site_of))
        };
        *sources
            .entry(site.unwrap_or_else(|| "기타".to_owned()))
            .or_default() += 1;
    }
    let assignments = assignment_counts
        .into_iter()
        .map(|(source, (count, latest))| ArtistAssignmentInfo {
            source: source.to_owned(),
            asset_count: count,
            latest_at: latest.map(str::to_owned),
        })
        .collect();
    let mut sources: Vec<ArtistSourceCount> = sources
        .into_iter()
        .map(|(host, count)| ArtistSourceCount { host, count })
        .collect();
    sources.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.host.cmp(&right.host))
    });

    let on_this_day = on_this_day(group, today, offset_minutes);
    let long_unseen = long_unseen(&snapshot, group, &now);
    let merge_suggestions = merge_suggestions_from(&snapshot, &now)
        .into_iter()
        .filter(|suggestion| suggestion.left.id == scope || suggestion.right.id == scope)
        .collect();
    Ok(ArtistDetail {
        summary,
        members,
        assignments,
        sources,
        on_this_day,
        long_unseen,
        merge_suggestions,
    })
}

/// Assets saved on today's month and day in an earlier year, from the most recent such year.
fn on_this_day(
    group: &Group<'_>,
    today: chrono::NaiveDate,
    offset_minutes: i32,
) -> Option<ArtistRediscovery> {
    let mut by_year: BTreeMap<i32, Vec<&AssetRow>> = BTreeMap::new();
    for asset in &group.assets {
        let Some(date) = local_date_of(&asset.collected_at, offset_minutes) else {
            continue;
        };
        if date.year() < today.year() && date.month() == today.month() && date.day() == today.day()
        {
            by_year.entry(date.year()).or_default().push(asset);
        }
    }
    let (year, assets) = by_year.into_iter().next_back()?;
    Some(ArtistRediscovery {
        total: assets.len() as u32,
        asset_ids: assets
            .iter()
            .take(ROW_ASSET_LIMIT * 2)
            .map(|asset| asset.id.clone())
            .collect(),
        years_ago: Some((today.year() - year) as u32),
        local_date: today
            .with_year(year)
            .map(|date| date.format("%Y-%m-%d").to_string()),
    })
}

/// Assets saved over a year ago and not opened for a year (or never), least recently seen first.
fn long_unseen(
    snapshot: &Snapshot,
    group: &Group<'_>,
    now: &DateTime<Utc>,
) -> Option<ArtistRediscovery> {
    let cutoff = *now - Duration::days(LONG_UNSEEN_DAYS);
    let mut unseen: Vec<(Option<&String>, &AssetRow)> = group
        .assets
        .iter()
        .filter(|asset| parse_time(&asset.collected_at).is_some_and(|at| at < cutoff))
        .map(|asset| (snapshot.opened.get(&asset.id), *asset))
        .filter(|(opened, _)| {
            opened.is_none_or(|opened| parse_time(opened).is_none_or(|at| at < cutoff))
        })
        .collect();
    if unseen.is_empty() {
        return None;
    }
    unseen.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.collected_at.cmp(&right.1.collected_at))
    });
    Some(ArtistRediscovery {
        total: unseen.len() as u32,
        asset_ids: unseen
            .iter()
            .take(ROW_ASSET_LIMIT * 2)
            .map(|(_, asset)| asset.id.clone())
            .collect(),
        years_ago: None,
        local_date: None,
    })
}

/// Up to three rows for the hub's 오늘 strip: an artist saved on this day in an earlier
/// year, one the 작가 spotlight ranks as long unseen, and one with several new saves this
/// week. `seed` (다시 고르기) picks among the top candidates; `excluded` are dismissed rows.
pub(crate) fn today(
    connection: &Connection,
    local_date: &str,
    offset_minutes: i32,
    now_utc: &str,
    seed: u32,
    excluded: &[String],
) -> Result<Vec<ArtistTodayRow>, LibraryError> {
    let now = parse_utc_timestamp(now_utc)?;
    let today = parse_local_date(local_date)?;
    validate_offset(offset_minutes)?;
    let snapshot = Snapshot::load(connection)?;
    let groups = snapshot.groups();
    let mut used: HashSet<String> = excluded.iter().cloned().collect();
    let eligible = |scope: &str, used: &HashSet<String>| {
        !used.contains(scope) && !snapshot.row(scope).is_some_and(|row| row.hidden)
    };
    let mut rows = Vec::new();

    let mut anniversaries: Vec<(&String, ArtistRediscovery)> = groups
        .iter()
        .filter(|(scope, _)| eligible(scope, &used))
        .filter_map(|(scope, group)| {
            on_this_day(group, today, offset_minutes).map(|found| (scope, found))
        })
        .collect();
    anniversaries.sort_by(|left, right| {
        right
            .1
            .total
            .cmp(&left.1.total)
            .then_with(|| left.0.cmp(right.0))
    });
    if !anniversaries.is_empty() {
        let (scope, found) = &anniversaries[seeded_pick(anniversaries.len(), seed, 5)];
        let years = found.years_ago.unwrap_or(1);
        rows.push(ArtistTodayRow {
            artist: snapshot.summary(scope, &groups[*scope], &now),
            kind: "anniversary".into(),
            reason: format!("{years}년 전 오늘 저장"),
            asset_ids: found
                .asset_ids
                .iter()
                .take(ROW_ASSET_LIMIT)
                .cloned()
                .collect(),
        });
        used.insert((*scope).clone());
    }

    let spotlight: Vec<(String, Vec<String>)> =
        super::revisit::artist_spotlight_ranking(connection, now_utc)?
            .into_iter()
            .filter(|(scope, _)| groups.contains_key(scope) && eligible(scope, &used))
            .collect();
    if !spotlight.is_empty() {
        let (scope, asset_ids) = &spotlight[seeded_pick(spotlight.len(), seed, 5)];
        let summary = snapshot.summary(scope, &groups[scope], &now);
        let seen = [
            summary.last_opened_at.as_deref(),
            summary.last_saved_at.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter_map(parse_time)
        .max();
        let days = seen.map(|at| (now - at).num_days().max(0)).unwrap_or(0);
        rows.push(ArtistTodayRow {
            reason: if days > 0 {
                format!("{days}일 동안 안 봄")
            } else {
                "한동안 덜 본 작가".to_owned()
            },
            kind: "unseen".into(),
            asset_ids: asset_ids.iter().take(ROW_ASSET_LIMIT).cloned().collect(),
            artist: summary,
        });
        used.insert(scope.clone());
    }

    let fresh_since = now - Duration::days(FRESH_DAYS);
    let mut fresh: Vec<(&String, Vec<&AssetRow>)> = groups
        .iter()
        .filter(|(scope, _)| eligible(scope, &used))
        .map(|(scope, group)| {
            (
                scope,
                group
                    .assets
                    .iter()
                    .copied()
                    .filter(|asset| {
                        parse_time(&asset.collected_at).is_some_and(|at| at >= fresh_since)
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .filter(|(_, assets)| assets.len() >= 2)
        .collect();
    fresh.sort_by(|left, right| {
        right
            .1
            .len()
            .cmp(&left.1.len())
            .then_with(|| left.0.cmp(right.0))
    });
    if !fresh.is_empty() {
        let (scope, assets) = &fresh[seeded_pick(fresh.len(), seed, 3)];
        rows.push(ArtistTodayRow {
            artist: snapshot.summary(scope, &groups[*scope], &now),
            kind: "fresh".into(),
            reason: format!("이번 주 새 작품 {}장", assets.len()),
            asset_ids: assets
                .iter()
                .take(ROW_ASSET_LIMIT)
                .map(|asset| asset.id.clone())
                .collect(),
        });
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------------------
// Merge suggestions
// ---------------------------------------------------------------------------------------

fn ordered_pair(left: &str, right: &str) -> (String, String) {
    if left <= right {
        (left.to_owned(), right.to_owned())
    } else {
        (right.to_owned(), left.to_owned())
    }
}

/// The handle without trailing digits and separators (`sio_mizu2` -> `sio_mizu`).
fn handle_stem(handle: &str) -> String {
    handle
        .trim_end_matches(|character: char| {
            character.is_ascii_digit() || character == '_' || character == '-'
        })
        .to_owned()
}

fn normalized_name(name: &str) -> String {
    name.chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn merge_suggestions_from(snapshot: &Snapshot, now: &DateTime<Utc>) -> Vec<ArtistMergeSuggestion> {
    let groups = snapshot.groups();
    let visible: Vec<(&String, &Group<'_>)> = groups
        .iter()
        .filter(|(scope, _)| !snapshot.row(scope).is_some_and(|row| row.hidden))
        .collect();
    let sites_of = |group: &Group<'_>| -> BTreeSet<String> {
        group
            .assets
            .iter()
            .filter_map(|asset| {
                asset
                    .creator_url
                    .as_deref()
                    .and_then(site_of)
                    .or_else(|| asset.source_url.as_deref().and_then(site_of))
            })
            .collect()
    };
    let mut found: Vec<(u8, bool, String, String, (String, String))> = Vec::new();
    let mut seen_pairs: HashSet<(String, String)> = HashSet::new();
    let mut push = |kind: u8,
                    uncertain: bool,
                    left: &str,
                    right: &str,
                    keys: (String, String),
                    found: &mut Vec<_>| {
        let pair = ordered_pair(left, right);
        if left == right || snapshot.dismissals.contains(&keys) || !seen_pairs.insert(pair) {
            return;
        }
        found.push((kind, uncertain, left.to_owned(), right.to_owned(), keys));
    };

    // Same handle up to case, and handles that differ only by trailing digits.
    let mut by_handle: BTreeMap<String, Vec<(&String, &String)>> = BTreeMap::new();
    let mut by_stem: BTreeMap<String, Vec<(&String, &String)>> = BTreeMap::new();
    for (scope, group) in &visible {
        for key in group.keys.keys().filter(|key| !is_url(key)) {
            by_handle
                .entry(key.to_lowercase())
                .or_default()
                .push((*scope, key));
            let stem = handle_stem(&key.to_lowercase());
            if stem.chars().count() >= 4 && stem != key.to_lowercase() {
                by_stem.entry(stem).or_default().push((*scope, key));
            }
        }
    }
    for entries in by_handle.values() {
        for window in entries.windows(2) {
            let ((left, left_key), (right, right_key)) = (window[0], window[1]);
            push(
                0,
                false,
                left,
                right,
                ordered_pair(left_key, right_key),
                &mut found,
            );
        }
    }
    // A stem pairs with the undecorated handle (`sio_mizu` with `sio_mizu2`).
    for (stem, decorated) in &by_stem {
        if let Some(plain) = by_handle.get(stem) {
            for (scope, key) in decorated {
                if let Some((plain_scope, plain_key)) = plain.first() {
                    push(
                        2,
                        true,
                        plain_scope,
                        scope,
                        ordered_pair(plain_key, key),
                        &mut found,
                    );
                }
            }
        }
    }

    // The same source name on different sites.
    let mut by_name: BTreeMap<String, Vec<&String>> = BTreeMap::new();
    for (scope, group) in &visible {
        if group.keys.is_empty() {
            continue;
        }
        let names: BTreeSet<String> = group
            .names
            .keys()
            .map(|name| normalized_name(name))
            .filter(|name| name.chars().count() >= 2)
            .collect();
        for name in names {
            by_name.entry(name).or_default().push(*scope);
        }
    }
    for scopes in by_name.values() {
        for (index, left) in scopes.iter().enumerate() {
            for right in &scopes[index + 1..] {
                let (left_group, right_group) = (&groups[*left], &groups[*right]);
                let (left_sites, right_sites) = (sites_of(left_group), sites_of(right_group));
                if left_sites.is_empty()
                    || right_sites.is_empty()
                    || !left_sites.is_disjoint(&right_sites)
                {
                    continue;
                }
                let uncertain = left_sites
                    .iter()
                    .chain(&right_sites)
                    .any(|site| is_forum(site));
                let (Some(left_key), Some(right_key)) = (
                    left_group.keys.keys().next(),
                    right_group.keys.keys().next(),
                ) else {
                    continue;
                };
                push(
                    1,
                    uncertain,
                    left,
                    right,
                    ordered_pair(left_key, right_key),
                    &mut found,
                );
            }
        }
    }

    let mut suggestions: Vec<ArtistMergeSuggestion> = found
        .into_iter()
        .map(|(kind, uncertain, left, right, (key_a, key_b))| {
            let mut left = snapshot.summary(&left, &groups[&left], now);
            let mut right = snapshot.summary(&right, &groups[&right], now);
            // The larger artist first: it is the natural merge target.
            if right.asset_count > left.asset_count {
                std::mem::swap(&mut left, &mut right);
            }
            ArtistMergeSuggestion {
                key_a,
                key_b,
                kind: ["handle", "name", "similar"][kind as usize].to_owned(),
                uncertain,
                left,
                right,
            }
        })
        .collect();
    suggestions.sort_by(|left, right| {
        let rank = |suggestion: &ArtistMergeSuggestion| {
            (
                suggestion.uncertain,
                ["handle", "name", "similar"]
                    .iter()
                    .position(|kind| *kind == suggestion.kind),
            )
        };
        rank(left).cmp(&rank(right)).then_with(|| {
            (right.left.asset_count + right.right.asset_count)
                .cmp(&(left.left.asset_count + left.right.asset_count))
        })
    });
    suggestions
}

pub(crate) fn merge_suggestions(
    connection: &Connection,
    now_utc: &str,
) -> Result<Vec<ArtistMergeSuggestion>, LibraryError> {
    let now = parse_utc_timestamp(now_utc)?;
    Ok(merge_suggestions_from(&Snapshot::load(connection)?, &now))
}

// ---------------------------------------------------------------------------------------
// Source fill (x.com handles read offline from source URLs)
// ---------------------------------------------------------------------------------------

struct FillPlan {
    preview: SourceFillPreview,
    /// Handle as it will be stored -> asset ids.
    assets: BTreeMap<String, Vec<String>>,
    /// Handle -> existing artist scope.
    targets: HashMap<String, String>,
}

fn source_fill_plan(snapshot: &Snapshot, now: &DateTime<Utc>) -> FillPlan {
    // Existing keys by lower-case handle, with how many assets use each spelling.
    let mut known: HashMap<String, BTreeMap<String, usize>> = HashMap::new();
    for asset in &snapshot.assets {
        if let Some(key) = asset.key.as_deref().filter(|key| !is_url(key)) {
            *known
                .entry(key.to_lowercase())
                .or_default()
                .entry(key.to_owned())
                .or_default() += 1;
        }
    }
    for key in snapshot.members.keys().filter(|key| !is_url(key)) {
        known
            .entry(key.to_lowercase())
            .or_default()
            .entry(key.clone())
            .or_default();
    }

    let mut sites: BTreeMap<String, (u32, u32)> = BTreeMap::new();
    let mut by_handle: BTreeMap<String, Vec<(String, &AssetRow)>> = BTreeMap::new();
    let mut total = 0;
    let mut without_handle = 0;
    for asset in &snapshot.assets {
        if snapshot.scope_of(asset) != UNKNOWN_SOURCE {
            continue;
        }
        total += 1;
        let url = asset.source_url.as_deref().unwrap_or_default();
        let site = site_of(url).unwrap_or_else(|| "기타".to_owned());
        let entry = sites.entry(site.clone()).or_default();
        entry.0 += 1;
        if site != "x.com" {
            continue;
        }
        match super::legacy_migration::creator_from_source_url(Some(url)).0 {
            Some(_) => {
                entry.1 += 1;
                let handle = url::Url::parse(url)
                    .ok()
                    .and_then(|url| {
                        url.path_segments()
                            .and_then(|mut segments| segments.next().map(str::to_owned))
                    })
                    .unwrap_or_default();
                by_handle
                    .entry(handle.to_lowercase())
                    .or_default()
                    .push((handle, asset));
            }
            None => without_handle += 1,
        }
    }

    let groups = snapshot.groups();
    let mut assets = BTreeMap::new();
    let mut targets = HashMap::new();
    let mut fill_groups = Vec::new();
    let mut existing = 0;
    for (lower, entries) in by_handle {
        // An existing key wins (same spelling first, else the most used); else the spelling
        // most of these URLs use.
        let spelling = known.get(&lower).and_then(|spellings| {
            spellings
                .keys()
                .find(|key| entries.iter().any(|(handle, _)| handle == *key))
                .cloned()
                .or_else(|| {
                    spellings
                        .iter()
                        .max_by_key(|(_, count)| **count)
                        .map(|(key, _)| key.clone())
                })
        });
        let handle = spelling.clone().unwrap_or_else(|| {
            let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
            for (handle, _) in &entries {
                *counts.entry(handle.as_str()).or_default() += 1;
            }
            counts
                .into_iter()
                .min_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(right.0)))
                .map(|(handle, _)| handle.to_owned())
                .unwrap_or(lower.clone())
        });
        let target = spelling.map(|key| snapshot.scope_of_key(&key));
        let target_label = target.as_ref().and_then(|scope| {
            groups
                .get(scope)
                .map(|group| snapshot.summary(scope, group, now).label)
        });
        if target.is_some() {
            existing += 1;
        }
        fill_groups.push(SourceFillGroup {
            handle: handle.clone(),
            asset_count: entries.len() as u32,
            sample_asset_ids: entries
                .iter()
                .take(3)
                .map(|(_, asset)| asset.id.clone())
                .collect(),
            target_id: target.clone(),
            target_label,
        });
        if let Some(target) = target {
            targets.insert(handle.clone(), target);
        }
        assets.insert(
            handle,
            entries.iter().map(|(_, asset)| asset.id.clone()).collect(),
        );
    }
    fill_groups.sort_by(|left, right| {
        right
            .asset_count
            .cmp(&left.asset_count)
            .then_with(|| left.handle.cmp(&right.handle))
    });
    let fillable = fill_groups.iter().map(|group| group.asset_count).sum();
    let new_artists = fill_groups.len() as u32 - existing;
    let mut sites: Vec<SourceFillSite> = sites
        .into_iter()
        .map(|(host, (count, fillable))| SourceFillSite {
            method: if host == "x.com" { "auto" } else { "manual" }.to_owned(),
            host,
            asset_count: count,
            fillable,
        })
        .collect();
    sites.sort_by(|left, right| {
        right
            .asset_count
            .cmp(&left.asset_count)
            .then_with(|| left.host.cmp(&right.host))
    });
    FillPlan {
        preview: SourceFillPreview {
            total,
            sites,
            fillable,
            without_handle,
            existing_artists: existing,
            new_artists,
            groups: fill_groups,
        },
        assets,
        targets,
    }
}

fn source_fill_from(snapshot: &Snapshot, now: &DateTime<Utc>) -> SourceFillPreview {
    source_fill_plan(snapshot, now).preview
}

pub(crate) fn source_fill_preview(
    connection: &Connection,
    now_utc: &str,
) -> Result<SourceFillPreview, LibraryError> {
    let now = parse_utc_timestamp(now_utc)?;
    Ok(source_fill_from(&Snapshot::load(connection)?, &now))
}

pub(crate) fn apply_source_fill(
    connection: &Connection,
    now_utc: &str,
) -> Result<SourceFillResult, LibraryError> {
    let now = parse_utc_timestamp(now_utc)?;
    let transaction = connection.unchecked_transaction()?;
    let plan = source_fill_plan(&Snapshot::load(&transaction)?, &now);
    let mut assigned = 0;
    let mut created = 0;
    for (handle, asset_ids) in &plan.assets {
        let artist_id = match plan.targets.get(handle) {
            Some(scope) => materialize(&transaction, scope, now_utc)?,
            None => {
                created += 1;
                // The handle becomes a member key, so later saves from it join this artist.
                let id = new_artist(&transaction, None, now_utc)?;
                transaction.execute("INSERT INTO artist_members (creator_key, artist_id, added_at) VALUES (?1, ?2, ?3)", params![handle, id, now_utc])?;
                id
            }
        };
        for asset_id in asset_ids {
            assigned += transaction.execute(
                "INSERT OR IGNORE INTO asset_artist_assignments (asset_id, artist_id, source, source_handle, created_at) VALUES (?1, ?2, 'source_url', ?3, ?4)",
                params![asset_id, artist_id, handle, now_utc],
            )? as u32;
        }
    }
    collect_empty_artists(&transaction)?;
    transaction.commit()?;
    Ok(SourceFillResult {
        assigned,
        created_artists: created,
    })
}

// ---------------------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------------------

pub(crate) fn caption_labels(connection: &Connection) -> Result<ArtistCaptionLabels, LibraryError> {
    let snapshot = Snapshot::load(connection)?;
    let now = Utc::now();
    let mut labels = ArtistCaptionLabels::default();
    for (scope, group) in snapshot
        .groups()
        .iter()
        .filter(|(scope, _)| scope.starts_with(ARTIST_PREFIX))
    {
        let label = snapshot.summary(scope, group, &now).label;
        for key in group.keys.keys() {
            labels.by_key.insert(key.clone(), label.clone());
        }
        for asset in &group.assets {
            if snapshot.assignments.contains_key(&asset.id) {
                labels.by_asset.insert(asset.id.clone(), label.clone());
            }
        }
    }
    Ok(labels)
}

// ---------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------

fn new_artist(
    connection: &Connection,
    display_name: Option<&str>,
    now_utc: &str,
) -> Result<String, LibraryError> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    connection.execute(
        "INSERT INTO artists (id, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![id, display_name, now_utc],
    )?;
    Ok(id)
}

/// The artist row behind an id, creating one for an implicit (bare key) artist.
fn materialize(connection: &Connection, id: &str, now_utc: &str) -> Result<String, LibraryError> {
    if let Some(artist_id) = id.strip_prefix(ARTIST_PREFIX) {
        let exists = connection
            .query_row("SELECT 1 FROM artists WHERE id = ?1", [artist_id], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        return if exists {
            Ok(artist_id.to_owned())
        } else {
            Err(LibraryError::ArtistNotFound)
        };
    }
    if id.is_empty() || is_unknown(id) {
        return Err(LibraryError::InvalidArtist(
            "작가를 알 수 없는 이미지에는 이 작업을 할 수 없습니다".into(),
        ));
    }
    if let Some(artist_id) = connection
        .query_row(
            "SELECT artist_id FROM artist_members WHERE creator_key = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(artist_id);
    }
    let used = connection
        .query_row("SELECT 1 FROM assets WHERE status = 'normal' AND COALESCE(creator_handle, creator_url) = ?1 LIMIT 1", [id], |_| Ok(()))
        .optional()?
        .is_some();
    if !used {
        return Err(LibraryError::ArtistNotFound);
    }
    let artist_id = new_artist(connection, None, now_utc)?;
    connection.execute(
        "INSERT INTO artist_members (creator_key, artist_id, added_at) VALUES (?1, ?2, ?3)",
        params![id, artist_id, now_utc],
    )?;
    Ok(artist_id)
}

/// Rows that carry nothing an implicit artist would not: no assignments and at most one
/// member without a name, pin or hide. Keeps the table limited to what the user did.
fn collect_empty_artists(connection: &Connection) -> Result<(), LibraryError> {
    connection.execute(
        "DELETE FROM artists WHERE NOT EXISTS (SELECT 1 FROM asset_artist_assignments AS assignment WHERE assignment.artist_id = artists.id)
         AND ((SELECT COUNT(*) FROM artist_members AS member WHERE member.artist_id = artists.id) = 0
              OR (display_name IS NULL AND pinned = 0 AND hidden = 0
                  AND (SELECT COUNT(*) FROM artist_members AS member WHERE member.artist_id = artists.id) <= 1))",
        [],
    )?;
    Ok(())
}

/// The id to show after a write: the row when it survives, else the key it fell back to.
fn resulting_id(
    connection: &Connection,
    artist_id: &str,
    fallback_key: Option<&str>,
) -> Result<String, LibraryError> {
    let exists = connection
        .query_row("SELECT 1 FROM artists WHERE id = ?1", [artist_id], |_| {
            Ok(())
        })
        .optional()?
        .is_some();
    if exists {
        return Ok(format!("{ARTIST_PREFIX}{artist_id}"));
    }
    fallback_key
        .map(str::to_owned)
        .ok_or(LibraryError::ArtistNotFound)
}

fn member_keys(connection: &Connection, artist_id: &str) -> Result<Vec<String>, LibraryError> {
    Ok(connection
        .prepare(
            "SELECT creator_key FROM artist_members WHERE artist_id = ?1 ORDER BY creator_key",
        )?
        .query_map([artist_id], |row| row.get(0))?
        .collect::<Result<Vec<String>, _>>()?)
}

fn clean_name(name: Option<&str>) -> Result<Option<String>, LibraryError> {
    let Some(name) = name.map(str::trim).filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(LibraryError::InvalidArtist(format!(
            "작가 이름은 {MAX_NAME_CHARS}자 이하여야 합니다"
        )));
    }
    Ok(Some(name.to_owned()))
}

pub(crate) fn set_display_name(
    connection: &Connection,
    id: &str,
    display_name: Option<&str>,
    now_utc: &str,
) -> Result<String, LibraryError> {
    parse_utc_timestamp(now_utc)?;
    let name = clean_name(display_name)?;
    if name.is_none()
        && !id.starts_with(ARTIST_PREFIX)
        && connection
            .query_row(
                "SELECT 1 FROM artist_members WHERE creator_key = ?1",
                [id],
                |_| Ok(()),
            )
            .optional()?
            .is_none()
    {
        return Ok(id.to_owned());
    }
    let transaction = connection.unchecked_transaction()?;
    let artist_id = materialize(&transaction, id, now_utc)?;
    transaction.execute(
        "UPDATE artists SET display_name = ?2, updated_at = ?3 WHERE id = ?1",
        params![artist_id, name, now_utc],
    )?;
    let keys = member_keys(&transaction, &artist_id)?;
    collect_empty_artists(&transaction)?;
    let result = resulting_id(&transaction, &artist_id, keys.first().map(String::as_str))?;
    transaction.commit()?;
    Ok(result)
}

pub(crate) fn set_flags(
    connection: &Connection,
    id: &str,
    pinned: Option<bool>,
    hidden: Option<bool>,
    now_utc: &str,
) -> Result<String, LibraryError> {
    parse_utc_timestamp(now_utc)?;
    let transaction = connection.unchecked_transaction()?;
    let artist_id = materialize(&transaction, id, now_utc)?;
    transaction.execute(
        "UPDATE artists SET pinned = COALESCE(?2, pinned), hidden = COALESCE(?3, hidden), updated_at = ?4 WHERE id = ?1",
        params![artist_id, pinned, hidden, now_utc],
    )?;
    let keys = member_keys(&transaction, &artist_id)?;
    collect_empty_artists(&transaction)?;
    let result = resulting_id(&transaction, &artist_id, keys.first().map(String::as_str))?;
    transaction.commit()?;
    Ok(result)
}

/// Joins `sources` into `target`: keys, assignments, a name the target lacks, and pins move
/// over; `display_name`, when given, names the merged artist. Returns the merged artist id.
pub(crate) fn merge(
    connection: &Connection,
    target: &str,
    sources: &[String],
    display_name: Option<&str>,
    now_utc: &str,
) -> Result<String, LibraryError> {
    parse_utc_timestamp(now_utc)?;
    let name = clean_name(display_name)?;
    if sources.is_empty() {
        return Err(LibraryError::InvalidArtist(
            "합칠 작가를 골라 주세요".into(),
        ));
    }
    let transaction = connection.unchecked_transaction()?;
    let target_id = materialize(&transaction, target, now_utc)?;
    for source in sources {
        let source_id = if let Some(id) = source.strip_prefix(ARTIST_PREFIX) {
            Some(id.to_owned())
        } else {
            transaction
                .query_row(
                    "SELECT artist_id FROM artist_members WHERE creator_key = ?1",
                    [source],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        };
        match source_id {
            Some(source_id) if source_id == target_id => {}
            Some(source_id) => {
                let (source_name, source_pinned): (Option<String>, bool) = transaction
                    .query_row(
                        "SELECT display_name, pinned FROM artists WHERE id = ?1",
                        [&source_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?
                    .ok_or(LibraryError::ArtistNotFound)?;
                transaction.execute(
                    "UPDATE artist_members SET artist_id = ?2 WHERE artist_id = ?1",
                    params![source_id, target_id],
                )?;
                transaction.execute(
                    "UPDATE asset_artist_assignments SET artist_id = ?2 WHERE artist_id = ?1",
                    params![source_id, target_id],
                )?;
                transaction.execute(
                    "UPDATE artists SET display_name = COALESCE(display_name, ?2), pinned = MAX(pinned, ?3), updated_at = ?4 WHERE id = ?1",
                    params![target_id, source_name, source_pinned, now_utc],
                )?;
                transaction.execute("DELETE FROM artists WHERE id = ?1", [&source_id])?;
            }
            None => {
                if is_unknown(source) || source.is_empty() {
                    return Err(LibraryError::InvalidArtist(
                        "작가를 알 수 없는 이미지는 작가 지정으로 붙여 주세요".into(),
                    ));
                }
                let used = transaction
                    .query_row("SELECT 1 FROM assets WHERE status = 'normal' AND COALESCE(creator_handle, creator_url) = ?1 LIMIT 1", [source], |_| Ok(()))
                    .optional()?
                    .is_some();
                if !used {
                    return Err(LibraryError::ArtistNotFound);
                }
                transaction.execute("INSERT INTO artist_members (creator_key, artist_id, added_at) VALUES (?1, ?2, ?3)", params![source, target_id, now_utc])?;
            }
        }
    }
    if let Some(name) = name {
        transaction.execute(
            "UPDATE artists SET display_name = ?2, updated_at = ?3 WHERE id = ?1",
            params![target_id, name, now_utc],
        )?;
    }
    collect_empty_artists(&transaction)?;
    let result = resulting_id(&transaction, &target_id, None)?;
    transaction.commit()?;
    Ok(result)
}

/// 떼어내기 for a key: it becomes its own artist again and is not suggested back.
pub(crate) fn detach_member(
    connection: &Connection,
    id: &str,
    key: &str,
    now_utc: &str,
) -> Result<String, LibraryError> {
    parse_utc_timestamp(now_utc)?;
    let artist_id = id
        .strip_prefix(ARTIST_PREFIX)
        .ok_or(LibraryError::ArtistNotFound)?;
    let transaction = connection.unchecked_transaction()?;
    let removed = transaction.execute(
        "DELETE FROM artist_members WHERE artist_id = ?1 AND creator_key = ?2",
        params![artist_id, key],
    )?;
    if removed == 0 {
        return Err(LibraryError::ArtistNotFound);
    }
    let remaining = member_keys(&transaction, artist_id)?;
    for other in &remaining {
        let (key_a, key_b) = ordered_pair(key, other);
        transaction.execute(
            "INSERT OR REPLACE INTO artist_merge_dismissals (key_a, key_b, dismissed_at) VALUES (?1, ?2, ?3)",
            params![key_a, key_b, now_utc],
        )?;
    }
    collect_empty_artists(&transaction)?;
    let result = resulting_id(
        &transaction,
        artist_id,
        remaining.first().map(String::as_str).or(Some(key)),
    )?;
    transaction.commit()?;
    Ok(result)
}

/// 떼어내기 for 직접 지정 (`manual`) or 출처에서 채움 (`source_url`) images.
pub(crate) fn detach_assignments(
    connection: &Connection,
    id: &str,
    source: &str,
    now_utc: &str,
) -> Result<String, LibraryError> {
    parse_utc_timestamp(now_utc)?;
    if !matches!(source, "manual" | "source_url") {
        return Err(LibraryError::InvalidArtist(
            "지정 종류가 올바르지 않습니다".into(),
        ));
    }
    let artist_id = id
        .strip_prefix(ARTIST_PREFIX)
        .ok_or(LibraryError::ArtistNotFound)?;
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "DELETE FROM asset_artist_assignments WHERE artist_id = ?1 AND source = ?2",
        params![artist_id, source],
    )?;
    let keys = member_keys(&transaction, artist_id)?;
    collect_empty_artists(&transaction)?;
    let result =
        resulting_id(&transaction, artist_id, keys.first().map(String::as_str)).unwrap_or_default();
    transaction.commit()?;
    Ok(result)
}

pub(crate) fn dismiss_suggestion(
    connection: &Connection,
    key_a: &str,
    key_b: &str,
    now_utc: &str,
) -> Result<(), LibraryError> {
    parse_utc_timestamp(now_utc)?;
    if key_a == key_b || key_a.is_empty() || key_b.is_empty() {
        return Err(LibraryError::InvalidArtist(
            "따로 둘 두 작가가 올바르지 않습니다".into(),
        ));
    }
    let (key_a, key_b) = ordered_pair(key_a, key_b);
    connection.execute(
        "INSERT OR REPLACE INTO artist_merge_dismissals (key_a, key_b, dismissed_at) VALUES (?1, ?2, ?3)",
        params![key_a, key_b, now_utc],
    )?;
    Ok(())
}

/// 작가 지정: link images to an existing artist (`artist_id`) or a new one named `new_name`.
/// Replaces an earlier assignment of the same image. Returns the artist id.
pub(crate) fn assign_assets(
    connection: &Connection,
    asset_ids: &[String],
    artist_id: Option<&str>,
    new_name: Option<&str>,
    now_utc: &str,
) -> Result<String, LibraryError> {
    parse_utc_timestamp(now_utc)?;
    let unique: BTreeSet<&str> = asset_ids.iter().map(String::as_str).collect();
    if unique.is_empty() {
        return Err(LibraryError::EmptyAssetSelection);
    }
    if unique.len() > MAX_ASSIGN_ASSETS {
        return Err(LibraryError::InvalidAssetSelection);
    }
    let name = clean_name(new_name)?;
    let transaction = connection.unchecked_transaction()?;
    for asset_id in &unique {
        let normal = transaction
            .query_row(
                "SELECT 1 FROM assets WHERE id = ?1 AND status = 'normal'",
                [asset_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !normal {
            return Err(LibraryError::AssetNotFound);
        }
    }
    let target = match (artist_id, name) {
        (Some(id), None) => materialize(&transaction, id, now_utc)?,
        (None, Some(name)) => new_artist(&transaction, Some(&name), now_utc)?,
        _ => {
            return Err(LibraryError::InvalidArtist(
                "붙일 작가를 하나 골라 주세요".into(),
            ))
        }
    };
    for asset_id in &unique {
        transaction.execute(
            "INSERT OR REPLACE INTO asset_artist_assignments (asset_id, artist_id, source, source_handle, created_at) VALUES (?1, ?2, 'manual', NULL, ?3)",
            params![asset_id, target, now_utc],
        )?;
    }
    collect_empty_artists(&transaction)?;
    let result = resulting_id(&transaction, &target, None)?;
    transaction.commit()?;
    Ok(result)
}

pub(crate) fn set_settings(
    connection: &Connection,
    settings: ArtistSettings,
) -> Result<ArtistSettings, LibraryError> {
    let valid = (1..=100_000).contains(&settings.main_min_count)
        && (1..=100_000).contains(&settings.recent_min_count)
        && (1..=3650).contains(&settings.recent_days);
    if !valid {
        return Err(LibraryError::InvalidArtist(
            "주요 작가 기준 숫자가 올바르지 않습니다".into(),
        ));
    }
    connection.execute(
        "INSERT INTO artist_settings (singleton, main_min_count, recent_min_count, recent_days) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(singleton) DO UPDATE SET main_min_count = excluded.main_min_count, recent_min_count = excluded.recent_min_count, recent_days = excluded.recent_days",
        params![settings.main_min_count, settings.recent_min_count, settings.recent_days],
    )?;
    load_settings(connection)
}

// ---------------------------------------------------------------------------------------
// Library facade
// ---------------------------------------------------------------------------------------

fn now_utc() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl super::Library {
    pub fn artist_overview(&self) -> Result<ArtistOverview, LibraryError> {
        overview(&*self.connection()?, &now_utc())
    }

    pub fn list_artists(&self, query: &ArtistListQuery) -> Result<ArtistListPage, LibraryError> {
        list(&*self.connection()?, query, &now_utc())
    }

    pub fn artist_detail(
        &self,
        id: &str,
        local_date: &str,
        offset_minutes: i32,
    ) -> Result<ArtistDetail, LibraryError> {
        detail(
            &*self.connection()?,
            id,
            local_date,
            offset_minutes,
            &now_utc(),
        )
    }

    pub fn artist_today(
        &self,
        local_date: &str,
        offset_minutes: i32,
        seed: u32,
        excluded: &[String],
    ) -> Result<Vec<ArtistTodayRow>, LibraryError> {
        today(
            &*self.connection()?,
            local_date,
            offset_minutes,
            &now_utc(),
            seed,
            excluded,
        )
    }

    pub fn artist_merge_suggestions(&self) -> Result<Vec<ArtistMergeSuggestion>, LibraryError> {
        merge_suggestions(&*self.connection()?, &now_utc())
    }

    pub fn artist_source_fill_preview(&self) -> Result<SourceFillPreview, LibraryError> {
        source_fill_preview(&*self.connection()?, &now_utc())
    }

    pub fn apply_artist_source_fill(&self) -> Result<SourceFillResult, LibraryError> {
        apply_source_fill(&*self.connection()?, &now_utc())
    }

    pub fn artist_caption_labels(&self) -> Result<ArtistCaptionLabels, LibraryError> {
        caption_labels(&*self.connection()?)
    }

    pub fn set_artist_display_name(
        &self,
        id: &str,
        display_name: Option<&str>,
    ) -> Result<String, LibraryError> {
        set_display_name(&*self.connection()?, id, display_name, &now_utc())
    }

    pub fn set_artist_flags(
        &self,
        id: &str,
        pinned: Option<bool>,
        hidden: Option<bool>,
    ) -> Result<String, LibraryError> {
        set_flags(&*self.connection()?, id, pinned, hidden, &now_utc())
    }

    pub fn merge_artists(
        &self,
        target: &str,
        sources: &[String],
        display_name: Option<&str>,
    ) -> Result<String, LibraryError> {
        merge(
            &*self.connection()?,
            target,
            sources,
            display_name,
            &now_utc(),
        )
    }

    pub fn detach_artist_member(&self, id: &str, key: &str) -> Result<String, LibraryError> {
        detach_member(&*self.connection()?, id, key, &now_utc())
    }

    pub fn detach_artist_assignments(
        &self,
        id: &str,
        source: &str,
    ) -> Result<String, LibraryError> {
        detach_assignments(&*self.connection()?, id, source, &now_utc())
    }

    pub fn dismiss_artist_merge(&self, key_a: &str, key_b: &str) -> Result<(), LibraryError> {
        dismiss_suggestion(&*self.connection()?, key_a, key_b, &now_utc())
    }

    pub fn assign_assets_to_artist(
        &self,
        asset_ids: &[String],
        artist_id: Option<&str>,
        new_name: Option<&str>,
    ) -> Result<String, LibraryError> {
        assign_assets(
            &*self.connection()?,
            asset_ids,
            artist_id,
            new_name,
            &now_utc(),
        )
    }

    pub fn set_artist_settings(
        &self,
        settings: ArtistSettings,
    ) -> Result<ArtistSettings, LibraryError> {
        set_settings(&*self.connection()?, settings)
    }
}
