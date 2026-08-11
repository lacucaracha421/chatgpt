# 안전한 복잡성 축소 설계

## 목표

프로젝트의 외부 동작과 데이터 안전성을 유지하면서, 사용되지 않는 API·필드·호환 코드와 반복 구현을 삭제한다.

## 적용 원칙

- 호출자가 없는 코드와 읽히지 않는 응답 데이터만 삭제한다.
- 기존 플랫폼·공용 유틸리티가 제공하는 동작은 재구현하지 않는다.
- 데이터 손실 방지, 경로 검증, 복구, 동시성 제어 코드는 단순화 대상에서 제외한다.
- 프런트엔드와 Rust 백엔드 변경을 분리해 검증하고 커밋한다.
- 새 의존성은 추가하지 않는다.

## 프런트엔드 변경

- ADR-0026에 맞춰 단일 사용 Tooltip 컴포넌트, 테스트, 스타일, Radix Tooltip 의존성을 제거하고 `aria-label` 버튼만 유지한다.
- 사용되지 않는 `AssetGallery` props와 `useFileDrop`의 이전 호환 콜백·결과 타입을 제거한다.
- 사용되지 않는 Tauri gateway 메서드를 제거하고 대응하는 테스트 fixture 타입을 축소한다.
- 파일 드롭 좌표는 실제로 좌표를 표시하지 않으므로 boolean over 상태로 축소한다.
- 분류 트리의 orphan 객체 배열은 UI가 존재 여부만 사용하므로 boolean으로 축소한다.
- 중복된 auto-dismiss effect는 기존 공용 hook을 재사용한다. 날짜·용량 포매터는 출력과 fallback이 동일한 호출자만 공용 유틸리티를 재사용한다.
- 사용되지 않는 Dialog `closeDisabled` 옵션과 이전 네이티브 dialog 테스트 shim을 제거한다.
- 저장소 소스와 CSS 문자열을 직접 검사하는 change-detector 테스트를 제거하고 DOM 동작 테스트만 유지한다.
- 반복되는 gateway·drop hook 테스트 설정은 파일 내부 fixture 함수로 통합한다.
- 한 호출자만 가진 얕은 레이아웃·drag bridge 래퍼는 삭제가 실제 코드 감소로 이어지는 경우에만 인라인한다.

## Rust 백엔드 변경

- 프런트엔드가 사용하지 않는 `current_library`, 단일 자산 trash/classification 명령과 내부 래퍼를 제거하고 배치 명령만 유지한다.
- 유사도 결정 명령의 사용되지 않는 outcome/status/next-review 응답을 제거하고 `Result<(), _>`로 축소한다.
- 유사도 인덱싱 응답에서 사용되지 않는 `processed` 필드를 제거한다.
- 영상 probe의 사용되지 않는 frame-rate 파싱과 필드를 제거한다.
- 항상 무시되는 영상 재시도 반환값을 `Result<(), _>`로 축소한다.
- `MangaSeries` 전송 모델은 화면이 사용하는 `id`, `title`, `author`, `page_count`만 직렬화한다. DB 내부 경로와 시간 필드는 유지한다.
- `LibrarySummary.asset_count`와 생성되지 않는 manga 오류 variant를 제거한다.
- manga scan의 사용되지 않는 매개변수와 동일 행 재조회만 제거한다.
- SHA-256 문자열 변환은 Rust 포매팅을 사용하고 단일 사용 `hex` 의존성을 제거한다.
- 동일한 미디어 파일 열기 절차는 기존 helper를 일반화하는 변경이 명확히 더 짧을 때만 통합한다.

## 명시적으로 유지하는 코드

- ingestion의 파일 identity 검증, 격리 cleanup, 생성 파일 rollback
- backup restore의 단계별 rollback과 실패 주입 테스트 훅
- Windows handle 기반 안전 삭제와 경로 canonicalization
- similarity review의 resolving 상태와 재시작 복구
- video preparation의 서버 측 직렬화와 중단 복구
- cursor pagination SQL과 상태 검증
- Library의 도메인별 mutation lock

## 데이터 흐름과 호환성

프런트엔드는 제거 대상 필드를 읽지 않으므로 화면 동작은 바뀌지 않는다. Tauri 명령은 현재 프로덕션 호출자가 있는 계약만 유지한다. SQLite 스키마와 기존 라이브러리 파일은 변경하지 않으며, DB 내부 필드는 전송 모델에서 제외되더라도 그대로 보존한다.

## 오류 처리

기존 사용자 노출 오류와 복구 동작은 유지한다. 제거되는 오류 variant는 코드 어디에서도 생성되지 않는 것만 대상으로 한다. 비동기 작업의 취소·중복 방지 로직은 이번 변경에서 재설계하지 않는다.

## 테스트와 완료 조건

- 각 삭제 전에 참조 검색으로 프로덕션 호출자가 없음을 확인한다.
- 계약 축소는 기존 테스트를 먼저 새 계약으로 변경해 실패를 확인한 뒤 구현한다.
- 순수 dead code와 테스트 중복 제거는 관련 테스트 묶음으로 회귀를 확인한다.
- 프런트엔드: `npm test`, `npm run build`
- Rust: `cargo test`, `cargo clippy --all-targets -- -D warnings`
- 기존 사용자 변경 파일은 수정하거나 커밋하지 않는다.

## 커밋 구성

1. 설계 문서
2. 프런트엔드 dead code·중복 제거
3. Rust API·모델 축소
4. 필요하면 테스트 fixture 정리를 별도 커밋
