# 네이티브 제목바·툴바 통합 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OS 제목 표시줄을 제거하고 뷰 툴바가 창 제목바 겸 드래그 핸들을 대신하도록 통합하며, 툴바를 레트로/네이티브 스타일로 개선한다.

**Architecture:** `tauri.conf.json`에 `decorations: false`를 추가해 OS 제목 표시줄을 제거한다. 새 `WindowControls` 컴포넌트(최소화/최대화·복원/닫기)를 만들어 4개 뷰 툴바 우측에 배치한다. 각 툴바 header와 사이드바 헤딩에 `data-tauri-drag-region`을 부여해 창 이동을 지원한다. tokens.css에 베벨/타이틀 폰트 토큰을 추가하고 global.css에 레트로 베벨 룰을 적용한다.

**Tech Stack:** React 19, TypeScript, Tauri v2 (`@tauri-apps/api/window`), Vitest + Testing Library, CSS custom properties.

## Global Constraints

- 모든 UI 텍스트는 한국어를 유지한다.
- `@tauri-apps/api`는 이미 `^2`로 설치되어 있다. 새 의존성 추가 금지.
- 기존 BEM 클래스 규칙(`block__element`, `block--modifier`)을 따른다.
- `data-tauri-drag-region`은 인터랙티브 컨트롤(Select/Toggle/Slider/Button)에 부여하지 않는다.
- Tauri window API 호출은 try/catch로 감싸 웹 브라우저 테스트 환경에서도 안전하게 동작하게 한다.
- 테스트는 `npm test`(vitest run)로 실행한다. 타입 검사는 `npx tsc --noEmit`로 실행한다.

---

### Task 1: 창 설정에 decorations: false 추가

**Files:**
- Modify: `app/src-tauri/tauri.conf.json:13-21`

**Interfaces:**
- Consumes: 없음
- Produces: `app.windows[0].decorations === false` (AppShell.test.tsx의 제품 정체성 테스트가 이를 검증)

- [ ] **Step 1: 기존 테스트가 decorations를 검증하는지 확인**

`app/src/layout/AppShell.test.tsx:25-34`의 "uses the Lakomics product identity" 테스트가 `tauri.app.windows[0].title`을 검증한다. 이 테스트에 `decorations` 검증을 추가한다.

- [ ] **Step 2: 테스트에 decorations 검증 추가**

`app/src/layout/AppShell.test.tsx:33` 뒤에 추가:

```tsx
expect(tauri.app.windows[0].decorations).toBe(false);
```

- [ ] **Step 3: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/layout/AppShell.test.tsx`
Expected: FAIL — `decorations`가 undefined라 `toBe(false)` 실패

- [ ] **Step 4: tauri.conf.json에 decorations 추가**

`app/src-tauri/tauri.conf.json`의 `app.windows[0]`에 `"decorations": false` 추가:

```json
{
  "title": "Lakomics",
  "width": 1280,
  "height": 800,
  "minWidth": 960,
  "minHeight": 640,
  "decorations": false
}
```

- [ ] **Step 5: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/layout/AppShell.test.tsx`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add app/src-tauri/tauri.conf.json app/src/layout/AppShell.test.tsx
git commit -m "feat: remove the native window title bar"
```

---

### Task 2: WindowControls 컴포넌트 생성

**Files:**
- Create: `app/src/layout/WindowControls.tsx`
- Create: `app/src/layout/WindowControls.test.tsx`

**Interfaces:**
- Consumes: 없음
- Produces: `WindowControls` — props 없음, `<div className="window-controls">` 렌더, 내부에 최소화/최대화·복원/닫기 3버튼. 각 버튼 `aria-label`: "창 최소화", "창 최대화"/"창 복원", "창 닫기". Tauri window API는 `getCurrentWindow()`에서 `.minimize()`, `.toggleMaximize()`, `.close()` 호출.

- [ ] **Step 1: 실패하는 테스트 작성**

`app/src/layout/WindowControls.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WindowControls } from "./WindowControls";

const minimize = vi.fn();
const toggleMaximize = vi.fn();
const close = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close }),
}));
afterEach(() => { cleanup(); minimize.mockClear(); toggleMaximize.mockClear(); close.mockClear(); });

