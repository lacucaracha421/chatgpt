# 첫 버전은 Windows 데스크톱에 집중한다

**Status:** Partly superseded by the current platform policy in [AGENTS.md](../../AGENTS.md).

## Current scope — 2026-09-09

현재 데스크톱 구현은 Windows와 Linux를 지원한다. 후속 변경은 양쪽 플랫폼의
라이브러리 이식성, 경로·미디어 프로토콜·자격 증명 저장소 차이를 보존한다.
Linux 구현 범위와 남은 네이티브 검증은 [Linux 운영 안내](../operations/linux-desktop.md)를 따른다.
플랫폼 독립적인 라이브러리 데이터 형식 원칙은 유지한다. 독립 Android 소비 클라이언트는
[모바일 reference](../agents/mobile.md)가 별도로 정의한다.

## Original decision (historical)

첫 번째 완성 버전은 Windows 데스크톱만 지원하고, 라이브러리 데이터 형식은 향후 다른 플랫폼에서도 읽을 수 있도록 특정 UI 기술에 종속시키지 않는다. 여러 플랫폼을 동시에 지원할 때 생기는 파일 시스템 감시, 대용량 미디어 처리, 운영체제 통합의 복잡성을 피하고 핵심인 수집·분류·검색·이미지 감상의 완성도를 우선하기 위한 결정이다.
