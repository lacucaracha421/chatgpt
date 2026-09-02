//! CLOUD-006 배치 1: 전체 라이브러리 백필 전 읽기 전용 사전 점검.
//!
//! 백필 후보 자산마다 원본 파일, 썸네일, 분류 관계, 프로비넌스를 검사하고
//! 구조화된 리페어 리포트를 만든다. 어떤 함수도 라이브러리 데이터를
//! 변경하지 않는다. 개별 자산의 문제는 해당 자산의 문제 항목으로 기록될
use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::library::{error::LibraryError, Library};

/// 하나의 백필 후보 자산에 대한 사전 점검 결과.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightAssetReport {
    pub asset_id: String,
    pub media_kind: String,
    /// 원본 파일이 라이브러리 루트 안에 존재하고 열리는지.
    pub original_exists: bool,
    pub original_size_bytes: Option<u64>,
    pub content_type: Option<String>,
    /// 썸네일 경로가 DB에 기록되어 있고 실제 파일로 열리는지.
    /// video는 포스터가 준비되기 전까지 없을 수 있다(정상 상태).
    pub thumbnail_available: bool,
    /// 썸네일이 없어도 자체 생성이 가능한지(이미지·GIF는 가능, 비디오는
    /// 준비 완료된 포스터가 필요).
    pub thumbnail_generatable: bool,
    /// 문제 없이 바로 백필할 수 있는지.
    pub ready: bool,
    /// 이미 서버에 커밋된 복제본이 있는지(cloud_sync_queue synced 상태).
    pub already_replicated: bool,
    /// 로컬 원본이 사라졌거나 기록된 크기와 어긋나는지.
    pub original_missing_or_changed: bool,
    /// 감지된 문제 목록(사람이 읽을 수 있는 한국어 설명).
    pub problems: Vec<String>,
    pub classification_ids: Vec<String>,
    pub collected_at: Option<String>,
    pub source_published_at: Option<String>,
    pub source_url: Option<String>,
    pub creator_name: Option<String>,
    pub creator_handle: Option<String>,
    pub import_source: Option<String>,
    /// DB에 기록된 원본 크기(원본 검사와 비교용).
    pub recorded_size_bytes: u64,
    pub relative_path: String,
    pub thumbnail_relative_path: Option<String>,
}

/// 전체 라이브러리 사전 점검 요약.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub total_assets: u64,
    pub ready_assets: u64,
    pub already_replicated: u64,
    pub missing_originals: u64,
    pub thumbnail_work_required: u64,
    pub problem_assets: u64,
    pub assets: Vec<PreflightAssetReport>,
}

/// 운영 staged rollout에서 사용할 혼합 표본을 결정한다. 실제 큐 변경은
/// 별도의 bounded seed가 맡으며, 이 함수는 preflight 결과만 읽는다.
pub fn select_mixed_rollout_asset_ids(
    report: &PreflightReport,
    limit: usize,
) -> Result<Vec<String>, String> {
    if !(1..=500).contains(&limit) {
        return Err("rollout size must be between 1 and 500".into());
    }
    let mut candidates: Vec<&PreflightAssetReport> = report
        .assets
        .iter()
        .filter(|asset| asset.ready && !asset.already_replicated)
        .collect();
    candidates.sort_by(|left, right| {
        right
            .collected_at
            .cmp(&left.collected_at)
            .then_with(|| left.asset_id.cmp(&right.asset_id))
    });
    if candidates.len() < limit {
        return Err(format!(
            "only {} ready, not-yet-replicated assets are available",
            candidates.len()
        ));
    }

    let mut selected: Vec<String> = Vec::with_capacity(limit);
    let add = |asset: &PreflightAssetReport, selected: &mut Vec<String>| {
        if selected.len() < limit && !selected.contains(&asset.asset_id) {
            selected.push(asset.asset_id.clone());
        }
    };

    // 대표성 기준: 최신 이미지, 최신 비디오, 가장 오래된 자산을 우선한다.
    if let Some(asset) = candidates.iter().find(|asset| asset.media_kind != "video") {
        add(asset, &mut selected);
    }
    if let Some(asset) = candidates.iter().find(|asset| asset.media_kind == "video") {
        add(asset, &mut selected);
    }
    if let Some(asset) = candidates.last() {
        add(asset, &mut selected);
    }

    // 아직 선택되지 않은 분류를 가진 자산을 우선해 표본 편향을 줄인다.
    let mut seen_classifications = std::collections::BTreeSet::new();
    for asset in &candidates {
        if selected.contains(&asset.asset_id) {
            seen_classifications.extend(asset.classification_ids.iter().cloned());
        }
    }
    for asset in &candidates {
        if asset
            .classification_ids
            .iter()
            .any(|id| !seen_classifications.contains(id))
        {
            add(asset, &mut selected);
            seen_classifications.extend(asset.classification_ids.iter().cloned());
        }
    }

    // 남은 자리는 최신/오래된 순서를 번갈아 채운다.
    for index in 0..candidates.len() {
        add(candidates[index], &mut selected);
        add(candidates[candidates.len() - 1 - index], &mut selected);
    }
    selected.truncate(limit);
    Ok(selected)
}

