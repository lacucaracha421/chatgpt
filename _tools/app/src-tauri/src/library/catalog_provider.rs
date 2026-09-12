//! 온라인 카탈로그 provider-qualified 정체성 계약.
//!
//! 기존 VCK/kHentai 숫자 ID는 저장소 내부에서 그대로 유지하되, 공개 계약과 사용자
//! 상태는 항상 provider와 provider별 work ID를 함께 운반한다. Heliotrope는 현재
//! identity namespace만 예약하며 이 모듈이 네트워크 통합을 활성화하지는 않는다.

use serde::{Deserialize, Serialize};

use super::error::LibraryError;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum CatalogProvider {
    #[default]
    KHentai,
    Heliotrope,
}

impl CatalogProvider {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::KHentai => LEGACY_VCK_PROVIDER,
            Self::Heliotrope => HELIOTROPE_PROVIDER,
        }
    }

    pub(crate) fn from_tag(value: &str) -> Option<Self> {
        match value {
            LEGACY_VCK_PROVIDER => Some(Self::KHentai),
            HELIOTROPE_PROVIDER => Some(Self::Heliotrope),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWorkIdentity {
    #[serde(default)]
    pub provider: CatalogProvider,
    pub provider_work_id: String,
}

impl CatalogWorkIdentity {
    pub fn new(
        provider: CatalogProvider,
        provider_work_id: impl Into<String>,
    ) -> Result<Self, LibraryError> {
        let provider_work_id = provider_work_id.into();
        let provider_work_id = provider_work_id.trim();
        if provider_work_id.is_empty() {
            return Err(LibraryError::InvalidOnlineCatalog);
        }
        Ok(Self {
            provider,
            provider_work_id: provider_work_id.to_owned(),
        })
    }

    pub(crate) fn key(&self) -> String {
        format!("{}:{}", self.provider.as_str(), self.provider_work_id)
    }

    pub(crate) fn validate(&self) -> Result<(), LibraryError> {
        if self.provider_work_id.trim().is_empty() {
            return Err(LibraryError::InvalidOnlineCatalog);
        }
        Ok(())
    }

    pub(crate) fn khentai(work_id: u64) -> Self {
        Self {
            provider: CatalogProvider::KHentai,
            provider_work_id: work_id.to_string(),
        }
    }

    pub(crate) fn khentai_numeric_id(&self) -> Result<u64, LibraryError> {
        if self.provider != CatalogProvider::KHentai {
            return Err(LibraryError::UnsupportedCatalogProvider);
        }
        self.provider_work_id
            .parse::<u64>()
            .ok()
            .filter(|work_id| *work_id > 0)
            .ok_or(LibraryError::InvalidOnlineCatalog)
    }
}

pub(crate) const LEGACY_VCK_PROVIDER: &str = "kHentai";
pub(crate) const HELIOTROPE_PROVIDER: &str = "heliotrope";

const UNIX_SECONDS_CEILING: u64 = 100_000_000_000;

pub(crate) fn normalize_legacy_timestamp(value: i64) -> i64 {
    let mut normalized = value;
    while normalized.unsigned_abs() >= UNIX_SECONDS_CEILING {
        normalized /= 1_000;
    }
    normalized
}

pub(crate) fn normalize_optional_legacy_timestamp(value: Option<i64>) -> Option<i64> {
    value.map(normalize_legacy_timestamp)
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_legacy_timestamp, CatalogProvider, CatalogWorkIdentity,
        LEGACY_VCK_PROVIDER,
    };

    #[test]
    fn legacy_vck_provider_tag_is_stable() {
        // 이 문자열이 바뀌면 기존 VCK 북마크·읽기 위치 행과 갤러리 매니페스트가
        // 전부 끊긴다. Phase 1(2026-09) 기준으로 고정값이다.
        assert_eq!(LEGACY_VCK_PROVIDER, "kHentai");
    }

    #[test]
    fn normalizes_legacy_timestamp_units_to_unix_seconds() {
        assert_eq!(normalize_legacy_timestamp(1_700_000_000), 1_700_000_000);
        assert_eq!(normalize_legacy_timestamp(1_700_000_000_000), 1_700_000_000);
        assert_eq!(normalize_legacy_timestamp(1_700_000_000_000_000), 1_700_000_000);
    }

    #[test]
    fn catalog_identity_serializes_with_an_explicit_provider() {
        let identity = CatalogWorkIdentity::new(CatalogProvider::KHentai, "42").unwrap();

        assert_eq!(
            serde_json::to_value(identity).unwrap(),
            serde_json::json!({ "provider": "kHentai", "providerWorkId": "42" })
        );
    }

    #[test]
    fn legacy_identity_without_provider_defaults_to_khentai() {
        let identity: CatalogWorkIdentity = serde_json::from_value(serde_json::json!({
            "providerWorkId": "42"
        }))
        .unwrap();

        assert_eq!(identity.provider, CatalogProvider::KHentai);
        assert_eq!(identity.provider_work_id, "42");
    }

    #[test]
    fn identities_keep_the_same_work_id_isolated_by_provider() {
        let khentai = CatalogWorkIdentity::new(CatalogProvider::KHentai, "42").unwrap();
        let heliotrope = CatalogWorkIdentity::new(CatalogProvider::Heliotrope, "42").unwrap();

        assert_ne!(khentai, heliotrope);
        assert_ne!(khentai.key(), heliotrope.key());
    }

    #[test]
    fn identity_rejects_unknown_providers_and_empty_work_ids() {
        assert!(serde_json::from_value::<CatalogWorkIdentity>(serde_json::json!({
            "provider": "unknown",
            "providerWorkId": "42"
        }))
        .is_err());
        assert!(CatalogWorkIdentity::new(CatalogProvider::KHentai, "  ").is_err());
        assert!(serde_json::from_value::<CatalogWorkIdentity>(serde_json::json!({
            "provider": "kHentai",
            "providerWorkId": "  "
        }))
        .unwrap()
        .validate()
        .is_err());
    }
}
