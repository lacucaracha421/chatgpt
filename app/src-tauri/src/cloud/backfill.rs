//! CLOUD-006 배치 3: 전체 라이브러리 백필 큐 시딩 + 데스크톱 복제 워커.
//!
//! - 시딩: 모든 정상 자산을 `cloud_sync_queue`에 pending으로 등록한다.
//!   이미 synced인 자산은 건너뛴다. 재실행해도 중복 행이 생기지 않는다.
//!   최근 수집 자산이 먼저 처리되도록 updated_at에 collected_at을 쓴다.
//! - 워커: 한 번에 `BACKFILL_CONCURRENCY`개의 자산을 prepare → 업로드 →
//!   commit한다. 진행 단계는 큐 status(preparing/uploading/committing)로
//!   영속 기록되어 앱 재시작·네트워크 중단 후 이어진다. 재시도 가능 오류는
//!   pending으로, 영구 오류는 failed로 되돌린다.

use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::client::CloudClient;
use super::models::PreparedAssetUpload;
use super::sync::{hex_digest, is_retryable_cloud_error};
use crate::library::error::LibraryError;
use crate::library::Library;

/// 백필 워커의 동시 업로드 수. 설정 가능하도록 한 곳에 정의한다.
pub(crate) const BACKFILL_CONCURRENCY: usize = 4;
/// 개별 자산 재시도 전 대기. 백필은 야간 최대 처리량이 목표라 짧게 유지한다.
const RETRY_BACKOFF: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackfillControlState {
    Idle,
    Running,
    Paused,
}

