# Collection 유형 탐색과 레거시 gacha 제외 설계

날짜: 2026-08-24

상태: 사용자 확인 완료

## 목적

Collection의 혼합 `전체` 보기를 제거하고 게임·만화·영화를 유형별로만 탐색한다. 구버전 `info.txt`에서 `Type=gacha`였던 항목은 삭제하지 않고 일반 Collection 목록, 쇼케이스와 검색에서 숨긴다.

이 설계는 `docs/agents/lakomics-works-handoff-v2.md`의 최신 Works/Collection 결정을 따른다. 혼합 전체 보기와 혼합 쇼케이스를 설명하는 2026-08-16 Collection 설계의 구형 결정은 이 범위에서 대체한다.

## 범위

포함하는 변경은 다음과 같다.

- 레거시 원본 `Type`을 `legacy_kind`로 보존한다.
- 기존 레거시 Collection의 `legacy_kind`를 가능한 범위에서 복구한다.
- `legacy_kind = gacha`인 Collection을 비파괴적으로 숨긴다.
- Collection 보기에서 nullable 유형과 `전체` 경로를 제거한다.
- 마지막으로 본 유형을 복원하고, 유효한 기록이 없으면 만화를 연다.
- Collection 상세 화면을 닫을 때 해당 Collection의 유형으로 돌아간다.

다음은 포함하지 않는다.

- gacha 레코드나 연결된 자산의 삭제
- gacha를 네 번째 Collection 유형으로 추가하는 작업
- 일반 게임을 게임과 게임 캐릭터로 자동 재분류하는 작업
- Collection 카드나 상세 화면의 시각 개편
- 상단바 안정화와 온라인 카탈로그 전환
- 이미 보존형 UPDATE와 회귀 테스트가 존재하는 일반 Collection 편집 로직의 재작성

## 검토한 접근

### 채택: 별도 레거시 출처 보존

`collections.legacy_kind`에 정규화한 구버전 `Type`을 저장한다. `gacha`는 제품의 Collection 유형이 아니라 레거시 가져오기 출처로만 취급한다. 조회 Module에서 이 값을 기준으로 숨기므로 화면마다 판별 규칙을 반복하지 않는다.

이 접근은 정상 게임을 보존하고, 원본 분류를 잃지 않으며, 숨김 정책을 나중에 되돌릴 수도 있다.

### 기각: UI에서 제목이나 경로로 추측

이름과 폴더 경로는 안정적인 식별자가 아니다. 정상 게임을 잘못 숨길 수 있고 목록, 쇼케이스와 검색에서 같은 규칙을 반복해야 한다.

### 기각: gacha를 네 번째 Collection 유형으로 승격

사용자에게 노출하지 않을 종류가 타입 분기와 UI 전체에 퍼진다. 게임·만화·영화라는 현재 도메인 모델을 불필요하게 넓힌다.

## 도메인 모델

Collection 유형은 계속 `game | manga | movie` 세 가지뿐이다. `legacy_kind`는 구버전 `info.txt`의 원본 `Type`을 나타내는 nullable 출처 정보다. 인식하는 값은 `game`, `manga`, `movie`, `gacha`이며 알 수 없거나 원본을 확인할 수 없으면 `NULL`이다.

`legacy_kind`가 `gacha`여도 현재 Collection 유형은 `game`으로 유지한다. 따라서 기존 상세 정보, 외부 연결, 자산 관계와 표지는 변경하지 않는다.

## 저장과 출처 보강

SQLite 스키마 버전을 올리고 `collections`에 nullable `legacy_kind` 컬럼을 추가한다. 새 레거시 가져오기는 `info.txt`를 파싱할 때 정규화한 원본 `Type`을 Collection 유형과 함께 기록한다.

기존 행은 스키마 마이그레이션 이후 라이브러리를 열 때 멱등적으로 보강한다. 대상은 `source_path`가 있고 `legacy_kind`가 비어 있는 행뿐이다. 기존 레거시 가져오기 parser와 안전한 Collection source 경로 해석을 재사용해 `<library root>/<source_path>/info.txt`의 `Type`을 읽는다. 이미 값이 있는 행은 다시 읽지 않는다.

원본 폴더나 `info.txt`가 없거나, 경로가 라이브러리 루트 밖을 가리키거나, 파일을 읽을 수 없거나, `Type`이 인식되지 않으면 해당 행을 `NULL`로 남긴다. 앱 시작과 Collection 탐색은 계속 진행하며 판별할 수 없는 항목은 숨기지 않는다. 추측보다 자료 보존을 우선한다.

## 조회 Module

Collection 목록을 제공하는 Rust Module이 기본적으로 `legacy_kind = gacha`인 행을 제외한다. 일반 목록, 쇼케이스와 현재 Collection 검색은 이 목록 결과를 사용하므로 동일한 숨김 규칙을 얻는다.