/// 하나의 분류에 속하는 ready, 미복제 자산 전체를 고른다. Batch 6의
/// 허용 범위(100..=500)를 벗어나면 큐를 바꾸기 전에 거부한다.
pub fn select_classification_rollout_asset_ids(
    report: &PreflightReport,
    classification_id: &str,
) -> Result<Vec<String>, String> {
    let mut selected: Vec<&PreflightAssetReport> = report
        .assets
        .iter()
        .filter(|asset| {
            asset.ready
                && !asset.already_replicated
                && asset
                    .classification_ids
                    .iter()
                    .any(|id| id == classification_id)
        })
        .collect();
    selected.sort_by(|left, right| {
        right
            .collected_at
            .cmp(&left.collected_at)
            .then_with(|| left.asset_id.cmp(&right.asset_id))
    });
    if !(100..=500).contains(&selected.len()) {
        return Err(format!(
            "classification has {} ready, not-yet-replicated assets; expected 100..=500",
            selected.len()
        ));
    }
    Ok(selected
        .into_iter()
        .map(|asset| asset.asset_id.clone())
        .collect())
}

impl Library {
    /// 사전 점검 중 하나의 자산. 파일 시스템 오류가 나면 그 자산만 문제로
    /// 기록한다. 자산 행이 없으면 AssetNotFound로 답한다.
    pub fn preflight_asset(&self, asset_id: &str) -> Result<PreflightAssetReport, LibraryError> {
        // 행 조회와 파일 검사(helper들이 self.connection()을 다시 잠금) 사이에
        // 락을 반드시 해제한다. database_lock은 재진입 불가이므로 row 조회를
        // 별도 스코프로 격리한다.
        let row = {
            let connection = self.connection()?;
            connection
                .query_row(
                    "SELECT id, media_kind, relative_path, thumbnail_relative_path,
                            byte_size, collected_at, source_published_at,
                            source_url, creator_name, creator_handle, import_source
                     FROM assets WHERE id = ?1",
                    [asset_id],
                    |row| {
                        Ok(PreflightAssetReport {
                            asset_id: row.get(0)?,
                            media_kind: row.get(1)?,
                            relative_path: row.get(2)?,
                            thumbnail_relative_path: row.get(3)?,
                            recorded_size_bytes: row.get::<_, i64>(4)?.max(0) as u64,
                            original_exists: false,
                            original_size_bytes: None,
                            content_type: None,
                            thumbnail_available: false,
                            thumbnail_generatable: false,
                            ready: false,
                            already_replicated: false,
                            original_missing_or_changed: false,
                            problems: Vec::new(),
                            classification_ids: Vec::new(),
                            collected_at: row.get(5)?,
                            source_published_at: row.get(6)?,
                            source_url: row.get(7)?,
                            creator_name: row.get(8)?,
                            creator_handle: row.get(9)?,
                            import_source: row.get(10)?,
                        })
                    },
                )
                .optional()?
                .ok_or(LibraryError::AssetNotFound)?
        };
        let mut report = self.inspect_files(row);
        report.classification_ids = self.classification_ids_of(&report.asset_id)?;
        Ok(report)
    }

