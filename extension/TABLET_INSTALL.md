# Lakomics X Collector 태블릿 설치 안내 (alpha.15.30)

이 버전은 VPS Capture Inbox로 넘어가는 전환 릴리스다.
X 이미지·영상·움짤 MP4를 서버로 바로 수집할 수 있고, 분류 조회는 기존 PC/Remote 경로를 유지한다.

## 1. 설치

1. `lakomics-x-collector-2.0.0-alpha.15.30.zip`을 갤럭시 탭으로 옮긴다.
2. Android Chromium 계열 브라우저의 확장 페이지를 연다.
3. 개발자 모드를 켜고 zip 또는 압축을 푼 폴더를 로드한다.
4. 기존 PC API도 함께 쓸 경우 확장 ID가 `nclkmjmmlcdaeomgadndeangccfidfbk`인지 확인한다.

## 2. 미디어 저장 서버 설정

확장 설정의 `미디어 저장 서버`에서:

- `VPS Capture Inbox 사용`을 켠다.
- 서버 주소 기본값은 `http://100.76.119.29:32146`이다.
- VPS의 `LAKOMICS_API_TOKEN` 값을 `서버 API 토큰`에 입력한다.
- `저장하고 테스트`를 누른다.

성공하면 `서버 연결 성공 · 미디어 수집 준비됨`이 표시된다.
서버 토큰은 확장 로컬 저장소에만 보관되고 설정 조회 응답에는 포함되지 않는다.

## 3. PC 분류 연결

현재 15.30에서는 도넛 분류를 아직 VPS가 제공하지 않는다.
기존 PC 연결 키와 Remote Lakomics 설정을 유지하면 마지막 PC 분류와 배치를 계속 사용할 수 있다.
PC가 잠시 꺼져 있어도 저장된 분류 snapshot이 있으면 도넛을 즉시 열고 미디어는 VPS로 수집한다.

분류 snapshot이 전혀 없는 상태에서 PC에도 연결할 수 없으면 기존 로컬 도넛/브라우저 다운로드 fallback을 사용한다.

## 4. 현재 저장 동작

- VPS collector ON + X 이미지/영상/움짤 MP4: `확장 -> VPS /v1/captures -> R2`, 상태는 `pending`.
- PC inbound importer가 signed URL로 원본을 수집하고 ACK한 뒤에만 `imported`가 된다. PC에는 R2 자격 증명이 없다.
- VPS collector 장애: 갤탭 Download로 자동 fallback.
- `saveMode=download` 또는 로컬 도넛을 명시적으로 쓰는 경우: 기존 기기 다운로드 동작 유지.

Capture Inbox는 Remote → PC 인바운드이고, `cloud_sync_queue`는 PC → Cloud 아웃바운드다. 두 시스템은 별개다.

다음 단계에서는 분류와 saved-media index도 서버로 옮겨 PC/Tailscale Remote 의존을 제거한다.
