# 데스크톱 앱은 Tauri와 작은 Rust 핵심부로 만든다

**Status:** Accepted; platform clarification recorded 2026-09-09.

데스크톱 앱은 Tauri 2를 사용하고 Windows의 WebView2, Linux의 WebKitGTK에서 React + TypeScript UI를 실행한다. 플랫폼 지원 및 검증 범위는 [현재 플랫폼 방침](0002-windows-first.md)과 [Linux 운영 안내](../operations/linux-desktop.md)를 따른다. Rust 핵심부는 라이브러리 데이터베이스, 안전한 파일 수집, 썸네일·해시·영상 메타데이터 백그라운드 작업처럼 성능과 데이터 안전이 중요한 기능만 소유한다. UI와 Chromium 확장 프로그램은 TypeScript 자료형과 검증 규칙을 공유하되 Rust 세부 구현을 알지 못하게 해, Electron보다 낮은 기본 자원 사용량을 얻으면서 두 언어 사이의 인터페이스를 작게 유지한다.
