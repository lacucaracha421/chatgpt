# Lakomics X Collector 태블릿 설치 안내 (alpha.15.29)

PC에서 만든 배포 zip: `C:\chatgpt\lakomics-x-collector-2.0.0-alpha.15.29.zip`

갤럭시 탭(Android Chromium 계열 브라우저, 예: Quetta/Levanter)에 이 zip을 설치해
PC Lakomics로 미디어를 직접 수집한다.

## 1. zip을 태블릿으로 옮기기

아무 방법이나 쓴다.

- PC의 zip 파일을 Tailscale Drive/SMB/클라우드로 공유해 태블릿 Download에 저장
- 또는 태블릿 브라우저에서 직접 접근 가능한 공유 폴더에 복사

## 2. 태블릿 브라우저에 설치

1. 태블릿 브라우저의 확장 프로그램 페이지를 연다 (주소창에 `chrome://extensions`).
2. **개발자 모드**를 켠다.
3. zip을 그대로 드래그해 확장 페이지에 놓거나, **압축 풀린 파일 로드**로
   압축을 푼 `lakomics-x-collector-2.0.0-alpha.15.29` 폴더를 선택한다.
4. 설치된 확장 ID가 `nclkmjmmlcdaeomgadndeangccfidfbk`인지 확인한다.
   다르면 이 빌드는 PC Lakomics에 연결할 수 없다.

## 3. PC Lakomics 연결

1. PC에서 Lakomics를 실행하고 라이브러리를 연다.
2. 이번 안정성 개선(동시 요청 처리·다운로더 타임아웃)을 적용하려면
   PC 앱도 새 빌드로 다시 실행해야 한다: `npm run tauri dev`
3. 태블릿 확장 설정에서:
   - PC의 32자리 연결 키를 `Lakomics 연결`에 입력
   - `Remote Lakomics · Tailscale` 켜기
   - PC의 `https://...ts.net` 주소 입력 (PC PowerShell: `tailscale serve status`로 확인)
   - `저장하고 원격 연결 테스트` 누른 뒤 X 탭 새로고침

## 이 버전에 포함된 연결 안정성 개선

- PC API가 요청을 동시에 처리한다. 영상 수집이 진행 중이어도
  태블릿의 상태 확인·분류 조회가 막히지 않는다.
- 영상 수집 요청의 타임아웃이 8초에서 120초로 늘었다.
  Tailscale 터널을 경유하는 영상 원본 전송이 중간에 끊기지 않는다.
- 수집 실패 시 3회까지 재시도한다. 터널이 잠깐 끊겨도 복구를 기다린다.
- PC가 X CDN 응답을 멈춰도 5분 뒤 포기하므로 서버 전체가 정지하지 않는다.

문제가 있으면 `extension/REMOTE_SETUP.md`와 `docs/edge-extension.md` 문제 해결
섹션을 참고한다.