impl BackfillControlState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Paused => "paused",
        }
    }

    fn from_database(value: &str) -> Result<Self, LibraryError> {
        match value {
            "idle" => Ok(Self::Idle),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            _ => Err(LibraryError::InvalidCloudSyncQueueItem),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillSeedReport {
    pub seeded: u64,
    pub skipped_replicated: u64,
    pub skipped_problem: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillBoundedSeedReport {
    pub selected: u64,
    pub newly_queued: u64,
    pub already_queued: u64,
    pub already_replicated: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillProgress {
    pub control_state: BackfillControlState,
    pub total_assets: u64,
    pub queued: u64,
    pub preparing: u64,
    pub uploading: u64,
    pub committing: u64,
    pub completed: u64,
    pub failed: u64,
    pub active_workers: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillRetryReport {
    pub retried: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillReconcileReport {
    pub requeued: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillRunSummary {
    pub committed: u64,
    pub retry_scheduled: u64,
    pub permanent_failures: u64,
}

impl Library {
    pub(crate) fn suspend_running_cloud_backfill_on_open(&self) -> Result<(), LibraryError> {
        self.connection()?.execute(
            "UPDATE cloud_backfill_control SET state = 'paused', updated_at = ?1
             WHERE singleton = 1 AND state = 'running'",
            [chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn cloud_backfill_control_state(&self) -> Result<BackfillControlState, LibraryError> {
        let value = self.connection()?.query_row(
            "SELECT state FROM cloud_backfill_control WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )?;
        BackfillControlState::from_database(&value)
    }

    pub fn set_cloud_backfill_control_state(
        &self,
        state: BackfillControlState,
    ) -> Result<BackfillControlState, LibraryError> {
        self.connection()?.execute(
            "UPDATE cloud_backfill_control SET state = ?1, updated_at = ?2
             WHERE singleton = 1",
            params![state.as_str(), chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(state)
    }

    pub fn reconcile_cloud_backfill(&self) -> Result<BackfillReconcileReport, LibraryError> {
        let connection = self.connection()?;
        let now = chrono::Utc::now().to_rfc3339();
        let interrupted = connection.execute(
            "UPDATE cloud_sync_queue
             SET status = 'pending', updated_at = ?1,
                 last_error = COALESCE(last_error, 'interrupted before completion')
             WHERE entity_type = 'asset' AND operation = 'upsert'
               AND status IN ('preparing', 'uploading', 'committing')
               AND (NOT EXISTS (SELECT 1 FROM cloud_backfill_scope)
                    OR entity_id IN (SELECT asset_id FROM cloud_backfill_scope))",
            [&now],
        )? as u64;
        let thumbnail_waiting = connection.execute(
            "UPDATE cloud_sync_queue
             SET status = 'pending', updated_at = ?1, last_error = NULL
             WHERE entity_type = 'asset' AND operation = 'upsert'
               AND status = 'failed' AND last_error = ?2
               AND EXISTS (
                 SELECT 1 FROM assets
                 WHERE assets.id = cloud_sync_queue.entity_id
                   AND assets.thumbnail_relative_path IS NOT NULL
               )
               AND (NOT EXISTS (SELECT 1 FROM cloud_backfill_scope)
                    OR entity_id IN (SELECT asset_id FROM cloud_backfill_scope))",
            params![now, LibraryError::CloudThumbnailUnavailable.to_string()],
        )? as u64;
        Ok(BackfillReconcileReport {
            requeued: interrupted + thumbnail_waiting,
        })
    }

    pub(crate) fn requeue_cloud_asset_after_thumbnail_ready(
        &self,
        asset_id: &str,
    ) -> Result<bool, LibraryError> {
        let changed = self.connection()?.execute(
            "UPDATE cloud_sync_queue
             SET status = 'pending', updated_at = ?2, last_error = NULL
             WHERE entity_type = 'asset' AND entity_id = ?1 AND operation = 'upsert'
               AND status = 'failed' AND last_error = ?3",
            params![
                asset_id,
                chrono::Utc::now().to_rfc3339(),
                LibraryError::CloudThumbnailUnavailable.to_string()
            ],
        )?;
        Ok(changed > 0)
    }

    /// 전체 라이브러리 자산을 백필 큐에 등록한다. 이미 synced인 자산은
    /// 건너뛴다. 멱등: UNIQUE(entity_type, entity_id, operation, revision)
    /// 보호로 재실행해도 중복 행이 생기지 않는다. 최근 수집 자산이 먼저
    /// 처리되도록 updated_at에 collected_at을 쓴다.
    pub fn seed_cloud_backfill_queue(&self) -> Result<BackfillSeedReport, LibraryError> {
        let connection = self.connection()?;
        connection.execute("DELETE FROM cloud_backfill_scope", [])?;

        // 카운트는 삽입 실패 추정이 아니라 명시적 질의로 계산한다.
        // total_candidates: 정상 자산 전체 / already_replicated: 큐에 synced 행이
        // 있는 자산 / eligible: 백필이 필요한 자산(= candidates).
        let total_candidates = connection.query_row(
            "SELECT COUNT(*) FROM assets WHERE status = 'normal'",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let already_replicated = connection.query_row(
            "SELECT COUNT(*) FROM assets AS asset
             WHERE asset.status = 'normal'
               AND EXISTS (
                   SELECT 1 FROM cloud_sync_queue AS queue
                   WHERE queue.entity_type = 'asset'
                     AND queue.entity_id = asset.id
                     AND queue.operation = 'upsert'
                     AND queue.status = 'synced'
               )",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64;

        let candidates: Vec<(String, String)> = {
            let mut statement = connection.prepare(
                "SELECT asset.id, asset.collected_at
                 FROM assets AS asset
                 WHERE asset.status = 'normal'
                   AND NOT EXISTS (
                       SELECT 1 FROM cloud_sync_queue AS queue
                       WHERE queue.entity_type = 'asset'
                         AND queue.entity_id = asset.id
                         AND queue.operation = 'upsert'
                         AND queue.status = 'synced'
                   )
                 ORDER BY asset.collected_at DESC, asset.id",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        eprintln!(
            "cloud backfill seeding: {} candidates, {already_replicated} already replicated",
            candidates.len()
        );

        let mut seeded = 0u64;
        for (asset_id, collected_at) in candidates {
            let inserted = connection.execute(
                "INSERT INTO cloud_sync_queue (
                     id, entity_type, entity_id, operation, status, revision, updated_at
                 ) VALUES (?1, 'asset', ?2, 'upsert', 'pending', 1, ?3)
                 ON CONFLICT(entity_type, entity_id, operation, revision) DO NOTHING",
                params![uuid::Uuid::new_v4().to_string(), asset_id, collected_at],
            )?;
            seeded += u64::from(inserted == 1);
        }

        eprintln!(
            "cloud backfill seeding done: total_candidates={total_candidates} seeded={seeded} already_replicated={already_replicated}"
        );
        Ok(BackfillSeedReport {
            seeded,
            skipped_replicated: already_replicated,
            skipped_problem: 0,
        })
    }

    /// Staged production rollout 전용: 선택된 자산만 현재 worker scope로
    /// 고정하고 기존 큐에 멱등 등록한다. 정상 full seed는 이 scope를 지운다.
    pub fn seed_bounded_cloud_backfill(
        &self,
        asset_ids: &[String],
    ) -> Result<BackfillBoundedSeedReport, LibraryError> {
        if asset_ids.is_empty() || asset_ids.len() > 500 {
            return Err(LibraryError::InvalidCloudSyncQueueItem);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM cloud_backfill_scope", [])?;

        let mut newly_queued = 0u64;
        let mut already_queued = 0u64;
        let mut already_replicated = 0u64;
        let mut unique_ids = std::collections::BTreeSet::new();
        for asset_id in asset_ids {
            if !unique_ids.insert(asset_id.clone()) {
                return Err(LibraryError::InvalidCloudSyncQueueItem);
            }
            let collected_at = transaction
                .query_row(
                    "SELECT collected_at FROM assets WHERE id = ?1 AND status = 'normal'",
                    [asset_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or(LibraryError::AssetNotFound)?;
            transaction.execute(
                "INSERT INTO cloud_backfill_scope (asset_id) VALUES (?1)",
                [asset_id],
            )?;
            let status = transaction
                .query_row(
                    "SELECT status FROM cloud_sync_queue
                     WHERE entity_type = 'asset' AND entity_id = ?1
                       AND operation = 'upsert' AND revision = 1",
                    [asset_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            match status.as_deref() {
                Some("synced") => already_replicated += 1,
                Some(_) => already_queued += 1,
                None => {
                    transaction.execute(
                        "INSERT INTO cloud_sync_queue (
                            id, entity_type, entity_id, operation, status, revision, updated_at
                         ) VALUES (?1, 'asset', ?2, 'upsert', 'pending', 1, ?3)",
                        params![uuid::Uuid::new_v4().to_string(), asset_id, collected_at],
                    )?;
                    newly_queued += 1;
                }
            }
        }
        transaction.commit()?;
        Ok(BackfillBoundedSeedReport {
            selected: unique_ids.len() as u64,
            newly_queued,
            already_queued,
            already_replicated,
        })
    }

    /// 백필 큐의 영속 상태 요약(queued/preparing/uploading/committing/
    /// completed/failed).
    pub fn cloud_backfill_progress(&self) -> Result<BackfillProgress, LibraryError> {
        let connection = self.connection()?;
        let count = |status: &str| -> Result<u64, LibraryError> {
            Ok(connection.query_row(
                "SELECT COUNT(*)
                     FROM cloud_sync_queue AS queue
                     JOIN assets AS asset ON asset.id = queue.entity_id
                     WHERE queue.entity_type = 'asset'
                       AND queue.operation = 'upsert'
                       AND queue.status = ?1
                       AND asset.status = 'normal'
                       AND (NOT EXISTS (SELECT 1 FROM cloud_backfill_scope)
                            OR queue.entity_id IN (SELECT asset_id FROM cloud_backfill_scope))",
                [status],
                |row| row.get::<_, i64>(0),
            )? as u64)
        };
        let preparing = count("preparing")?;
        let uploading = count("uploading")?;
        let committing = count("committing")?;
        let last_error = connection
            .query_row(
                "SELECT queue.last_error
                 FROM cloud_sync_queue AS queue
                 JOIN assets AS asset ON asset.id = queue.entity_id
                 WHERE queue.entity_type = 'asset' AND queue.operation = 'upsert'
                   AND queue.last_error IS NOT NULL
                   AND asset.status = 'normal'
                   AND (NOT EXISTS (SELECT 1 FROM cloud_backfill_scope)
                        OR queue.entity_id IN (SELECT asset_id FROM cloud_backfill_scope))
                 ORDER BY queue.updated_at DESC, queue.id DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let total_assets = connection.query_row(
            "SELECT CASE WHEN EXISTS (SELECT 1 FROM cloud_backfill_scope)
                    THEN (SELECT COUNT(*) FROM cloud_backfill_scope)
                    ELSE (SELECT COUNT(*) FROM assets WHERE status = 'normal') END",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let control_value = connection.query_row(
            "SELECT state FROM cloud_backfill_control WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )?;
        Ok(BackfillProgress {
            control_state: BackfillControlState::from_database(&control_value)?,
            total_assets,
            queued: count("pending")?,
            preparing,
            uploading,
            committing,
            completed: count("synced")?,
            failed: count("failed")?,
            active_workers: preparing + uploading + committing,
            last_error,
        })
    }

    /// failed 상태의 백필 항목을 pending으로 되돌려 재시도 가능하게 한다.
    /// 영구 오류(원본 소실 등)도 명시적 사용자 재시도 시에는 다시 검사한다
    /// (원본이 복구되었을 수 있음). 재시도는 개별 자산 단위로 독립적이다.
    pub fn retry_failed_cloud_backfill(&self) -> Result<BackfillRetryReport, LibraryError> {
        let connection = self.connection()?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = connection.execute(
            "UPDATE cloud_sync_queue
             SET status = 'pending', updated_at = ?1
             WHERE entity_type = 'asset' AND operation = 'upsert'
               AND status = 'failed'
               AND (NOT EXISTS (SELECT 1 FROM cloud_backfill_scope)
                    OR entity_id IN (SELECT asset_id FROM cloud_backfill_scope))",
            [now],
        )? as u64;
        eprintln!("cloud backfill retry: {changed} failed items requeued");
        Ok(BackfillRetryReport { retried: changed })
    }

    /// 백필 워커 한 사이클: 동시에 최대 `BACKFILL_CONCURRENCY`개의 자산을
    /// 처리한다. 한 자산의 실패는 독립적으로 기록되고 나머지 처리를 막지
    /// 않는다. 재시도 가능 오류는 해당 워커가 잠시 대기 후 다음 자산을
    /// 계속 가져간다.
    pub fn run_cloud_backfill_cycle(&self) -> Result<BackfillRunSummary, LibraryError> {
        let config = self.cloud_sync_config()?;
        if !config.enabled {
            return Ok(BackfillRunSummary::default());
        }
        let base_url = config
            .api_base_url
            .ok_or(LibraryError::InvalidCloudSyncConfig)?;
        let token = crate::library::credential::read_cloud_api_token_os()?;
        let client = CloudClient::new(&base_url)?;
        self.run_cloud_backfill_cycle_with_client(&client, &token)
    }

    /// 클라이언트를 주입받는 사이클(테스트용). 프로덕션은
    /// `run_cloud_backfill_cycle`이 설정에서 클라이언트를 만든다.
    pub(crate) fn run_cloud_backfill_cycle_with_client(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<BackfillRunSummary, LibraryError> {
        let summary = std::sync::Arc::new(std::sync::Mutex::new(BackfillRunSummary::default()));
        let library = std::sync::Arc::new(self.clone());
        let token = std::sync::Arc::new(token.to_owned());

        std::thread::scope(|scope| {
            for _ in 0..BACKFILL_CONCURRENCY {
                let library = std::sync::Arc::clone(&library);
                let client = client;
                let token = std::sync::Arc::clone(&token);
                let summary = std::sync::Arc::clone(&summary);
                scope.spawn(move || {
                    // 재시도 가능 오류도 사이클당 최대 N회로 제한한다. 무한
                    // 재시도는 야간 백필이 끝나지 않는 원인이 된다. 남은
                    // 재시도는 다음 사이클(수동/예약)에서 이어간다.
                    let mut consecutive_retries = 0u32;
                    const MAX_CONSECUTIVE_RETRIES: u32 = 3;
                    loop {
                        match library.replicate_next_cloud_asset(client, &token) {
                            Ok(Some(_)) => {
                                summary.lock().unwrap().committed += 1;
                                consecutive_retries = 0;
                            }
                            Ok(None) => break,
                            Err(CloudBackfillError::Retryable(asset_id, message)) => {
                                summary.lock().unwrap().retry_scheduled += 1;
                                consecutive_retries += 1;
                                eprintln!("cloud backfill retryable {asset_id}: {message}");
                                if consecutive_retries >= MAX_CONSECUTIVE_RETRIES {
                                    eprintln!(
                                        "cloud backfill giving up for this cycle after {consecutive_retries} consecutive retries"
                                    );
                                    break;
                                }
                                std::thread::sleep(RETRY_BACKOFF);
                            }
                            Err(CloudBackfillError::Permanent(asset_id, message)) => {
                                summary.lock().unwrap().permanent_failures += 1;
                                eprintln!("cloud backfill permanent failure {asset_id}: {message}");
                                consecutive_retries = 0;
                            }
                            Err(CloudBackfillError::Library(error)) => {
                                eprintln!("cloud backfill library error: {error}");
                                break;
                            }
                        }
                    }
                });
            }
        });

        let summary = std::sync::Arc::try_unwrap(summary)
            .map_err(|_| LibraryError::InvalidCloudSyncQueueItem)?
            .into_inner()
            .unwrap_or_default();
        eprintln!(
            "cloud backfill cycle summary: committed={} retry_scheduled={} permanent_failures={}",
            summary.committed, summary.retry_scheduled, summary.permanent_failures
        );
        Ok(summary)
    }

    /// 테스트 전용: 백필 클레임 순서(최신 우선)를 검증한다.
    #[cfg(test)]
    pub(crate) fn claim_next_backfill_for_test(
        &self,
    ) -> Result<Option<PreparedAssetUpload>, LibraryError> {
        Ok(self.claim_next_backfill_asset())
    }

    /// 테스트 전용: 단일 자산 복제를 직접 구동한다(사이클 동시성 없이).
    #[cfg(test)]
    pub(crate) fn replicate_next_cloud_asset_with_client(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<Option<String>, CloudBackfillError> {
        self.replicate_next_cloud_asset(client, token)
    }

    /// 큐에서 다음 자산을 꺼내 prepare → 업로드 → commit까지 완주한다.
    /// 자산 하나의 실패는 호출자에게 CloudBackfillError로 보고되고 큐 상태에
    /// 영속 반영된다. Ok(None)이면 큐가 비어 있다.
    pub(crate) fn replicate_next_cloud_asset(
        &self,
        client: &CloudClient,
        token: &str,
    ) -> Result<Option<String>, CloudBackfillError> {
        let Some(prepared) = self.claim_next_backfill_asset() else {
            return Ok(None);
        };
        let asset_id = prepared.queue.entity_id.clone();
        let queue_id = prepared.queue.id.clone();
        eprintln!(
            "cloud backfill upload start: asset={asset_id} kind={} size={}",
            prepared.kind, prepared.size_bytes
        );

        self.set_backfill_status(&queue_id, "uploading")
            .map_err(CloudBackfillError::Library)?;
        // 0. 로컬 원본 검증을 네트워크 작업보다 먼저 한다. 원본이 없는 자산은
        // 서버와 아무 통신 없이 영구 실패로 처리된다(개별 자산 격리).
        let source = match self.open_validated_cloud_source(&prepared) {
            Ok(source) => source,
            Err(error) => {
                self.backfill_failure(&queue_id, &error)
                    .map_err(CloudBackfillError::Library)?;
                return Err(classify_backfill_error(asset_id, &error));
            }
        };

        // 1. 서버 prepare (멱등). 이미 커밋된 자산이면 업로드를 건너뛴다.
        let prepare_result = match client.replication_prepare(prepared_metadata(&prepared), token) {
            Ok(result) => result,
            Err(error) => {
                self.backfill_failure(&queue_id, &error)
                    .map_err(CloudBackfillError::Library)?;
                return Err(classify_backfill_error(asset_id, &error));
            }
        };
        if prepare_result.already_committed {
            // 원본/썸네일은 그대로다. 관계-only 변경(revision 상승)이라도
            // 커밋을 다시 보내 classification_ids를 수렴시킨다. 서버 commit은
            // 멱등 업서트라 안전하다.
            let commit_payload = self
                .backfill_commit_payload(&prepared)
                .map_err(|error| classify_backfill_error(asset_id.clone(), &error))?;
            if let Err(error) = client.commit_replication(&commit_payload_wire(&commit_payload), token)
            {
                self.backfill_failure(&queue_id, &error)
                    .map_err(CloudBackfillError::Library)?;
                return Err(classify_backfill_error(asset_id, &error));
            }
            self.mark_cloud_sync_synced(&queue_id)
                .map_err(CloudBackfillError::Library)?;
            eprintln!("cloud backfill re-committed relations only: asset={asset_id}");
            return Ok(Some(asset_id));
        }

        // 2. 원본 + 썸네일 업로드(기존 presign 흐름 재사용).
        let upload_result = client
            .upload_asset(&prepared, source, token)
            .and_then(|()| self.upload_backfill_thumbnail(client, &prepared, token));
        if let Err(error) = upload_result {
            self.backfill_failure(&queue_id, &error)
                .map_err(CloudBackfillError::Library)?;
            return Err(classify_backfill_error(asset_id, &error));
        }

        // 3. 커밋: 메타데이터 + 분류 관계를 원자적으로 기록한다.
        self.set_backfill_status(&queue_id, "committing")
            .map_err(CloudBackfillError::Library)?;
        let commit_payload = self
            .backfill_commit_payload(&prepared)
            .map_err(|error| classify_backfill_error(asset_id.clone(), &error))?;
        if let Err(error) = client.commit_replication(&commit_payload_wire(&commit_payload), token)
        {
            self.backfill_failure(&queue_id, &error)
                .map_err(CloudBackfillError::Library)?;
            return Err(classify_backfill_error(asset_id, &error));
        }

        self.mark_cloud_sync_synced(&queue_id)
            .map_err(CloudBackfillError::Library)?;
        eprintln!("cloud backfill committed: asset={asset_id}");
        Ok(Some(asset_id))
    }

    fn claim_next_backfill_asset(&self) -> Option<PreparedAssetUpload> {
        // 백필 전용 클레임: 최근 수집 자산부터(updated_at DESC) 원자적으로
        // preparing으로 전이한다. 점증 동기화(sync.rs)는 FIFO(ASC)을 유지해
        // 서로 간섭하지 않는다. 비디오 reserve와 같은 UPDATE...RETURNING 패턴.
        let mut connection = self.connection().ok()?;
        let transaction = connection.transaction().ok()?;
        let claimed = transaction
            .query_row(
                "SELECT queue.id, queue.entity_id, asset.media_kind,
                        asset.relative_path, asset.byte_size, asset.content_hash
                 FROM cloud_sync_queue AS queue
                 JOIN assets AS asset ON asset.id = queue.entity_id
                 WHERE queue.status = 'pending'
                   AND queue.entity_type = 'asset'
                   AND queue.operation = 'upsert'
                   AND asset.status = 'normal'
                   AND (NOT EXISTS (SELECT 1 FROM cloud_backfill_scope)
                        OR queue.entity_id IN (SELECT asset_id FROM cloud_backfill_scope))
                   AND NOT EXISTS (
                       SELECT 1 FROM cloud_backfill_control
                       WHERE singleton = 1 AND state = 'paused'
                   )
                 ORDER BY queue.updated_at DESC, queue.id
                 LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()
            .ok()?;
        let Some((queue_id, asset_id, media_kind, relative_path, byte_size, sha256)) = claimed
        else {
            return None;
        };
        transaction
            .execute(
                "UPDATE cloud_sync_queue SET status = 'preparing', updated_at = ?2
                 WHERE id = ?1 AND status = 'pending'",
                params![queue_id, chrono::Utc::now().to_rfc3339()],
            )
            .ok()?;
        transaction.commit().ok()?;

        let content_type = super::sync::content_type(&media_kind, &relative_path).ok()?;
        let object_key = match media_kind.as_str() {
            "image" | "gif" | "video" => format!("library/{asset_id}/original"),
            _ => return None,
        };
        Some(PreparedAssetUpload {
            queue: super::models::CloudSyncQueueItem {
                id: queue_id,
                entity_type: "asset".into(),
                entity_id: asset_id,
                operation: "upsert".into(),
                status: "preparing".into(),
                revision: 1,
                retry_count: 0,
                updated_at: chrono::Utc::now().to_rfc3339(),
                synced_at: None,
                last_error: None,
            },
            object_key,
            source_relative_path: relative_path,
            kind: media_kind,
            content_type,
            size_bytes: u64::try_from(byte_size).ok()?,
            sha256,
        })
    }

    fn set_backfill_status(&self, queue_id: &str, status: &str) -> Result<(), LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        self.connection()?.execute(
            "UPDATE cloud_sync_queue SET status = ?2, updated_at = ?3
             WHERE id = ?1 AND status != 'synced'",
            params![queue_id, status, now],
        )?;
        Ok(())
    }

    fn backfill_failure(&self, queue_id: &str, error: &LibraryError) -> Result<(), LibraryError> {
        if is_retryable_cloud_error(error) {
            self.mark_cloud_sync_retry(queue_id, &error.to_string())
        } else {
            self.mark_cloud_sync_failed(queue_id, &error.to_string())
        }
    }

    /// 기존 썸네일 인프라가 만든 웹피 썸네일을 업로드한다. 썸네일이 없는
    /// 비디오(포스터 미준비)는 영구 실패로 처리한다.
    fn upload_backfill_thumbnail(
        &self,
        client: &CloudClient,
        prepared: &PreparedAssetUpload,
        token: &str,
    ) -> Result<(), LibraryError> {
        let thumbnail_path: Option<String> = self
            .connection()?
            .query_row(
                "SELECT thumbnail_relative_path FROM assets WHERE id = ?1",
                [&prepared.queue.entity_id],
                |row| row.get(0),
            )
            .map_err(|_| LibraryError::CloudThumbnailUnavailable)?;
        let Some(thumbnail_path) = thumbnail_path else {
            return Err(LibraryError::CloudThumbnailUnavailable);
        };
        let mut thumbnail = self
            .open_library_media(&thumbnail_path)
            .map_err(|_| LibraryError::CloudThumbnailUnavailable)?;
        let mut bytes = Vec::with_capacity(thumbnail.length as usize);
        std::io::Read::read_to_end(&mut thumbnail.file, &mut bytes)
            .map_err(|_| LibraryError::CloudThumbnailUnavailable)?;
        let sha256 = hex_digest(&{
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            hasher.finalize()
        });
        client.upload_replication_variant(
            &format!("library/{}/thumbnail", prepared.queue.entity_id),
            "image/webp",
            bytes,
            &sha256,
            token,
        )
    }

    /// commit 요청 본문: 서버 계약에 맞는 메타데이터 + 분류 관계.
    fn backfill_commit_payload(
        &self,
        prepared: &PreparedAssetUpload,
    ) -> Result<BackfillCommitPayload, LibraryError> {
        let connection = self.connection()?;
        let asset_id = prepared.queue.entity_id.as_str();
        let mut payload = connection
            .query_row(
                "SELECT collected_at, source_published_at, source_url,
                        creator_name, creator_handle, import_source
                 FROM assets WHERE id = ?1",
                [asset_id],
                |row| {
                    Ok(BackfillCommitPayload {
                        asset_id: asset_id.to_owned(),
                        kind: prepared.kind.clone(),
                        content_type: prepared.content_type.clone(),
                        original_size_bytes: prepared.size_bytes,
                        original_sha256: prepared.sha256.clone(),
                        collected_at: row.get(0)?,
                        source_published_at: row.get(1)?,
                        source_url: row.get(2)?,
                        creator_name: row.get(3)?,
                        creator_handle: row.get(4)?,
                        import_source: row.get(5)?,
                        classification_ids: Vec::new(),
                    })
                },
            )
            .map_err(|_| LibraryError::AssetNotFound)?;
        payload.classification_ids = connection
            .prepare(
                "SELECT classification_id FROM asset_classifications
                 WHERE asset_id = ?1 ORDER BY classification_id",
            )?
            .query_map([asset_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(payload)
    }
}

#[derive(Debug)]
pub(crate) enum CloudBackfillError {
    /// 재시도 가능(transport/서버 5xx). 큐는 pending으로 돌아간다.
    Retryable(String, String),
    /// 영구 오류(원본 없음 등). 큐는 failed가 되고 이 자산은 건너뛴다.
    Permanent(String, String),
    /// 큐/DB 수준 오류. 워커 사이클 자체를 중단한다.
    Library(LibraryError),
}

impl CloudBackfillError {
    pub(crate) fn is_retryable(&self) -> bool {
        matches!(self, CloudBackfillError::Retryable(_, _))
    }

    pub(crate) fn message(&self) -> String {
        match self {
            CloudBackfillError::Retryable(_, message)
            | CloudBackfillError::Permanent(_, message) => message.clone(),
            CloudBackfillError::Library(error) => error.to_string(),
        }
    }
}

impl std::fmt::Display for CloudBackfillError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloudBackfillError::Retryable(id, message) => {
                write!(formatter, "{id}: retryable: {message}")
            }
            CloudBackfillError::Permanent(id, message) => {
                write!(formatter, "{id}: permanent: {message}")
            }
            CloudBackfillError::Library(error) => write!(formatter, "library: {error}"),
        }
    }
}

fn classify_backfill_error(asset_id: String, error: &LibraryError) -> CloudBackfillError {
    let message = error.to_string();
    if is_retryable_cloud_error(error) {
        CloudBackfillError::Retryable(asset_id, message)
    } else {
        CloudBackfillError::Permanent(asset_id, message)
    }
}

fn prepared_metadata(
    prepared: &PreparedAssetUpload,
) -> super::models::ReplicationPrepareRequest<'_> {
    super::models::ReplicationPrepareRequest {
        asset_id: &prepared.queue.entity_id,
        kind: &prepared.kind,
        content_type: &prepared.content_type,
        size_bytes: prepared.size_bytes,
        sha256: &prepared.sha256,
    }
}

fn commit_payload_wire(payload: &BackfillCommitPayload) -> super::models::ReplicationCommitRequest {
    super::models::ReplicationCommitRequest {
        asset_id: payload.asset_id.clone(),
        kind: payload.kind.clone(),
        original: super::models::ReplicationVariantPayload {
            object_key: format!("library/{}/original", payload.asset_id),
            content_type: payload.content_type.clone(),
            size_bytes: payload.original_size_bytes,
            sha256: Some(payload.original_sha256.clone()),
        },
        thumbnail: super::models::ReplicationVariantPayload {
            object_key: format!("library/{}/thumbnail", payload.asset_id),
            content_type: "image/webp".into(),
            size_bytes: 1,
            sha256: None,
        },
        content_type: payload.content_type.clone(),
        collected_at: payload.collected_at.clone(),
        source_published_at: payload.source_published_at.clone(),
        source_url: payload.source_url.clone(),
        creator_name: payload.creator_name.clone(),
        creator_handle: payload.creator_handle.clone(),
        import_source: payload.import_source.clone(),
        classification_ids: payload.classification_ids.clone(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackfillCommitPayload {
    pub asset_id: String,
    pub kind: String,
    pub content_type: String,
    pub original_size_bytes: u64,
    pub original_sha256: String,
    pub collected_at: Option<String>,
    pub source_published_at: Option<String>,
    pub source_url: Option<String>,
    pub creator_name: Option<String>,
    pub creator_handle: Option<String>,
    pub import_source: Option<String>,
    pub classification_ids: Vec<String>,
}
