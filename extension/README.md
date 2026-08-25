# Lakomics Radial 2.0.0-alpha.15.1

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
- 갤러리 이미지도 기존 Lakomics Radial의 모바일 길게 누르기/PC 드래그 저장 흐름을 그대로 사용합니다.
