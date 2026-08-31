//! 온라인 카탈로그 provider 정체성 상수.
//!
//! Phase 1(CATALOG-001 VPS transport)에서 카탈로그 정체성은 legacy VCK/kHentai로
//! 고정이다. provider 문자열은 북마크·읽기 위치·갤러리 매니페스트 행에 기록되는
//! 네임스페이스이며, Heliotrope 같은 두 번째 provider가 실제 도입될 때만 데이터
//! 베이스 영역으로 확장한다. 그 전까지는 컴파일 타임 상수만 둔다. 전환에 대한
//! 연구·HTTP client(`heliotrope.rs`)는 그 모듈의 문서를 참고한다.

pub(crate) const LEGACY_VCK_PROVIDER: &str = "kHentai";

/// Phase 2 전용. heliotrope.rs 문서 참고. 현재 어떤 데이터 행에도 기록되지 않는다.
#[cfg(test)]
pub(crate) const HELIOTROPE_PROVIDER: &str = "heliotrope";



#[cfg(test)]
mod tests {
    use super::LEGACY_VCK_PROVIDER;

    #[test]
    fn legacy_vck_provider_tag_is_stable() {
        // 이 문자열이 바뀌면 기존 VCK 북마크·읽기 위치 행과 갤러리 매니페스트가
        // 전부 끊긴다. Phase 1(2026-09) 기준으로 고정값이다.
        assert_eq!(LEGACY_VCK_PROVIDER, "kHentai");
    }
}