    /// 전체 라이브러리를 읽기 전용으로 사전 점검한다. 개별 자산의 어떤
    /// 문제도 이 함수를 실패시키지 않는다(그 자산의 problems에 기록).
    pub fn preflight_full_library(&self) -> Result<PreflightReport, LibraryError> {
        // 주의: preflight_asset이 내부에서 self.connection()을 다시 잠그므로
        // 여기서 잠근 connection을 루프 동안 들고 있으면 교착한다. ID 목록만
        // 먼저 읽고 락을 즉시 해제한다(database_lock은 재진입 불가).
        let asset_ids: Vec<String> = {
            let connection = self.connection()?;
            let mut statement = connection.prepare(
                "SELECT id FROM assets WHERE status = 'normal'
                 ORDER BY collected_at DESC, id",
            )?;
            let rows = statement
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<String>, rusqlite::Error>>()?;
            rows
        };
        let mut assets = Vec::with_capacity(asset_ids.len());
        let mut counters = PreflightSummaryCounters::default();
        for asset_id in asset_ids {
            let report = match self.preflight_asset(&asset_id) {
                Ok(report) => report,
                // 점검 중 사라진 자산(경합)은 그 자산만 건너뛴다.
                Err(LibraryError::AssetNotFound) => continue,
                Err(error) => return Err(error),
            };
            counters.record(&report);
            assets.push(report);
        }

        Ok(PreflightReport {
            total_assets: counters.total,
            ready_assets: counters.ready,
            already_replicated: counters.replicated,
            missing_originals: counters.missing_originals,
            thumbnail_work_required: counters.thumbnail_work,
            problem_assets: counters.problems,
            assets,
        })
    }

    fn inspect_files(&self, mut report: PreflightAssetReport) -> PreflightAssetReport {
        // 원본 검사: 경로 검증(라이브러리 루트 탈출 차단) + 크기 비교.
        match self.open_library_media(&report.relative_path) {
            Ok(media) => {
                report.original_exists = true;
                report.original_size_bytes = Some(media.length);
                report.content_type = Some(media.mime.to_owned());
                if report.original_size_bytes != Some(report.recorded_size_bytes) {
                    report.original_missing_or_changed = true;
                    report
                        .problems
                        .push("원본 파일 크기가 기록과 다릅니다.".into());
                }
            }
            Err(error) => {
                report.original_missing_or_changed = true;
                report
                    .problems
                    .push(format!("원본 파일을 열 수 없습니다: {error}"));
            }
        }

        match report.thumbnail_relative_path.as_deref() {
            Some(path) => {
                if self.open_library_media(path).is_ok() {
                    report.thumbnail_available = true;
                } else {
                    report
                        .problems
                        .push("썸네일이 기록되어 있지만 열 수 없습니다.".into());
                }
            }
            None => {
                if report.media_kind == "video" {
                    report
                        .problems
                        .push("비디오 포스터가 아직 준비되지 않았습니다.".into());
                }
            }
        }
        // 이미지·GIF는 썸네일 경로가 DB에 없어도 백필 워커가 재생성할 수 있다.
        // 비디오는 준비 완료된 포스터가 존재해야만 썸네일을 만들 수 있다.
        report.thumbnail_generatable = if report.media_kind == "video" {
            self.video_poster_path(&report.asset_id).is_some()
        } else {
            true
        };

        report.already_replicated = self.asset_is_replicated(&report.asset_id);

        if !report.original_missing_or_changed
            && report.thumbnail_available
            && !report.already_replicated
        {
            report.ready = true;
        }
        report
    }