it("renders minimize, maximize, and close buttons", () => {
  render(<WindowControls />);
  expect(screen.getByRole("button", { name: "창 최소화" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 최대화" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});

it("calls the window API on each button click", async () => {
  const user = userEvent.setup();
  render(<WindowControls />);
  await user.click(screen.getByRole("button", { name: "창 최소화" }));
  await user.click(screen.getByRole("button", { name: "창 최대화" }));
  await user.click(screen.getByRole("button", { name: "창 닫기" }));
  expect(minimize).toHaveBeenCalledOnce();
  expect(toggleMaximize).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/layout/WindowControls.test.tsx`
Expected: FAIL — 모듈을 찾을 수 없음

- [ ] **Step 3: WindowControls 구현**

`app/src/layout/WindowControls.tsx`:

```tsx
import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
  const window = getCurrentWindow();
  return (
    <div className="window-controls" aria-label="창 제어">
      <button type="button" className="window-controls__button" aria-label="창 최소화" onClick={() => void window.minimize()} />
      <button type="button" className="window-controls__button" aria-label="창 최대화" onClick={() => void window.toggleMaximize()} />
      <button type="button" className="window-controls__button window-controls__button--close" aria-label="창 닫기" onClick={() => void window.close()} />
    </div>
  );
}
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/layout/WindowControls.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/layout/WindowControls.tsx app/src/layout/WindowControls.test.tsx
git commit -m "feat: add window control buttons for the custom title bar"
```

---

### Task 3: WindowControls 스타일 추가

**Files:**
- Modify: `app/src/styles/global.css` (`.window-controls` 룰 추가)

**Interfaces:**
- Consumes: Task 2의 `.window-controls`, `.window-controls__button`, `.window-controls__button--close` 클래스
- Produces: 창 제어 버튼의 시각적 스타일

- [ ] **Step 1: CSS 룰 추가**

`app/src/styles/global.css`에 추가 (`.asset-toolbar` 룰 근처):

```css
.window-controls {
  display: flex;
  align-items: stretch;
  align-self: stretch;
  margin-right: calc(var(--space-3) * -1);
}

.window-controls__button {
  width: 40px;
  border: none;
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
}

.window-controls__button:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

.window-controls__button--close:hover {
  background: var(--color-danger);
  color: var(--color-bg);
}
```

- [ ] **Step 2: CSS 존재 검증 테스트 추가**

`app/src/layout/AppShell.test.tsx`의 `declarations` 헬퍼를 사용해 검증:

```tsx
it("styles the window controls as native title bar buttons", () => {
  expect(declarations(".window-controls__button--close:hover")).toContain("background: var(--color-danger);");
});
```

- [ ] **Step 3: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/layout/AppShell.test.tsx`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add app/src/styles/global.css app/src/layout/AppShell.test.tsx
git commit -m "style: add window control button styles"
```

---

### Task 4: AssetToolbar에 WindowControls와 드래그 영역 추가

**Files:**
- Modify: `app/src/assets/AssetToolbar.tsx:48-76`
- Modify: `app/src/assets/AssetToolbar.test.tsx`

**Interfaces:**
- Consumes: Task 2의 `WindowControls`
- Produces: `.asset-toolbar` header에 `data-tauri-drag-region` 속성, 우측에 `<WindowControls />`

- [ ] **Step 1: 실패하는 테스트 추가**

`app/src/assets/AssetToolbar.test.tsx`에 추가:

```tsx
it("acts as the window title bar with drag region and window controls", () => {
  const { container } = render(<AssetToolbar {...baseProps} />);
  const header = container.querySelector(".asset-toolbar")!;
  expect(header).toHaveAttribute("data-tauri-drag-region");
  expect(screen.getByRole("button", { name: "창 최소화" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/assets/AssetToolbar.test.tsx`
Expected: FAIL — `data-tauri-drag-region` 없음, 창 제어 버튼 없음

- [ ] **Step 3: AssetToolbar에 WindowControls와 드래그 영역 추가**

`app/src/assets/AssetToolbar.tsx`:
- import에 `WindowControls` 추가: `import { WindowControls } from "../layout/WindowControls";`
- `<header className="asset-toolbar" role="toolbar" aria-label="자산 도구">`를 `<header className="asset-toolbar" role="toolbar" aria-label="자산 도구" data-tauri-drag-region>`로 변경
- `</div>`(controls) 뒤, `</header>` 앞에 `<WindowControls />` 추가

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/assets/AssetToolbar.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/assets/AssetToolbar.tsx app/src/assets/AssetToolbar.test.tsx
git commit -m "feat: make the asset toolbar the window title bar"
```

---

### Task 5: 나머지 뷰 툴바에 WindowControls와 드래그 영역 추가

**Files:**
- Modify: `app/src/similarity/SimilarityReviewBrowser.tsx:76-79`
- Modify: `app/src/safety/TrashBrowser.tsx:144-147`
- Modify: `app/src/settings/SettingsView.tsx:64-66`
- Modify: `app/src/similarity/SimilarityReviewBrowser.test.tsx`
- Modify: `app/src/safety/TrashBrowser.test.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx` (없으면 신규)

**Interfaces:**
- Consumes: Task 2의 `WindowControls`
- Produces: 3개 뷰 툴바 header에 `data-tauri-drag-region` + `<WindowControls />`

- [ ] **Step 1: 각 뷰 툴바에 WindowControls와 드래그 영역 추가**

`app/src/similarity/SimilarityReviewBrowser.tsx`:
- import 추가: `import { WindowControls } from "../layout/WindowControls";`
- `<header className="similarity-review__toolbar">` → `<header className="similarity-review__toolbar" data-tauri-drag-region>`
- 닫기 버튼 뒤에 `<WindowControls />` 추가

`app/src/safety/TrashBrowser.tsx`:
- import 추가: `import { WindowControls } from "../layout/WindowControls";`
- `<header className="trash-browser__toolbar">` → `<header className="trash-browser__toolbar" data-tauri-drag-region>`
- "휴지통 비우기" 버튼 뒤에 `<WindowControls />` 추가

`app/src/settings/SettingsView.tsx`:
- import 추가: `import { WindowControls } from "../layout/WindowControls";`
- `<header className="settings-view__toolbar">` → `<header className="settings-view__toolbar" data-tauri-drag-region>`
- 헤더 div 뒤에 `<WindowControls />` 추가

- [ ] **Step 2: 각 뷰 테스트에 드래그 영역/창 제어 검증 추가**

`app/src/similarity/SimilarityReviewBrowser.test.tsx`에 추가:

```tsx
it("acts as the window title bar", () => {
  const gateway = reviewGateway();
  const { container } = render(<SimilarityReviewBrowser gateway={gateway} onCountChange={vi.fn()} onClose={vi.fn()} />);
  expect(container.querySelector(".similarity-review__toolbar")).toHaveAttribute("data-tauri-drag-region");
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});
```

`app/src/safety/TrashBrowser.test.tsx`에 추가:

```tsx
it("acts as the window title bar", () => {
  const gateway = createGateway();
  const { container } = render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);
  expect(container.querySelector(".trash-browser__toolbar")).toHaveAttribute("data-tauri-drag-region");
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});
```

`app/src/settings/SettingsView.test.tsx` 신규 생성:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { SettingsView } from "./SettingsView";

afterEach(cleanup);

it("acts as the window title bar", () => {
  const gateway = createGateway();
  const { container } = render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );
  expect(container.querySelector(".settings-view__toolbar")).toHaveAttribute("data-tauri-drag-region");
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});

function createGateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(), currentLibrary: vi.fn(), listClassifications: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    setAssetClassifications: vi.fn(), patchAssetClassifications: vi.fn(), getAssetClassifications: vi.fn(), ingestMedia: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(),
    trashAsset: vi.fn(), trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn().mockResolvedValue([]),
    restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
  };
}
```

- [ ] **Step 3: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/similarity/SimilarityReviewBrowser.test.tsx src/safety/TrashBrowser.test.tsx src/settings/SettingsView.test.tsx`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add app/src/similarity/SimilarityReviewBrowser.tsx app/src/safety/TrashBrowser.tsx app/src/settings/SettingsView.tsx app/src/similarity/SimilarityReviewBrowser.test.tsx app/src/safety/TrashBrowser.test.tsx app/src/settings/SettingsView.test.tsx
git commit -m "feat: make all view toolbars the window title bar"
```

---

### Task 6: 사이드바 헤딩에 드래그 영역 추가

**Files:**
- Modify: `app/src/classification/ClassificationSidebar.tsx:231-236`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`

**Interfaces:**
- Consumes: 없음
- Produces: `.classification-sidebar__heading`에 `data-tauri-drag-region` 속성

- [ ] **Step 1: 실패하는 테스트 추가**

`app/src/classification/ClassificationSidebar.test.tsx`에 추가:

```tsx
it("makes the sidebar heading a window drag region", () => {
  const { container } = render(<ClassificationSidebar ... />);
  expect(container.querySelector(".classification-sidebar__heading")).toHaveAttribute("data-tauri-drag-region");
});
```

(기존 테스트의 props 패턴에 맞게 조정)

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/classification/ClassificationSidebar.test.tsx`
Expected: FAIL — 속성 없음

- [ ] **Step 3: 헤딩에 드래그 영역 추가**

`app/src/classification/ClassificationSidebar.tsx:231`:

```tsx
<div className="classification-sidebar__heading" data-tauri-drag-region>
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/classification/ClassificationSidebar.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx
git commit -m "feat: make the sidebar heading a window drag region"
```

---

### Task 7: 레트로 툴바 스타일 토큰 추가

**Files:**
- Modify: `app/src/styles/tokens.css`

**Interfaces:**
- Consumes: 없음
- Produces: `--bevel-light`, `--bevel-dark`, `--toolbar-title-font` 토큰

- [ ] **Step 1: 토큰 추가**

`app/src/styles/tokens.css`의 `:root` 블록에 추가:

```css
--bevel-light: #2b2f35;
--bevel-dark: #0c0e11;
--toolbar-title-font: "Cascadia Mono", "Consolas", monospace;
```

- [ ] **Step 2: 토큰 존재 검증 테스트 추가**

`app/src/layout/AppShell.test.tsx`에 추가:

```tsx
it("defines retro toolbar tokens", () => {
  const tokens = readFileSync(`${appRoot}/src/styles/tokens.css`, "utf8");
  expect(tokens).toContain("--bevel-light:");
  expect(tokens).toContain("--bevel-dark:");
  expect(tokens).toContain("--toolbar-title-font:");
});
```

- [ ] **Step 3: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/layout/AppShell.test.tsx`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add app/src/styles/tokens.css app/src/layout/AppShell.test.tsx
git commit -m "style: add retro bevel and title font tokens"
```

---

### Task 8: 툴바와 버튼에 레트로 베벨 적용

**Files:**
- Modify: `app/src/styles/global.css` (`.asset-toolbar`, `.similarity-review__toolbar`, `.ui-button` 룰)

**Interfaces:**
- Consumes: Task 7의 `--bevel-light`, `--bevel-dark`, `--toolbar-title-font`
- Produces: 레트로 스타일의 툴바와 버튼

- [ ] **Step 1: 툴바 베벨과 타이틀 폰트 적용**

`app/src/styles/global.css`의 `.asset-toolbar` 룰(608-618)을 수정:

```css
.asset-toolbar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: var(--toolbar-height);
  padding: 0 var(--space-3);
  background: var(--color-toolbar);
  border-top: var(--border-width) solid var(--bevel-light);
  border-bottom: var(--border-width) solid var(--bevel-dark);
}
```

`.asset-toolbar h2` 룰(620-625)을 수정:

```css
.asset-toolbar h2 {
  margin: 0;
  font-family: var(--toolbar-title-font);
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
```

`.similarity-review__toolbar` 룰(1236-1244)도 동일하게 베벨 적용:

```css
.similarity-review__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: var(--toolbar-height);
  padding: 0 var(--space-3);
  background: var(--color-toolbar);
  border-top: var(--border-width) solid var(--bevel-light);
  border-bottom: var(--border-width) solid var(--bevel-dark);
}
```

- [ ] **Step 2: 버튼 인셋 베벨 적용**

`.ui-button` 룰(116-130)에 인셋 베벨 추가:

```css
.ui-button,
.ui-menu__trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--control-height-md);
  padding: 0 var(--space-3);
  color: var(--color-text);
  background: var(--color-surface-hover);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: inset 0 1px 0 var(--bevel-light), inset 0 -1px 0 var(--bevel-dark);
  cursor: pointer;
  font-size: 0.75rem;
  gap: var(--space-compact);
}
```

- [ ] **Step 3: CSS 검증 테스트 추가**

`app/src/layout/AppShell.test.tsx`에 추가:

```tsx
it("applies retro bevels to toolbars and buttons", () => {
  expect(declarations(".asset-toolbar")).toContain("border-top: var(--border-width) solid var(--bevel-light);");
  expect(declarations(".asset-toolbar h2")).toContain("font-family: var(--toolbar-title-font);");
  expect(declarations(".ui-button")).toContain("box-shadow: inset 0 1px 0 var(--bevel-light), inset 0 -1px 0 var(--bevel-dark);");
});
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/layout/AppShell.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/styles/global.css app/src/layout/AppShell.test.tsx
git commit -m "style: apply retro bevels to toolbars and buttons"
```

---

### Task 9: 전체 검증

**Files:**
- 없음 (검증만)

**Interfaces:**
- Consumes: 모든 이전 Task
- Produces: 최종 검증 결과

- [ ] **Step 1: 전체 테스트 실행**

Run: `npm test`
Expected: 30개 테스트 파일, 216+개 테스트 모두 PASS

- [ ] **Step 2: 타입 검사**

Run: `npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 3: git 상태 확인**

Run: `git status --short`
Expected: `manual-skill-commands.txt`와 `.lnk` 파일만 남음 (커밋 제외 대상)

- [ ] **Step 4: 커밋 로그 확인**

Run: `git log --oneline -10`
Expected: 8개 구현 커밋 + 설계 문서 커밋이 순서대로 표시
