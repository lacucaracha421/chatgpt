# Lakomics 네이티브 제목바·툴바 통합 설계

날짜: 2026-08-10

상태: 사용자 최종 확인 대기

## 목적

창 맨 위의 OS 기본 제목 표시줄(흰색 막대)을 제거하고, 앱 내부의 다크 툴바가 창 제목바 겸 드래그 핸들을 대신하도록 통합한다. 동시에 "AI 생성물처럼 보이는" 툴바 디자인을 레트로/네이티브 스타일로 개선한다.

## 배경

- 현재 `tauri.conf.json`에 `decorations: false`가 없어 OS가 그린 흰색 제목 표시줄이 표시된다.
- 앱은 다크 테마(#111316 배경)인데 OS 제목 표시줄이 밝아 시각적으로 어긋난다.
- `.asset-toolbar`(40px, #1b1e22)가 콘텐츠 열 상단에 있고, 뷰마다 비슷한 툴바가 반복된다.
- 사용자가 "툴바가 AI스럽다"고 느끼는 지점: Heroicons 24/outline, 단일 파랑 강조색, 전 컨트롤 28px/0.75rem 균일, 모든 뷰 동일한 40px 툴바 공식.

## 결정 사항

1. **OS 제목 표시줄 제거**: `tauri.conf.json` 창 설정에 `"decorations": false` 추가.
2. **뷰 툴바가 제목바 겸임**: 각 뷰 툴바가 창 제목바 역할을 한다. 툴바에 창 제어 버튼(최소화/최대화·복원/닫기)을 배치한다.
3. **드래그 영역**: 툴바 빈 영역과 사이드바 상단(`.classification-sidebar__heading`)에 `data-tauri-drag-region`을 부여해 창 위쪽 전체가 드래그로 이동 가능하게 한다.
4. **레트로/네이티브 스타일**: 1px 베벨, 리버스 하이라이트, 모노스페이스 타이틀로 툴바를 재구성한다.

## 아키텍처

### 창 설정

`src-tauri/tauri.conf.json`의 `app.windows[0]`에 `"decorations": false` 추가.

### 새 컴포넌트: `WindowControls`

`src/layout/WindowControls.tsx` 신규.

- 최소화 / 최대화·복원 / 닫기 3버튼.
- `@tauri-apps/api/window`의 `getCurrentWindow()` 사용:
  - `.minimize()`
  - `.toggleMaximize()`
  - `.close()`
- 닫기 버튼 hover 시 빨간 배경(네이티브 관례).
- 버튼에 `data-tauri-drag-region`을 **부여하지 않아** 드래그와 충돌하지 않는다.
- `aria-label`로 접근성 제공.

### 드래그 영역

- 각 뷰 툴바 `header`에 `data-tauri-drag-region` 부여.
- 인터랙티브 컨트롤(Select/Toggle/Slider/Button)은 `data-tauri-drag-region`이 없어 Tauri가 해당 요소 위 드래그를 자동 제외한다.
- `.classification-sidebar__heading`에도 `data-tauri-drag-region` 부여.

### 툴바 배치

4개 뷰 툴바에 `WindowControls`를 우측에 배치:

| 뷰 | 툴바 클래스 | 비고 |
|---|---|---|
| 자산 브라우저 | `.asset-toolbar` | 기존 컨트롤 + WindowControls |
| 유사 검토 | `.similarity-review__toolbar` | 기존 닫기 버튼 + WindowControls |
| 휴지통 | `.trash-browser__toolbar` | 기존 컨트롤 + WindowControls |
| 설정 | `.settings-view__toolbar` | 기존 헤더 + WindowControls |

## 레트로 스타일

### 토큰 추가 (`tokens.css`)

```css
--bevel-light: #2b2f35;
--bevel-dark: #0c0e11;
--toolbar-title-font: "Cascadia Mono", "Consolas", monospace;
```

### 툴바 베벨

- 상단 1px `--bevel-light`, 하단 1px `--bevel-dark` → 눌린 듯한 리버스 베벨.
- 기존 `border-bottom: var(--color-border)`를 베벨 조합으로 대체.

### 타이틀

- `h2`에 `font-family: var(--toolbar-title-font)`, `font-size: 0.8125rem`, `text-transform: uppercase`, `letter-spacing: 0.02em`.

### 버튼 베벨

- `.ui-button`에 인셋 베벨(상단 어두운/하단 밝은 1px)로 "눌림" 상태 표현.
- hover 시 리버스(상단 밝은/하단 어두운)로 "올라온" 상태.

## 데이터 흐름

- `WindowControls`는 상태를 갖지 않는다. Tauri window API를 직접 호출한다.
- 드래그 영역은 Tauri가 `data-tauri-drag-region` 속성으로 처리하므로 별도 JS 로직이 없다.

## 오류 처리

- Tauri window API 호출 실패 시 조용히 무시(콘솔 경고만). 데스크톱 환경이 아니면(웹 브라우저 테스트) 버튼이 동작하지 않을 수 있으므로, `getCurrentWindow()` 호출을 try/catch로 감싼다.

## 테스트

- `WindowControls` 단위 테스트: 3버튼 렌더링, aria-label, 클릭 시 window API 호출(모킹).
- 드래그 영역: 각 툴바 header에 `data-tauri-drag-region` 속성 존재 확인.
- 기존 툴바 테스트가 깨지지 않는지 확인.

## 변경 파일

| 파일 | 작업 |
|---|---|
| `src-tauri/tauri.conf.json` | `decorations: false` |
| `src/layout/WindowControls.tsx` | 신규 |
| `src/layout/WindowControls.test.tsx` | 신규 |
| `src/assets/AssetToolbar.tsx` | WindowControls + 드래그 영역 |
| `src/similarity/SimilarityReviewBrowser.tsx` | WindowControls + 드래그 영역 |
| `src/safety/TrashBrowser.tsx` | WindowControls + 드래그 영역 |
| `src/settings/SettingsView.tsx` | WindowControls + 드래그 영역 |
| `src/classification/ClassificationSidebar.tsx` | 헤딩에 드래그 영역 |
| `src/styles/tokens.css` | 베벨/타이틀 폰트 토큰 |
| `src/styles/global.css` | 레트로 툴바/버튼 룰 |
| 관련 테스트 | WindowControls, 드래그 영역 |

## 제외

- 아이콘 세트 교체(Heroicons 유지).
- 컬러 계획 전면 재설계(단일 파랑 유지).
- 툴바 기능 이동(정렬/필터/크기 조절 위치 유지).