단일 Collection 조회와 데이터 자체는 유지한다. 기존 화면 상태나 내부 참조가 숨겨진 Collection ID를 잠시 가지고 있어도 오류나 삭제로 바꾸지 않는다. 사용자가 일반 탐색을 다시 시작하면 숨겨진 항목은 목록에 나타나지 않는다.

별도의 “숨긴 gacha 보기” 설정이나 복구 UI는 이번 범위에 추가하지 않는다. 데이터가 보존되므로 향후 실제 요구가 확인되면 조회 옵션을 추가할 수 있다.

## 탐색 상태

`AssetView`의 Collection 목록 상태는 항상 구체적인 `CollectionType`을 가진다. `typeFilter: null`과 이를 의미하는 `전체` 버튼, 제목과 테스트 fixture를 제거한다.

유형 선택 시 `lakomics.collection.lastType` 로컬 UI 설정에 값을 기록한다. Collection 빠른 보기를 열 때 저장된 값이 `game`, `manga`, `movie` 중 하나면 복원하고, 값이 없거나 손상됐으면 `manga`를 사용한다. 이 설정은 라이브러리 데이터가 아니며 앱 설치 단위로 공유한다.

Collection 상세 화면을 닫을 때 조회한 Collection의 유형으로 돌아간다. Collection을 찾을 수 없어 유형을 알 수 없는 경우에는 유효한 마지막 유형을 사용하고, 그것도 없으면 `manga`를 사용한다. 일반 Collection과 쇼케이스는 같은 유형을 유지한 채 전환한다.

## Module과 seam

레거시 `info.txt` 해석은 기존 book migration 구현이 소유한다. 출처 보강이 별도의 parser를 만들지 않고 이 Module의 작은 내부 interface를 재사용하므로 원본 `Type` 해석 규칙이 한곳에 머문다.

Collection 조회의 외부 interface는 현재처럼 숨김 정책이 적용된 사용자용 목록을 반환한다. 호출자가 `legacy_kind`와 필터 조건을 배울 필요가 없게 해 Module의 깊이와 조회 규칙의 locality를 유지한다.

프론트엔드의 유형 복원은 작은 순수 helper로 유효성 검사와 fallback을 감춘다. 사이드바 진입, 상세 종료와 테스트는 모두 이 helper가 반환하는 구체적인 유형만 사용한다.

## 오류와 안전 규칙

- 출처 보강 실패는 앱 시작 실패로 승격하지 않는다.
- 불확실한 항목은 계속 표시한다.
- gacha Collection과 연결된 자산, 표지, 외부 연결, 권 정보는 삭제하거나 변경하지 않는다.
- 숨김 필터는 문자열 추측이나 사용자 편집 필드에 의존하지 않는다.
- 기존 `legacy_kind`는 자동 보강이 덮어쓰지 않는다.
- 저장된 마지막 유형은 허용 목록으로 검증하고 잘못된 값은 `manga`로 교정한다.

## 검증

Rust의 가장 가까운 테스트에서 다음을 검증한다.

- 스키마 업그레이드가 기존 Collection을 보존하며 `legacy_kind`를 추가한다.
- `Type=gacha` 원본은 `legacy_kind = gacha`, Collection 유형은 `game`으로 기록된다.
- `Type=game` 원본은 정상 게임으로 남는다.
- 기존 source에서 gacha를 복구한 뒤 사용자용 목록에서 제외된다.
- source 또는 `info.txt`가 없으면 행을 보존하고 목록에도 계속 표시한다.
- 보강을 반복해도 기존 값과 결과가 바뀌지 않는다.

React의 가장 가까운 테스트에서 다음을 검증한다.

- 유형 세그먼트에 `전체`가 없고 게임·만화·영화만 존재한다.
- Collection 목록 view가 nullable 유형을 받지 않는다.
- 유효한 마지막 유형을 복원한다.
- 누락되거나 손상된 마지막 유형은 만화로 복구한다.
- 상세 화면 종료가 현재 Collection 유형으로 돌아간다.
- 쇼케이스 전환이 현재 유형을 유지한다.

반복 중에는 변경 영역의 관련 테스트 파일 하나를 실행한다. 스키마와 Rust/React 탐색 모델을 함께 바꾸므로 마지막에는 해당 Rust Collection·book migration 테스트와 관련 React 테스트를 각각 실행한다. 더 넓은 검증은 이 표적 검사에서 교차 Module 회귀가 발견될 때만 확장한다.

## 구현 순서

1. `legacy_kind` 스키마와 기존 행 보강을 추가한다.
2. 레거시 가져오기가 원본 종류를 보존하도록 한다.
3. 사용자용 Collection 목록 조회에서 gacha를 제외한다.
4. Collection view를 구체적인 유형으로 제한하고 `전체` UI를 제거한다.
5. 마지막 유형 복원과 상세 종료 규칙을 연결한다.
6. 표적 검증을 통과시킨 뒤 의미 단위로 커밋한다.

이 작업이 끝난 뒤 상단바 안정화를 별도 설계·계획·구현하고, 마지막으로 원격 카탈로그 전환을 별도 작업으로 진행한다.
