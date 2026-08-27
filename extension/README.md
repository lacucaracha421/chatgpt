# Lakomics X Collector 2.0.0-alpha.15.22

Unified desktop/mobile X media collector for Lakomics.

## alpha.15.1
- Integrated AI X Translate Lite v1.4.14 OpenRouter edition into the extension.
- Translation API keys/settings are stored in extension-local storage and requests are proxied by the service worker.
- Added OpenRouter, Ollama Cloud, Gemini and Vercel host permissions only for the translation proxy.
- Simplified the main settings page: Lakomics connection, X Translate, mobile gesture settings and PC radial layout stay visible.
- Rare recovery/offline controls moved under Advanced settings.
- Save mode is now fixed to Auto from the simplified UI; touch persistence and context-menu suppression stay enabled.
- Keeps alpha.14.1 mobile center-button confirmation and Titanium runtime messaging compatibility.

## alpha.15.5 - 추천 이미지 갤러리

- X 홈의 `추천` 탭에서 화면에 들어온 사진 게시물을 세션 갤러리에 모읍니다.
- 우측의 `▦` 버튼으로 추천 이미지 갤러리를 엽니다.
- 갤러리의 `자동 수집`은 추천 피드를 뒤에서 자동 스크롤하며 새 이미지 최대 100장을 수집한 뒤 시작 위치로 복귀합니다.
- 갤러리 이미지도 기존 Lakomics X Collector의 모바일 길게 누르기/PC 드래그 저장 흐름을 그대로 사용합니다.


## alpha.15.7 - 추천 갤러리 렌더 최적화
- 갤러리를 열 때 처음 36장만 렌더링하고, 아래로 내려가면 24장씩 추가합니다.
- 새 이미지 수집 시 기존 카드 전체를 지우고 다시 만드는 대신 새 카드만 추가합니다.
- 자동 수집 중에는 갤러리 카드 생성을 미뤄 X 피드 스크롤과 수집을 우선합니다.

## alpha.15.8 - 좋아요 필터
- 추천 갤러리 카드에 X 게시물의 좋아요 수를 표시합니다.
- 갤러리 상단에서 `전체`, `♥ 1천+`, `♥ 5천+`, `♥ 1만+` 필터를 즉시 전환할 수 있습니다.
- 필터는 표시만 제한하며 수집 데이터는 버리지 않으므로 언제든 `전체`로 되돌릴 수 있습니다.
- X의 일반 숫자와 K/M/B, 한국어 `천/만/억`, 일본어 `万/億` 축약 표기를 처리합니다.
