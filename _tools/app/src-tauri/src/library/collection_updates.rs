use super::{
    error::LibraryError,
    models::{MangaDexCoverCandidate, ReleaseWatchRunStopReason},
    provider_requests, Library,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, time::Instant};

const BATCH_SIZE: usize = 8;
const BATCH_SECONDS: u64 = 15;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionUpdateFailure {
    pub collection_id: String,
    pub detected_at: String,
    #[serde(flatten)]
    pub request: provider_requests::Failure,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionUpdateStatus {
    pub provider: String,
    pub checked: u64,
    pub changed_collections: u64,
    pub failed: u64,
    pub remaining: u64,
    pub requests: u64,
    pub elapsed_ms: u64,
    pub network_ms: u64,
    pub throttle_ms: u64,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub retry_at: Option<String>,
    pub stop_reason: Option<ReleaseWatchRunStopReason>,
    #[serde(default)]
    pub consecutive_failures: u32,
    #[serde(default)]
    pub last_failure: Option<CollectionUpdateFailure>,
    #[serde(default)]
    pub busy: bool,
}

fn valid_provider(provider: &str) -> Result<&'static str, LibraryError> {
    match provider {
        "mangadex" => Ok("mangadex"),
        "kakao" => Ok("kakao"),
        _ => Err(LibraryError::InvalidCollectionMetadata),
    }
}
fn due(
    connection: &rusqlite::Connection,
    provider: &str,
    now: &str,
) -> Result<Vec<String>, LibraryError> {
    let mut statement=connection.prepare("SELECT b.collection_id FROM collection_external_bindings b JOIN collections c ON c.id=b.collection_id LEFT JOIN collection_update_attempts a ON a.collection_id=b.collection_id AND a.provider=b.provider WHERE c.type='manga' AND b.provider=?1 AND (b.last_synced_at IS NULL OR julianday(b.last_synced_at) IS NULL OR julianday(b.last_synced_at)<=julianday(?2)-1) AND (a.retry_at IS NULL OR julianday(a.retry_at)<=julianday(?2)) ORDER BY COALESCE(b.last_synced_at,''),b.collection_id")?;
    let rows = statement
        .query_map(params![provider, now], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

impl Library {
    pub fn collection_update_status(
        &self,
        provider: &str,
    ) -> Result<CollectionUpdateStatus, LibraryError> {
        let provider = valid_provider(provider)?;
        let connection = self.connection()?;
        let json = connection
            .query_row(
                "SELECT status_json FROM collection_update_status WHERE provider=?1",
                [provider],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let mut status = json
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_else(|| CollectionUpdateStatus {
                provider: provider.into(),
                ..Default::default()
            });
        status.remaining =
            due(&connection, provider, &chrono::Utc::now().to_rfc3339())?.len() as u64;
        // Old status JSON used a one-hour cooldown for every transport error.
        // Reinterpret only that legacy temporary cooldown, without a DB migration
        // or relaxing previously saved quota/authentication restrictions.
        if status.consecutive_failures == 0
            && matches!(
                status.stop_reason,
                Some(ReleaseWatchRunStopReason::Unavailable | ReleaseWatchRunStopReason::TimedOut)
            )
        {
            if let Some(retry) = status
                .retry_at
                .as_deref()
                .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            {
                status.retry_at = Some((retry - chrono::Duration::seconds(3595)).to_rfc3339());
                status.consecutive_failures = 1;
            }
        }
        Ok(status)
    }

    pub fn run_collection_updates(
        &self,
        provider: &str,
        key: Result<String, LibraryError>,
    ) -> Result<CollectionUpdateStatus, LibraryError> {
        let provider = valid_provider(provider)?;
        self.run_collection_updates_with(provider, |id| {
            if provider == "mangadex" {
                self.refresh_mangadex(id)?;
            } else {
                let key = key.as_ref().map_err(|error| match error {
                    LibraryError::AladinCredentialNotConfigured => {
                        LibraryError::AladinCredentialNotConfigured
                    }
                    LibraryError::InvalidAladinCredential => LibraryError::InvalidAladinCredential,
                    _ => LibraryError::AladinUnavailable,
                })?;
                self.refresh_kakao(key, id)?;
            }
            Ok(())
        })
    }

    fn run_collection_updates_with(
        &self,
        provider: &'static str,
        mut refresh: impl FnMut(&str) -> Result<(), LibraryError>,
    ) -> Result<CollectionUpdateStatus, LibraryError> {
        // A manual check and the startup/hourly loop share this lock. Don't queue
        // another long job when one is already running.
        let _guard = match self.release_watch_lock.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                return Ok(CollectionUpdateStatus {
                    busy: true,
                    ..self.collection_update_status(provider)?
                })
            }
        };
        let now = chrono::Utc::now();
        let now_text = now.to_rfc3339();
        let mut status = self.collection_update_status(provider)?;
        if status
            .retry_at
            .as_deref()
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .is_some_and(|retry| retry > now)
        {
            return Ok(status);
        }
        let pending = due(&*self.connection()?, provider, &now_text)?;
        if pending.is_empty() {
            return Ok(status);
        }
        if status.finished_at.is_some() || status.started_at.is_none() {
            status = CollectionUpdateStatus {
                provider: provider.into(),
                started_at: Some(now_text.clone()),
                ..Default::default()
            };
        }
        status.retry_at = None;
        status.stop_reason = None;
        status.remaining = pending.len() as u64;
        let started = Instant::now();
        let metrics = provider_requests::metrics();
        for id in pending.iter().take(BATCH_SIZE) {
            if started.elapsed().as_secs() >= BATCH_SECONDS {
                break;
            }
            let before = self.connection()?.query_row(
                "SELECT COUNT(*) FROM release_watch_events WHERE collection_id=?1 AND provider=?2",
                params![id, provider],
                |row| row.get::<_, i64>(0),
            )?;
            provider_requests::take_failure();
            match refresh(id) {
                Ok(()) => {
                    status.consecutive_failures = 0;
                    if status
                        .last_failure
                        .as_ref()
                        .is_some_and(|failure| failure.collection_id == *id)
                    {
                        status.last_failure = None;
                    }
                    status.checked += 1;
                    let connection = self.connection()?;
                    connection.execute("DELETE FROM collection_update_attempts WHERE collection_id=?1 AND provider=?2",params![id,provider])?;
                    let after=connection.query_row("SELECT COUNT(*) FROM release_watch_events WHERE collection_id=?1 AND provider=?2",params![id,provider],|row|row.get::<_,i64>(0))?;
                    if after > before {
                        status.changed_collections += 1;
                    }
                }
                Err(error) => {
                    status.failed += 1;
                    let reason = stop_reason(&error);
                    let failure = provider_requests::take_failure().unwrap_or_else(|| {
                        provider_requests::Failure::new(
                            match &error {
                                LibraryError::MangaDexNotFound => "not_found",
                                LibraryError::InvalidMangaDexResponse
                                | LibraryError::InvalidAladinResponse => "invalid_response",
                                LibraryError::MangaDexTimedOut | LibraryError::AladinTimedOut => {
                                    "timeout"
                                }
                                _ => "unknown",
                            },
                            "refresh",
                        )
                    });
                    let work_error = failure.http_status.is_some_and(|code| {
                        (400..500).contains(&code) && !matches!(code, 401 | 403 | 408 | 429)
                    });
                    status.last_failure = Some(CollectionUpdateFailure {
                        collection_id: id.clone(),
                        detected_at: chrono::Utc::now().to_rfc3339(),
                        request: failure.clone(),
                    });
                    // Invalid content can belong to just one title (for example
                    // a search exceeding the pagination bound). Defer that work
                    // and let other titles proceed; transport failures cool down
                    // the entire provider.
                    if let Some(reason) = reason.filter(|reason| {
                        *reason != ReleaseWatchRunStopReason::InvalidResponse && !work_error
                    }) {
                        status.consecutive_failures = status.consecutive_failures.saturating_add(1);
                        let seconds = retry_seconds(reason, &failure, status.consecutive_failures);
                        status.stop_reason = Some(reason);
                        status.retry_at = Some(
                            (chrono::Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339(),
                        );
                        break;
                    }
                    status.consecutive_failures = 0;
                    // A removed or mismatched work must not block the rest, nor
                    // be retried continuously by each continuation batch.
                    self.connection()?.execute("INSERT INTO collection_update_attempts(collection_id,provider,retry_at) VALUES(?1,?2,?3) ON CONFLICT(collection_id,provider) DO UPDATE SET retry_at=excluded.retry_at",params![id,provider,(chrono::Utc::now()+chrono::Duration::hours(24)).to_rfc3339()])?;
                }
            }
        }
        let after = provider_requests::metrics();
        status.requests += after.requests - metrics.requests;
        status.network_ms += after.network_ms - metrics.network_ms;
        status.throttle_ms += after.throttle_ms - metrics.throttle_ms;
        status.elapsed_ms += started.elapsed().as_millis() as u64;
        status.remaining = due(
            &*self.connection()?,
            provider,
            &chrono::Utc::now().to_rfc3339(),
        )?
        .len() as u64;
        if status.remaining == 0 {
            status.finished_at = Some(chrono::Utc::now().to_rfc3339());
        }
        self.connection()?.execute("INSERT INTO collection_update_status(provider,status_json) VALUES(?1,?2) ON CONFLICT(provider) DO UPDATE SET status_json=excluded.status_json",params![provider,serde_json::to_string(&status).map_err(|_|LibraryError::InvalidCollectionMetadata)?])?;
        Ok(status)
    }
}
fn retry_seconds(
    reason: ReleaseWatchRunStopReason,
    failure: &provider_requests::Failure,
    consecutive: u32,
) -> i64 {
    use ReleaseWatchRunStopReason::*;
    let index = consecutive.saturating_sub(1).min(3) as usize;
    let base = match reason {
        RateLimited => [60, 120, 300, 900][index],
        CredentialNotConfigured | InvalidCredential => 3600,
        _ if matches!(failure.http_status, Some(401 | 403)) => 3600,
        _ => [5, 30, 120, 600][index],
    };
    // Server deadlines are minimum waits, also when a 503 supplies Retry-After.
    base.max(failure.retry_after_seconds.unwrap_or(0).min(86400) as i64)
}
fn stop_reason(error: &LibraryError) -> Option<ReleaseWatchRunStopReason> {
    use LibraryError::*;
    use ReleaseWatchRunStopReason::*;
    Some(match error {
        AladinCredentialNotConfigured => CredentialNotConfigured,
        InvalidAladinCredential => InvalidCredential,
        AladinRateLimited | MangaDexRateLimited => RateLimited,
        AladinTimedOut | MangaDexTimedOut => TimedOut,
        AladinUnavailable | MangaDexUnavailable => Unavailable,
        InvalidAladinResponse | InvalidMangaDexResponse => InvalidResponse,
        _ => return None,
    })
}

// Keep a monotonic set: temporary cover removal/reappearance and changing cover
// artwork must not generate another new-volume event. Kakao volume rows are not
// used as the MangaDex baseline, since both providers share a volume shelf.
pub(super) fn reconcile_mangadex_volumes(
    transaction: &Transaction<'_>,
    id: &str,
    manga_id: &str,
    covers: &[MangaDexCoverCandidate],
) -> Result<(), LibraryError> {
    let previous = transaction
        .query_row(
            "SELECT manga_id FROM collection_mangadex_baselines WHERE collection_id=?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let initialized = previous.as_deref() == Some(manga_id);
    if !initialized {
        transaction.execute(
            "DELETE FROM collection_mangadex_baselines WHERE collection_id=?1",
            [id],
        )?;
        transaction.execute(
            "INSERT INTO collection_mangadex_baselines(collection_id,manga_id) VALUES(?1,?2)",
            params![id, manga_id],
        )?;
    }
    let slots = covers
        .iter()
        .filter(|c| c.language.as_deref() == Some("ja"))
        .filter_map(|c| {
            c.volume
                .as_deref()
                .and_then(super::collection_volume::parse_volume_slot)
        })
        .collect::<BTreeSet<_>>();
    for (volume, edition) in slots {
        let inserted=transaction.execute("INSERT OR IGNORE INTO collection_mangadex_seen_volumes(collection_id,volume_number,edition_index) VALUES(?1,?2,?3)",params![id,volume,edition])?;
        if initialized && inserted > 0 && volume <= 999 {
            transaction.execute("INSERT INTO release_watch_events(id,collection_id,event_kind,volume_number,detected_at,provider) VALUES(?1,?2,'new_volume',?3,?4,'mangadex')",params![uuid::Uuid::new_v4().to_string(),id,volume,chrono::Utc::now().to_rfc3339()])?;
        }
    }
    super::collection_volume::materialize_mangadex_volumes(transaction, id, covers, None)
}

#[cfg(test)]
mod tests;
