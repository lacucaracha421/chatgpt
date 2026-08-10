# 공통 ViewToolbar 모듈 설계

날짜: 2026-08-11

상태: 사용자 확인 완료

## 목적

5개 뷰(자산/유사 검토/휴지통/설정/망가)가 각자 다른 클래스로 흩어져 있는 툴바를 하나의 공통 `ViewToolbar` 컴포넌트로 통합한다. 새 탭이 생길 때마다 창 제어 버튼·드래그 영역·레트로 스타일을 반복 구현하지 않도록 한다.

## 배경

- 각 뷰 툴바가 `.asset-toolbar`, `.similarity-review__toolbar`, `.trash-browser__toolbar`, `.settings-view__toolbar`, `.manga-browser__toolbar`로 제각각이다.
- 망가 탭은 새로 만들어서 `WindowControls`(최소화/최대화/닫기)와 드래그 영역이 없다.
- 공통 요소: 40px 높이, 다크 배경, 레트로 베벨, 모노스페이스 타이틀, `data-tauri-drag-region`, 우측 `WindowControls`.

## 결정 사항

1. **공통 컴포넌트**: `app/src/layout/ViewToolbar.tsx` 신규. 타이틀 + 좌측 컨텐츠 + 우측 액션 + WindowControls + 드래그 영역을 한 번에 제공.
2. **5개 뷰 전부 이관**: 각 뷰의 툴바 JSX를 `ViewToolbar` 조합으로 교체.
3. **CSS 통합**: 공통 룰을 `.view-toolbar` 하나로 통합. 뷰별 특수 룰은 `.view-toolbar` 스코프로 이관.
4. **새 탭 절차**: `ViewToolbar title="..." actions={...}` 조합만으로 창 제어/드래그/레트로 스타일 자동 적용.

## 아키텍처

### 컴포넌트

```tsx
type ViewToolbarProps = {
  title: string;
  children?: ReactNode;   // 좌측 컨텐츠 (정렬/필터/슬라이더 등)
  actions?: ReactNode;    // 우측 액션 (새로고침, 닫기 등)
};
```

렌더 구조:

```tsx
<header className="view-toolbar" data-tauri-drag-region>
  <h2 data-tauri-drag-region>{title}</h2>
  {children && <div className="view-toolbar__content">{children}</div>}
  <div className="view-toolbar__actions">
    {actions}
    <WindowControls />
  </div>
</header>
```

- `WindowControls`는 항상 우측 끝에 자동 포함.
- 드래그 영역은 header와 h2에 자동 부여.

### 뷰별 조합

| 뷰 | title | children | actions |
|---|---|---|---|
| 자산 (AssetToolbar) | 위치명 | 정렬/토글/슬라이더/선택모드 컨트롤 | (없음) |
| 유사 검토 | 유사 검토 | 진행률 | 닫기 버튼 |
| 휴지통 | 휴지통 | 설명 | 휴지통 비우기 |
| 설정 | 설정 | 설명 | (없음) |
| 망가 | 망가 | (없음) | 새로고침 |

### CSS 통합

- `.asset-toolbar`, `.similarity-review__toolbar`, `.manga-browser__toolbar`의 공통 룰(높이/배경/베벨/타이틀 폰트)을 `.view-toolbar`로 통합.
- `.asset-toolbar .ui-toggle` 등 레트로 컨트롤 룰은 `.view-toolbar .ui-toggle`로 이관.
- `.trash-browser__toolbar`, `.settings-view__toolbar`는 배경이 없는 평면 행이었으나, 통합 후에는 다른 뷰와 동일한 툴바 스타일을 받는다 (일관성 목적).

## 데이터 흐름

- `ViewToolbar`는 상태를 갖지 않는다. props로 받은 title/children/actions를 배치할 뿐.
- 각 뷰가 기존 상태/핸들러를 그대로 children/actions로 전달.

## 오류 처리

- 해당 없음 (순수 프레젠테이션 컴포넌트).

## 테스트

- `ViewToolbar` 단위 테스트: title 렌더, children/actions 배치, WindowControls 포함, `data-tauri-drag-region` 부여.
- 기존 뷰 테스트가 깨지지 않는지 확인 (툴바 관련 aria-label/버튼 검증 유지).

## 변경 파일

| 파일 | 작업 |
|---|---|
| `app/src/layout/ViewToolbar.tsx` | 신규 |
| `app/src/layout/ViewToolbar.test.tsx` | 신규 |
| `app/src/assets/AssetToolbar.tsx` | ViewToolbar 조합으로 교체 |
| `app/src/similarity/SimilarityReviewBrowser.tsx` | ViewToolbar 조합으로 교체 |
| `app/src/safety/TrashBrowser.tsx` | ViewToolbar 조합으로 교체 |
| `app/src/settings/SettingsView.tsx` | ViewToolbar 조합으로 교체 |
| `app/src/manga/MangaBrowser.tsx` | ViewToolbar 조합으로 교체 |
| `app/src/styles/global.css` | `.view-toolbar` 통합 + 뷰별 룰 이관 |
| 관련 테스트 | 툴바 구조 변경 반영 |

## 제외 (YAGNI)

- 툴바 기능 이동 (정렬/필터/크기 조절 위치 유지).
- 탭별 툴바 높이/스타일 커스터마이즈 (모두 동일하게).