    fn classification_ids_of(&self, asset_id: &str) -> Result<Vec<String>, LibraryError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT classification_id FROM asset_classifications
             WHERE asset_id = ?1 ORDER BY classification_id",
        )?;
        let ids = statement
            .query_map([asset_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }
    fn asset_is_replicated(&self, asset_id: &str) -> bool {
        let Ok(connection) = self.connection() else {
            return false;
        };
        connection
            .query_row(
                "SELECT EXISTS (
                    SELECT 1 FROM cloud_sync_queue
                    WHERE entity_type = 'asset' AND entity_id = ?1
                      AND operation = 'upsert' AND status = 'synced'
                )",
                [asset_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|exists| exists != 0)
            .unwrap_or(false)
    }

    fn video_poster_path(&self, asset_id: &str) -> Option<String> {
        let connection = self.connection().ok()?;
        connection
            .query_row(
                "SELECT poster_relative_path FROM video_assets WHERE asset_id = ?1",
                [asset_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .ok()
            .flatten()
            .flatten()
    }
}

#[derive(Default)]
struct PreflightSummaryCounters {
    total: u64,
    ready: u64,
    replicated: u64,
    missing_originals: u64,
    thumbnail_work: u64,
    problems: u64,
}

#[cfg(test)]
mod rollout_selection_tests {
    use super::{
        select_classification_rollout_asset_ids, select_mixed_rollout_asset_ids,
        PreflightAssetReport, PreflightReport,
    };

    fn asset(id: &str, kind: &str, date: &str, classifications: &[&str]) -> PreflightAssetReport {
        PreflightAssetReport {
            asset_id: id.into(),
            media_kind: kind.into(),
            original_exists: true,
            original_size_bytes: Some(10),
            content_type: Some("image/png".into()),
            thumbnail_available: true,
            thumbnail_generatable: true,
            ready: true,
            already_replicated: false,
            original_missing_or_changed: false,
            problems: Vec::new(),
            classification_ids: classifications
                .iter()
                .map(|value| (*value).into())
                .collect(),
            collected_at: Some(date.into()),
            source_published_at: None,
            source_url: None,
            creator_name: None,
            creator_handle: None,
            import_source: None,
            recorded_size_bytes: 10,
            relative_path: format!("media/{id}.png"),
            thumbnail_relative_path: Some(format!("thumbs/{id}.png")),
        }
    }

    fn report(assets: Vec<PreflightAssetReport>) -> PreflightReport {
        PreflightReport {
            total_assets: assets.len() as u64,
            ready_assets: assets.len() as u64,
            already_replicated: 0,
            missing_originals: 0,
            thumbnail_work_required: 0,
            problem_assets: 0,
            assets,
        }
    }

    #[test]
    fn mixed_rollout_selection_includes_video_recent_old_and_classification_variety() {
        let selection = select_mixed_rollout_asset_ids(
            &report(vec![
                asset("new-image", "image", "2026-09-04T00:00:00Z", &["a"]),
                asset("new-video", "video", "2026-09-03T00:00:00Z", &["b"]),
                asset("middle", "image", "2026-09-02T00:00:00Z", &["c"]),
                asset("old-image", "image", "2020-01-01T00:00:00Z", &["d"]),
            ]),
            4,
        )
        .unwrap();

        assert_eq!(selection.len(), 4);
        assert!(selection.contains(&"new-video".to_owned()));
        assert!(selection.contains(&"new-image".to_owned()));
        assert!(selection.contains(&"old-image".to_owned()));
    }

    #[test]
    fn classification_rollout_selection_enforces_the_staged_size_boundary() {
        let assets = (0..99)
            .map(|index| {
                asset(
                    &format!("asset-{index}"),
                    "image",
                    "2026-01-01T00:00:00Z",
                    &["class-a"],
                )
            })
            .collect();
        assert!(select_classification_rollout_asset_ids(&report(assets), "class-a").is_err());
    }
}

impl PreflightSummaryCounters {
    fn record(&mut self, report: &PreflightAssetReport) {
        self.total += 1;
        if report.ready {
            self.ready += 1;
        }
        if report.already_replicated {
            self.replicated += 1;
        }
        if report.original_missing_or_changed {
            self.missing_originals += 1;
        }
        if !report.thumbnail_available && report.thumbnail_generatable {
            self.thumbnail_work += 1;
        }
        if !report.problems.is_empty() {
            self.problems += 1;
        }
    }
}
