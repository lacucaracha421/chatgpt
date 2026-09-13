# 서버 원본 전환 — PC·서버·모바일 데이터 대응 조사

후속 구현: 같은 날짜의 [캐릭터 읽기 계약](../agents/mobile-character-contract.md)에 시리즈·그룹·캐릭터·일반 폴더 발행/API/모바일 탐색이 추가되었다. 아래 대응표는 구현 전 조사 기록이다. 최신 상태는 CLOUD-AUTH-001과 현재 소스가 소유한다.

조사일: 2026-09-13. 기준 checkout: `/home/laku/chatgpt`, `main`, HEAD `dd2baa2c6638005afd77f89b2c4c44758a78378e`와 조사 시점의 미커밋·미추적 관련 소스.

사용자 요청은 서버를 데이터의 원천으로 만들고, 최근 PC의 캐릭터 폴더 등 변경을 반영해 모바일을 PC 없이 사용할 수 있게 하는 것이다. 이 문서는 현재 구현의 대응 관계와 설계 입력을 기록한다. 실행 상태와 순서는 [CLOUD-AUTH-001](../roadmap/lakomics-backlog.md#cloud-auth-001--서버-원본과-최신-pc-모델을-공유하는-모바일)이 소유한다.

이 조사는 소스·스키마·API·화면 계약 대조다. 운영 서버, 활성 라이브러리, 설치 APK를 확인한 결과가 아니다. 진행 중인 캐릭터 갱신과 컬렉션 일일 갱신(v73)도 읽었지만, 그 작업의 구현·테스트·운영 적용을 이 문서의 성과로 간주하지 않는다. 특히 v73 파일이 존재한다는 사실은 실제 라이브러리의 스키마 버전을 뜻하지 않는다.

조사 도중 컬렉션 provider 재시도 처리와 소장 패널/신간 구독 배치가 추가 변경되어 관련 현재 소스를 다시 대조했다. 소장 입력 옆의 구독 선택도 모바일 설계 입력으로 포함한다. 미커밋 작업이 계속되는 상태이므로 이 문서는 구현 착수 시 해당 영역을 다시 확인할 기준이며, 동결된 전체 코드 명세는 아니다.

## 1. 결론과 범위

현재 모바일은 이미 서버를 직접 사용하는 Android 앱이다. PC 의존성은 주로 서버에 제공되는 데이터 범위와 변경 확정·작업 실행 주체에 남아 있다. 기존 Tauri/React/Rust PC, Android/공유 React 모바일, Python API, R2 경계를 출발점으로 사용한다. DB 제품이나 호스팅을 바꾸는 결정은 이 조사에 포함하지 않는다.

필요한 전환은 다음 세 가지다.

- **모델 일치:** 일반 분류 트리 외에 시리즈·캐릭터·표시 그룹·판단·소장·출간 변경을 서버 계약에 포함한다.
- **데이터 권한 전환:** PC의 전체 발행이 최종 상태를 정하던 영역을 서버 변경 API와 양쪽 클라이언트의 증분 수신으로 바꾼다.
- **실행 독립:** 수집 확정·필수 미디어 처리·카탈로그 갱신·신간 확인·자동 캐릭터 처리가 PC 실행 여부에 묶이지 않게 한다.

기존 [ADR-0033](../adr/0033-local-authority-with-optional-cloud-sync.md)은 현재 구현의 PC 원본 계약이다. 사용자가 요청한 목표는 이를 대체하는 방향이며, 실제 쓰기 전환 전에 후속 ADR로 영역별 전환·오프라인·복구 계약을 명시해야 한다. 이 조사만으로 기존 API를 서버 원본으로 간주하지 않는다.

## 2. 기능·데이터 대응표

`미대응`은 아래 확인한 소스의 정상 API/앱 기능에 해당 계약이 없다는 뜻이다. PC SQLite 백업이 서버에 보관되는 것과 서버가 그 데이터를 조회·갱신하는 것은 구분한다.

| 영역 | 현재 PC | 현재 서버 | 현재 모바일 | 목표 / 필요한 차이 |
|---|---|---|---|---|
| 자산·출처·미디어 | 로컬 수집 확정, hash/파일 소유, 복제 큐 | assets·분류 관계·R2 미디어 및 ticket, PC 복제 prepare/commit | 최근·분류·날짜·작가 탐색, 이미지/영상 감상 | 서버가 등록·상태를 확정. PC 원본 경로는 기기별 보관 위치로 분리 |
| 일반 분류 | 계층·단일 직접 소속·외형, 역할에 따른 제약 | PC classification snapshot과 복제 관계 조회 | 일반 분류 트리와 자산 개수 | 안정적인 ID·직접 소속·조상 조회·역할을 구별. `originals` 역할을 이름으로 추측하지 않음 |
| 시리즈 | classification에 등록 설정, hero·자동 분류 설정, 일반 자식 폴더 카드 | 시리즈 전용 정상 조회/쓰기 미대응 | 시리즈 전용 탐색 미대응 | 등록 시리즈·일반 폴더·연결 캐릭터의 중복 없는 탐색 응답 |
| 캐릭터 | 별도 target ID, 설명·대표·수동형, 참조·판단과 연결 폴더 | 캐릭터 정상 조회/쓰기 미대응 | 캐릭터 갤러리 미대응 | 일반 분류와 다른 엔티티로 노출. 같은 자산을 여러 캐릭터에서 참조 가능 |
| 표시 그룹 | 시리즈 내 한 단계 그룹, 캐릭터 소속, 마지막 멤버 이탈 시 해제 | 미대응 | 미대응 | 표시 계층과 실제 분류를 분리. 그룹 갤러리는 자산 합집합을 중복 제거 |
| 캐릭터 참조·판단 | 기준/추가 참조·참조 제외·수동/자동 판단·검토 완료 | 미대응 | 미대응 | 서버가 사용자 선택·판단 기록 보존. 예측과 확정 관계를 구분하고 stale 결과 차단 |
| 캐릭터 분류 제외 | 특정 캐릭터 거절, 시리즈×자산 제외, 폴더/하위 제외가 별개 | 미대응 | 미대응 | 각각의 범위와 해제 의미 보존. 전체 보기와 자동 분류 대상이 달라짐 |
| 앨범 | 계층형 수동 목록·다중 소속 | album snapshot과 album-media 조회 경로 존재 | 확인한 앱 주 탐색은 일반 분류 중심. 현재 PickerLibrary도 분류 기반 목록 구성 | 기존 전송 존재와 모바일 앨범 기능 완성을 구별. 앨범 조회/편집과 Picker 연결 계약 필요 |
| 컬렉션·쇼케이스 | game/manga/movie/av, 별점·선정·순서·외부 연결 | game/manga/movie 읽기 replica. myScore·unreadReleaseCount 등 요약도 수용 | 타입·쇼케이스·검색·상세·표지 감상, 서버 요약 전체를 화면에서 사용하지 않음 | 사용자 편집·provider snapshot·표현 선택을 분리해 서버 소유. AV 모바일 제외 유지 |
| 권·판본·아트워크 | 권 ID·판본·표지 선택·출간 source, Artwork는 Asset과 별도 | 권 ID/판본/표지/출간일/ISBN/status와 artwork blob 전달 | 판본 선택·권별 표지 감상 중심 | 기존 ID/순서를 유지. 서버 데이터 보유와 모바일 표시 누락을 나눠 보완 |
| 소장 상태 | 판본·권·실물/전자 소장. v73은 소장 수 명시 입력 여부(0 포함)를 별도 보존 | 소장 행·입력 여부 전용 계약 미대응 | 소장 조회/편집 미대응 | `미입력`과 `0권 입력`을 구분한 공유 상태. 판본/권 identity 보존 |
| 신간·일일 갱신 | MangaDex/Kakao 갱신, 별도 알림 목록·확인, provider 상태·재시도. 앱 실행 중 작동 | 요약 unread count는 있으나 이벤트·구독·확인·작업 계약 미대응 | 출간 변경 인박스·확인·갱신 작업 미대응 | 서버 스케줄러/작업자와 이벤트 ID별 확인. 첫 관측 기준·이미 본 권·확인 상태를 이전 |
| 영화·TV | movie 타입 안 Film/TV identity, 외부 snapshot의 시즌·에피소드 | 요약과 seasonDateRange 등 전달; binding/시즌·에피소드 전체 모델 미대응 | 영화 요약·표지 중심 | movie ID와 `tv:ID` 구분 보존. 조회 모델 보강과 provider 실행 이전을 별도 작업으로 취급 |
| 온라인 카탈로그 | 별도 DB·그룹/판본 판단·차단/선호·북마크 발행 | versioned replica·검색·Reader, bookmarkWrite/refreshRequest=false | 검색·판본·읽기·북마크 필터. 읽던 위치는 localStorage | 외부 카탈로그와 사용자 상태 분리. 서버 북마크·갱신·향후 읽기 위치 동기화 |
| 암호화 메모 | 로컬 암호문·키·편집·충돌 처리 | 암호문 revision/operation ID/변경 sequence API 이미 존재 | 확인한 앱 영역·native API 허용 목록에 메모 기능 없음 | 기존 암호화 경계 유지. 모바일 키 등록/복구와 편집은 별도 범위이며 평문 서버 저장 금지 |
| 휴지통·복구 | 라이브러리 상태·파일 생명주기와 로컬 복구 | 전역 삭제 protocol 미완. metadata backup 보관/복구 경로는 있음 | 전역 삭제 미완 | tombstone·보존 기간·지연 기기 합류·명시적 purge. 서버 백업은 별도 복구 검증 필요 |
| Android 파일 선택 | PC가 미디어·분류를 공급 | 자산·분류·media ticket 제공 | DocumentsProvider·CloudMediaProvider·기기 캐시 존재 | 앱의 새 캐릭터 탐색과 별도로 Provider 목록/ID/수신 앱 읽기 갱신 필요 |

## 3. 캐릭터 모델의 필수 계약

PC [character API](../../_tools/app/src/characters/api.ts), [hub API](../../_tools/app/src/characters/hubApi.ts), [조회 SQL](../../_tools/app/src-tauri/src/library/character_hub.rs)을 기준으로 한다.

| 데이터 | 서버 계약에 필요한 내용 | 주의할 점 |
|---|---|---|
| Series | classificationId, heroAssetId, autoClassify | Collection과 다른 개념. 하위 등록 시리즈·일반 하위 폴더 범위 구별 |
| CharacterTarget | id, seriesClassificationId, linkedClassificationId, 이름/설명/대표, enabled, manualOnly, revision | linkedClassificationId는 선택 연결이며 캐릭터 ID 대신 쓸 수 없음 |
| DisplayGroup | id, seriesId, name, revision, targetIds | 실제 분류·인식 범위 변경 금지. 빈 그룹 해제 |
| Reference | 기준 slot/추가 참조 구별, assetId/hash, 제외 기록 | 참조에서 빼는 것과 자산 삭제/캐릭터 관계 해제를 구별 |
| Decision | targetId, sourceAssetId/assetId/hash, accepted/rejected/cleared, origin, 순서와 fingerprint | 현재 관계는 마지막 유효 판단에서 도출. 예측 결과 자체를 확정 관계로 쓰지 않음 |
| ScopePolicy | originals 역할, 폴더 제외, 시리즈별 자산 제외, 검토 완료 | 한 boolean으로 합칠 수 없음. 상속된 제외의 원래 폴더 식별 가능해야 함 |
| Jobs / Evidence | 사용자 요청 ID·대상 버전·입력 세대·처리/전체/남음·실패·중지 상태 | 오래된 worker 결과가 이동/참조 변경/수동 결정을 되돌리지 못하도록 검증 |

캐릭터 갤러리는 단순한 `classification_id = character_id` 쿼리가 아니다. 현재 조회는 유효한 accepted 판단과 기준 참조를 합치고, 정상 자산과 위치 조건을 적용해 중복 제거한다. 일부 accepted 자산은 시리즈 조상 위치에서도 보인다. 추가 참조·공유 자산·일반 폴더 연결은 각각 현재 흐름과 fixture로 대조해야 하며 모든 참조 행을 무조건 갤러리 membership으로 옮기지 않는다.

서버 조회와 PC 조회가 같은 fixture에서 같은 자산 ID·순서·개수를 반환하는 것을 첫 기준으로 삼는다. 전체, 미분류, 추가 확인, 캐릭터, 그룹은 서로 다른 scope이며 캐시에 scope 종류·ID·필터·revision을 포함한다. 목록과 개수는 같은 데이터 버전에 기반해야 한다.

시리즈 이동은 캐릭터 ID·참조·판단·공유 자료를 보존하면서 위치와 오래된 작업을 함께 조정하는 원자적 명령이다. 표시 그룹 변경이나 이름 수정과 같은 일반 patch로 처리하지 않는다. [이동 구현](../../_tools/app/src-tauri/src/library/character_series_move.rs)과 [일반 폴더 전환](../../_tools/app/src-tauri/src/library/character_conversion.rs)의 미리보기·stale 거절·참조 보호 조건을 옮긴다.

## 4. 서버 소유·작업·기기 상태 구분

| 구분 | 대상 | 전환 방침 |
|---|---|---|
| 서버의 지속 데이터 | 자산/분류/앨범/캐릭터 관계, 사용자 판단·참조·제외, 컬렉션 사용자 값·소장·출간 이벤트·확인, 카탈로그 사용자 상태 | 클라이언트가 같은 변경 API 사용. 자산/미디어의 완전한 보관 여부도 서버에서 추적 |
| 외부 공급 데이터 | 카탈로그 원본 DB, 작품 provider snapshot, 외부 ID/출처 | 사용자 편집과 분리. 새 snapshot 교체 중 이전 조회 유지 |
| 재생성 가능 자료 | 썸네일·호환본·검색 projection·추론 feature cache | 재생성 가능하지만 필수 결과가 PC에서만 만들어져서는 안 됨. 사용자 판단은 캐시로 취급하지 않음 |
| 서버 실행 작업 | Capture 수집 확정, 카탈로그 갱신, provider 갱신/신간 확인, 자동 캐릭터 처리 | 영속 작업·입력 버전·재시도·동시 실행 방지. PC는 필수 executor에서 제외 |
| 기기 데이터 | 캐시/다운로드·로컬 파일 연결·경로·창/스크롤 상태·인증 자격 증명·메모 복호화 키 | Windows/Linux/Android 방식 유지. 공유 DB에 절대 경로나 자격 증명을 복제하지 않음 |
| 전송 대기 | 오프라인 사용자 변경·업로드 staging | 앱 종료 후에도 유지. 아직 서버가 수락하지 않은 변경은 대기로 표시하고 거절 시 원래 의도 보존 |

PC 대량 가져오기는 계속 지원할 수 있다. 오프라인 수집은 기기에 안전하게 보관한 뒤 서버 등록을 기다린다. 서버 장애 중 저장한 것을 서버 반영 완료로 표시하지 않는다. 기본 오프라인 범위는 캐시/다운로드한 자료의 열람과 변경 대기이며, 모바일 전체 원본 자동 다운로드를 전제하지 않는다.

로컬 망가 루트와 게임 실행은 기기 전용 기능으로 남긴다. 그 파일까지 모바일에서 보려면 별도 업로드/보관 범위 결정이 필요하다. AV 모바일 제외도 이번 전환으로 자동 해제하지 않는다.

## 5. 변경과 호환성 설계 입력

- 서버의 library identity와 영역별 authority epoch를 식별한다. 전환된 영역은 예전 PC 전체 snapshot/쓰기 요청을 거부한다. 전환 전 snapshot 복제와 전환 후 서버 변경을 동시에 권위 원본으로 취급하지 않는다.
- 변경 요청은 operation ID·기준 revision·명시적인 원하는 상태를 가진다. 북마크 toggle 대신 추가/제거 의도를 저장한다. operation ID와 payload의 대응을 보존하고 재전송 결과를 안정적으로 재사용한다. 기존 Notes의 구현은 참고 자료이며 모든 영역에 완전한 공통 중복 제거 저장소가 이미 있다는 뜻은 아니다.
- 서버 변경 sequence와 영속 cursor로 증분 수신한다. 전체 초기 snapshot과 이후 변경 사이의 기준점을 고정한다. cursor가 만료되면 pending 변경을 보존한 재동기화 경로가 필요하다.
- 서버 반영을 로컬 캐시에 적용한 결과가 다시 사용자 변경 outbox에 들어가지 않게 한다. 충돌은 영역별로 처리하고 단말 시계의 마지막 시각만으로 승자를 정하지 않는다.
- 카탈로그 교체는 북마크·차단·그룹 판단·읽던 위치를 덮어쓰지 않는다. provider/work/group ID의 안정성과 카탈로그 revision을 분리한다.
- 출간 변경 확인은 사용자가 본 event ID에만 적용한다. 작품을 여는 동작 자체로 읽음 처리하지 않으며, 확인 요청 중 도착한 새 이벤트를 지우지 않는다. 최초 MangaDex 기준과 이미 본 권을 보존해 이전 후 알림이 폭증하지 않게 한다.
- Android는 [NetworkPolicy](../../android/src/com/lakomics/mobile/NetworkPolicy.java)가 API path와 HTTP method를 제한한다. React에 버튼만 추가해도 새 API를 호출할 수 없다. 기능별 허용 경로와 native 취소/에러/인증 계약을 함께 확장한다.
- 서버가 제공하는 capability/schema/최소 호환 버전을 기반으로 화면을 활성화한다. 인증과 최초 기기 등록·복구는 PC 실행 없이 가능해야 하며, 기존 token 설정 기능과 사용자 친화적 등록 절차의 완성을 구별한다.

## 6. 모바일에서 먼저 맞출 범위

첫 읽기 범위는 기존 Library 안의 시리즈·그룹·캐릭터·일반 폴더 탐색과 갤러리 일치다. PC와 같은 의미의 카드·대표 이미지·전체/미분류 범위를 제공하되 태블릿의 가로/세로 탐색과 뒤로가기 상태를 유지한다. 검토·오류 정보는 해당 맥락에서 제공하며 과거의 전역 작업 배지 UI를 되살리지 않는다.

그 다음 서버 쓰기 파일럿인 북마크를 완성하고, 캐릭터 수동 지정·제외·검토 완료, 소장 수와 출간 확인 등 모바일 일상 작업을 순차 활성화한다. 캐릭터 등록·참조 편집·이동·전환은 읽기 제공만으로 완료됐다고 보지 않되, 첫 모바일 화면에 모든 PC 관리 도구를 넣는 전제도 두지 않는다.

앱 갤러리와 Android 파일 선택은 별도 경로다. 캐릭터/그룹을 Picker에서 선택할 경우 일반 분류 ID와 충돌하지 않는 안정적 ID가 필요하다. 공유 자산의 중복 노출, 목록 갱신, 취소·재연결, 다른 앱의 URI 읽기를 따로 검증한다. 파일 선택 기능의 과거 완료 기록은 새 캐릭터 범위의 수용 증거가 아니다.

## 7. 전환·검증 조건

기존 전체 Cloud Library backfill은 재실행하지 않는다. 먼저 ID·개수·hash·관계·기존 서버 등록·R2 object의 가용성을 읽기 전용으로 대조하고 부족한 데이터만 이전 대상으로 산출한다. metadata backup에 포함됐다는 이유만으로 정상 서버 테이블·원본 미디어가 모두 복구된다고 가정하지 않는다.

전환은 영역별로 일관된 백업 확보 → 기존 큐 정리/기준 고정 → 변경분 반영 → 구버전 쓰기 차단 → 서버 쓰기 활성화 순서다. 첫 서버 변경 이후에는 예전 DB를 그대로 복원하는 롤백이 새 변경을 유실하므로, 변경 로그 보존·재적용을 포함한 복구 절차를 먼저 검증한다. 실제 활성 라이브러리 이전·서버 배포·서비스 운영·R2 정리에는 각 작업의 별도 명시적 승인이 필요하다.

| 검증 묶음 | 반드시 확인할 결과 |
|---|---|
| 캐릭터 fixture 동등성 | 일반/시리즈/그룹/캐릭터 목록, 공유 이미지 합집합, 참조, 조상 accepted, 수동형·제외 상속, originals 역할, 휴지통 필터, cursor/개수 일치 |
| 이동·동시 작업 | 이동 미리보기 이후 변경 거절, 참조·공유 관계 보존, 빈 그룹 해제, 오래된 worker 결과 차단, 참조 저장/이동만으로 과거 재분석 미실행 |
| 컬렉션 | 권 ID/판본/표지 보존, 미입력과 0권 구분, provider별 첫 기준과 이벤트 중복 방지, 명시 확인, 사용자 값/AV 경계 보존 |
| 변경 재시도 | 응답 유실·중복 요청·동시 편집·장기 오프라인·cursor 만료·구버전 PC 발행 시 사용자 변경 유실 없음 |
| 서버 작업 복구 | 업로드/등록 사이 중단, 중복 Capture, 불완전 미디어 비공개, worker 재시작·중복 실행, 갱신 중 기존 카탈로그 열람 |
| PC 종료 수용 | 새 모바일 연결→수집→조회→북마크/캐릭터 수정→카탈로그/신간 갱신을 완료. 나중에 PC를 켜도 같은 상태 유지 |
| 플랫폼 | Windows/Linux의 로컬 보관·credential·증분 수신, Android 가로/세로·재실행·Picker/수신 앱 읽기. 브라우저 fixture는 native 증거와 분리 |
| 복구 | 서버 DB·object manifest의 같은 기준 복원, 새 기기의 재수신, 미전송 변경 보존, 메모 키 없이 평문 복구 불가 유지 |

위 표는 후속 구현의 검증 기준이며 이번 조사에서 실행한 테스트 결과가 아니다. 이 문서 작업의 검증은 소스 대조·로컬 링크 확인·변경 diff 확인으로 한정한다.

## 8. 확인한 주요 소스

- 분류/자산/Capture/복제/앨범 API: [app.py](../../server/lakomics-api/app.py), [sync.rs](../../_tools/app/src-tauri/src/cloud/sync.rs), [captures.rs](../../_tools/app/src-tauri/src/cloud/captures.rs), [albums.rs](../../_tools/app/src-tauri/src/cloud/albums.rs).
- 캐릭터 저장/판단: [0044](../../_tools/app/src-tauri/migrations/0044_characters.sql), [0053 그룹](../../_tools/app/src-tauri/migrations/0053_character_groups.sql), [0071 제외](../../_tools/app/src-tauri/migrations/0071_character_folder_exclusions.sql), [character_folders.rs](../../_tools/app/src-tauri/src/library/character_folders.rs), [character_reference_refresh.rs](../../_tools/app/src-tauri/src/library/character_reference_refresh.rs), [character_incremental.rs](../../_tools/app/src-tauri/src/library/character_incremental.rs).
- 컬렉션 전송과 모바일: [collections.rs](../../_tools/app/src-tauri/src/cloud/collections.rs), [mobile_collections.py](../../server/lakomics-api/mobile_collections.py), [collectionModel.ts](../../_tools/app/mobile-client/collectionModel.ts), [Collections.tsx](../../_tools/app/mobile-client/Collections.tsx).
- 최근 소장/갱신: [0073](../../_tools/app/src-tauri/migrations/0073_collection_daily_updates.sql), [collection_updates.rs](../../_tools/app/src-tauri/src/library/collection_updates.rs), [collection_tracking.rs](../../_tools/app/src-tauri/src/library/collection_tracking.rs), [useReleaseWatchCheck.ts](../../_tools/app/src/app/useReleaseWatchCheck.ts), [ReleaseInbox.tsx](../../_tools/app/src/collections/ReleaseInbox.tsx).
- 카탈로그: [catalog.rs](../../_tools/app/src-tauri/src/cloud/catalog.rs), [mobile_catalog.py](../../server/lakomics-api/mobile_catalog.py), [mobile_catalog_replica.py](../../server/lakomics-api/mobile_catalog_replica.py), [CatalogReader.tsx](../../_tools/app/mobile-client/CatalogReader.tsx).
- Android/모바일: [types.ts](../../_tools/app/mobile-client/types.ts), [ClassificationIndex.tsx](../../_tools/app/mobile-client/ClassificationIndex.tsx), [transport.ts](../../_tools/app/mobile-client/transport.ts), [MainActivity.java](../../android/src/com/lakomics/mobile/MainActivity.java), [PickerLibrary.java](../../android/src/com/lakomics/mobile/PickerLibrary.java), [SecureSettings.java](../../android/src/com/lakomics/mobile/SecureSettings.java).
- 복구/메모: [metadata_backup.rs](../../_tools/app/src-tauri/src/cloud/metadata_backup.rs), [notes.py](../../server/lakomics-api/notes.py), [ADR-0035](../adr/0035-encrypted-personal-notes.md).

전체 PC 기능의 완전한 명세나 원격 운영 감사는 아니다. 통계/테마의 세부 동작, 모든 provider의 서버 실행 적합성, 실제 서버의 CPU/RAM/저장 용량과 미디어 크기 분포, 모든 UI 설정의 공유 여부는 후속 영역 조사에서 정한다. 현재 코드로 확인 가능한 대응 차이를 먼저 기록했으며 새 서비스 비용·일정은 아직 산정하지 않았다.
