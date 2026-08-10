# 공통 ViewToolbar 모듈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 5개 뷰 툴바를 공통 `ViewToolbar` 컴포넌트로 통합해, 새 탭이 생길 때 창 제어 버튼·드래그 영역·레트로 스타일을 반복 구현하지 않게 한다.

**Architecture:** `app/src/layout/ViewToolbar.tsx` 신규 — `title` + `children`(좌측 컨텐츠) + `actions`(우측 액션) + `WindowControls` 자동 포함 + `data-tauri-drag-region` 자동 부여. 5개 뷰(자산/유사 검토/휴지통/설정/망가)의 툴바 JSX를 `ViewToolbar` 조합으로 교체하고, CSS 공통 룰을 `.view-toolbar`로 통합한다.

**Tech Stack:** React 19, TypeScript, Vitest, CSS custom properties.

## Global Constraints

- 모든 UI 텍스트는 한국어를 유지한다.
- 새 외부 의존성 추가 금지.
- `WindowControls`는 `ViewToolbar`가 항상 우측 끝에 자동 포함한다 (각 뷰에서 직접 렌더하지 않는다).
- `data-tauri-drag-region`은 header와 h2에 자동 부여한다 (인터랙티브 컨트롤에는 부여하지 않는다).
- 테스트: `npm test`(vitest run)는 `C:\chatgpt\app`에서, 타입 검사는 `npx tsc --noEmit`를 `C:\chatgpt\app`에서 실행.
- 기존 뷰 테스트의 툴바 관련 검증(aria-label, 버튼)은 유지되어야 한다.

---

### Task 1: ViewToolbar 컴포넌트 생성

**Files:**
- Create: `app/src/layout/ViewToolbar.tsx`
- Create: `app/src/layout/ViewToolbar.test.tsx`

**Interfaces:**
- Consumes: `WindowControls` from `app/src/layout/WindowControls.tsx`
- Produces: `ViewToolbar` — props `{ title: string; ariaLabel?: string; children?: ReactNode; actions?: ReactNode }`. 렌더: `<header className="view-toolbar" role="toolbar" aria-label={ariaLabel} data-tauri-drag-region><h2 data-tauri-drag-region>{title}</h2>{children && <div className="view-toolbar__content">{children}</div>}<div className="view-toolbar__actions">{actions}<WindowControls /></div></header>` (ariaLabel 없으면 aria-label 속성 생략)

- [ ] **Step 1: 실패하는 테스트 작성**

`app/src/layout/ViewToolbar.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ViewToolbar } from "./ViewToolbar";

afterEach(cleanup);

describe("ViewToolbar", () => {
  it("renders the title with a drag region", () => {
    const { container } = render(<ViewToolbar title="망가" />);
    const header = container.querySelector(".view-toolbar")!;
    expect(header).toHaveAttribute("data-tauri-drag-region");
    expect(container.querySelector(".view-toolbar h2")).toHaveAttribute("data-tauri-drag-region");
    expect(screen.getByRole("heading", { name: "망가" })).toBeInTheDocument();
  });

  it("places children on the left and actions on the right", () => {
    render(<ViewToolbar title="T" actions={<button type="button">새로고침</button>}>좌측 내용</ViewToolbar>);
    expect(screen.getByText("좌측 내용")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새로고침" })).toBeInTheDocument();
  });

  it("always includes the window controls", () => {
    render(<ViewToolbar title="T" />);
    expect(screen.getByRole("button", { name: "창 최소화" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
  });

  it("exposes the toolbar role with the given label", () => {
    render(<ViewToolbar title="T" ariaLabel="자산 도구" />);
    expect(screen.getByRole("toolbar", { name: "자산 도구" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/layout/ViewToolbar.test.tsx`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: ViewToolbar 구현**

`app/src/layout/ViewToolbar.tsx`:

```tsx
import type { ReactNode } from "react";
import { WindowControls } from "./WindowControls";

type ViewToolbarProps = {
  title: string;
  ariaLabel?: string;
  children?: ReactNode;
  actions?: ReactNode;
};

export function ViewToolbar({ title, ariaLabel, children, actions }: ViewToolbarProps) {
  return (
    <header className="view-toolbar" role="toolbar" aria-label={ariaLabel} data-tauri-drag-region>
      <h2 data-tauri-drag-region>{title}</h2>
      {children && <div className="view-toolbar__content">{children}</div>}
      <div className="view-toolbar__actions">
        {actions}
        <WindowControls />
      </div>
    </header>
  );
}
```

> **주의:** `aria-label={undefined}`이면 React가 aria-label 속성을 렌더하지 않으므로, ariaLabel prop이 없는 뷰(망가/휴지통/설정/유사 검토)는 aria-label이 없는 toolbar가 된다. 기존 테스트가 해당 뷰의 toolbar role을 검증하지 않으므로 문제없다.

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/layout/ViewToolbar.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/layout/ViewToolbar.tsx app/src/layout/ViewToolbar.test.tsx
git commit -m "feat: add shared view toolbar component"
```

---

### Task 2: CSS 통합 — .view-toolbar 룰

**Files:**
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: Task 1의 `.view-toolbar` 클래스 구조
- Produces: `.view-toolbar` 공통 룰 (높이/배경/베벨/타이틀 폰트/레이아웃)

- [ ] **Step 1: 공통 룰 작성**

`global.css`의 `.asset-toolbar` 룰(609-630 근처)을 `.view-toolbar`로 대체:

```css
.view-toolbar {
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

.view-toolbar h2 {
  margin: 0;
  font-family: var(--toolbar-title-font);
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.view-toolbar__content {
  display: flex;
  align-items: center;
  gap: var(--space-compact);
  flex: 1;
  justify-content: flex-start;
  min-width: 0;
  white-space: nowrap;
}

.view-toolbar__content > * {
  flex-shrink: 0;
}

.view-toolbar__actions {
  display: flex;
  align-items: center;
  gap: var(--space-compact);
  flex-shrink: 0;
}
```

- [ ] **Step 2: 기존 툴바 룰 제거/이관**

- `.asset-toolbar` 룰(609-618), `.asset-toolbar h2`(620-625), `.asset-toolbar__controls`(632-654)를 제거하고 위 `.view-toolbar` 룰로 대체.
- `.asset-toolbar .ui-select > span` 등 레트로 컨트롤 룰(656-775)의 셀렉터를 `.asset-toolbar` → `.view-toolbar`로 이관 (예: `.view-toolbar .ui-select select`).
- `.asset-toolbar .ui-menu__trigger` → `.view-toolbar .ui-menu__trigger`.
- `.similarity-review__toolbar` 룰(1378-1397) 제거 — `.view-toolbar`로 대체. `.similarity-review__toolbar > div`(진행률 배치)는 `.view-toolbar__content`로 이관.
- `.manga-browser__toolbar` 룰(1461-1468) 제거 — `.view-toolbar`로 대체.
- `.trash-browser__toolbar`(1322-1338), `.settings-view__toolbar`(894-906) 룰 제거 — `.view-toolbar`로 대체 (배경 없는 평면 행이었던 것들이 통합 후 동일한 툴바 스타일을 받음).

- [ ] **Step 3: CSS 존재 검증 테스트 추가**

`app/src/layout/AppShell.test.tsx`에 추가 (기존 `declarations` 헬퍼 사용):

```tsx
it("styles the shared view toolbar", () => {
  expect(declarations(".view-toolbar")).toContain("min-height: var(--toolbar-height);");
  expect(declarations(".view-toolbar h2")).toContain("font-family: var(--toolbar-title-font);");
  expect(declarations(".view-toolbar__content")).toContain("flex: 1;");
});
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/layout/AppShell.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/styles/global.css app/src/layout/AppShell.test.tsx
git commit -m "style: unify view toolbar styles under .view-toolbar"
```

---

### Task 3: MangaBrowser 툴바 이관

**Files:**
- Modify: `app/src/manga/MangaBrowser.tsx:62-67`
- Modify: `app/src/manga/MangaBrowser.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `ViewToolbar`
- Produces: 망가 뷰가 `ViewToolbar title="망가" actions={<Button>새로고침</Button>}` 사용

- [ ] **Step 1: 실패하는 테스트 추가**

`app/src/manga/MangaBrowser.test.tsx`에 추가:

```tsx
it("uses the shared view toolbar with window controls", () => {
  const gateway = createGateway({ root: "C:\\manga", series });
  const { container } = render(<LibraryProvider gateway={gateway}><MangaBrowser /></LibraryProvider>);
  expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/manga/MangaBrowser.test.tsx`
Expected: FAIL — `.view-toolbar` 없음

- [ ] **Step 3: MangaBrowser 툴바 교체**

`MangaBrowser.tsx`:
- import 추가: `import { ViewToolbar } from "../layout/ViewToolbar";`
- `manga-browser__toolbar` div(64-67)를 교체:

```tsx
<ViewToolbar title="망가" actions={<Button size="sm" onClick={() => void scan()}>새로고침</Button>} />
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/manga/MangaBrowser.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/manga/MangaBrowser.tsx app/src/manga/MangaBrowser.test.tsx
git commit -m "refactor: use the shared view toolbar in the manga browser"
```

---

### Task 4: SimilarityReviewBrowser 툴바 이관

**Files:**
- Modify: `app/src/similarity/SimilarityReviewBrowser.tsx:76-81`
- Modify: `app/src/similarity/SimilarityReviewBrowser.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `ViewToolbar`
- Produces: 유사 검토 뷰가 `ViewToolbar title="유사 검토" children={진행률} actions={닫기}` 사용

- [ ] **Step 1: 실패하는 테스트 추가**

`app/src/similarity/SimilarityReviewBrowser.test.tsx`에 추가:

```tsx
it("uses the shared view toolbar with window controls", () => {
  const gateway = reviewGateway();
  const { container } = render(<SimilarityReviewBrowser gateway={gateway} onCountChange={vi.fn()} onClose={vi.fn()} />);
  expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/similarity/SimilarityReviewBrowser.test.tsx`
Expected: FAIL — `.view-toolbar` 없음

- [ ] **Step 3: SimilarityReviewBrowser 툴바 교체**

`SimilarityReviewBrowser.tsx`:
- import 추가: `import { ViewToolbar } from "../layout/ViewToolbar";`
- `WindowControls` import 제거 (ViewToolbar가 포함).
- header(77-81)를 교체:

```tsx
<ViewToolbar
  title="유사 검토"
  children={review && initialTotal > 0 ? <span>{current} / {initialTotal}</span> : undefined}
  actions={<Button size="icon" variant="ghost" aria-label="유사 검토 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>}
/>
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/similarity/SimilarityReviewBrowser.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/similarity/SimilarityReviewBrowser.tsx app/src/similarity/SimilarityReviewBrowser.test.tsx
git commit -m "refactor: use the shared view toolbar in the similarity review"
```

---

### Task 5: TrashBrowser 툴바 이관

**Files:**
- Modify: `app/src/safety/TrashBrowser.tsx:144-149`
- Modify: `app/src/safety/TrashBrowser.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `ViewToolbar`
- Produces: 휴지통 뷰가 `ViewToolbar title="휴지통" children={설명} actions={비우기}` 사용

- [ ] **Step 1: 실패하는 테스트 추가**

`app/src/safety/TrashBrowser.test.tsx`에 추가:

```tsx
it("uses the shared view toolbar with window controls", () => {
  const gateway = createGateway();
  const { container } = render(<LibraryProvider gateway={gateway}><TrashBrowser /></LibraryProvider>);
  expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/safety/TrashBrowser.test.tsx`
Expected: FAIL — `.view-toolbar` 없음

- [ ] **Step 3: TrashBrowser 툴바 교체**

`TrashBrowser.tsx`:
- import 추가: `import { ViewToolbar } from "../layout/ViewToolbar";`
- `WindowControls` import 제거.
- header(145-149)를 교체:

```tsx
<ViewToolbar
  title="휴지통"
  children={<p>복원할 수 있는 자산을 보관합니다.</p>}
  actions={<Button variant="danger" onClick={() => setConfirmEmpty(true)} disabled={!page || page.totalCount === 0 || mutationPending}>휴지통 비우기</Button>}
/>
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/safety/TrashBrowser.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/safety/TrashBrowser.tsx app/src/safety/TrashBrowser.test.tsx
git commit -m "refactor: use the shared view toolbar in the trash browser"
```

---

### Task 6: SettingsView 툴바 이관

**Files:**
- Modify: `app/src/settings/SettingsView.tsx:84-88`
- Modify: `app/src/settings/SettingsView.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `ViewToolbar`
- Produces: 설정 뷰가 `ViewToolbar title="설정" children={설명}` 사용

- [ ] **Step 1: 실패하는 테스트 추가**

`app/src/settings/SettingsView.test.tsx`에 추가:

```tsx
it("uses the shared view toolbar with window controls", () => {
  const gateway = createGateway();
  const { container } = render(
    <LibraryProvider gateway={gateway}>
      <SettingsView restoring={false} onRestore={vi.fn()} onExit={vi.fn()} />
    </LibraryProvider>,
  );
  expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/settings/SettingsView.test.tsx`
Expected: FAIL — `.view-toolbar` 없음

- [ ] **Step 3: SettingsView 툴바 교체**

`SettingsView.tsx`:
- import 추가: `import { ViewToolbar } from "../layout/ViewToolbar";`
- `WindowControls` import 제거.
- header(85-88)를 교체:

```tsx
<ViewToolbar title="설정" children={<p>라이브러리 폴더, 안전 설정과 단축키를 확인합니다.</p>} />
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/settings/SettingsView.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add app/src/settings/SettingsView.tsx app/src/settings/SettingsView.test.tsx
git commit -m "refactor: use the shared view toolbar in the settings view"
```

---

### Task 7: AssetToolbar 툴바 이관

**Files:**
- Modify: `app/src/assets/AssetToolbar.tsx:49-78`
- Modify: `app/src/assets/AssetToolbar.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `ViewToolbar`
- Produces: 자산 뷰가 `ViewToolbar title={location} children={컨트롤}` 사용 (actions 없음)

- [ ] **Step 1: 실패하는 테스트 추가**

`app/src/assets/AssetToolbar.test.tsx`에 추가:

```tsx
it("uses the shared view toolbar with window controls", () => {
  const { container } = render(<AssetToolbar {...baseProps} />);
  expect(container.querySelector(".view-toolbar")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "창 닫기" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `npm test -- --run src/assets/AssetToolbar.test.tsx`
Expected: FAIL — `.view-toolbar` 없음

- [ ] **Step 3: AssetToolbar 툴바 교체**

`AssetToolbar.tsx`:
- import 추가: `import { ViewToolbar } from "../layout/ViewToolbar";`
- `WindowControls` import 제거.
- return(49-78)을 교체:

```tsx
return (
  <ViewToolbar title={location} ariaLabel="자산 도구">
    {selectedCount > 0 ? <>
      <strong>{selectedCount}개 선택</strong>
      <Select label="일괄 분류" value={batchClassificationId} disabled={batchPending} onChange={(event) => setBatchClassificationId(event.target.value)}>
        <option value="">분류 선택</option>
        {classifications.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </Select>
      <Button disabled={batchPending || !batchClassificationId} onClick={() => onClassification(batchClassificationId, "add")}>분류 추가</Button>
      <Button aria-label="좋아요 켜기" disabled={batchPending} onClick={() => onFavorite(true)}><StarIcon data-icon="inline-start" aria-hidden="true" />좋아요</Button>
      <Button aria-label="휴지통으로 이동" variant="danger" disabled={batchPending} onClick={onTrash}><TrashIcon data-icon="inline-start" aria-hidden="true" />휴지통</Button>
      <Menu label="추가 작업" items={overflowItems} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} />
      <Button aria-label={inspectorOpen ? "정보 닫기" : "정보 열기"} size="icon" variant={inspectorOpen ? "secondary" : "ghost"} onClick={onInspectorToggle}><InformationCircleIcon aria-hidden="true" /></Button>
      <Button aria-label="선택 해제" size="icon" variant="ghost" onClick={onClearSelection}><XMarkIcon aria-hidden="true" /></Button>
    </> : <>
      <Select label="정렬" value={recent ? "newest" : sort} disabled={recent} onChange={(event) => onSortChange(event.target.value as AssetSort)}>
        <option value="newest">최신순</option><option value="oldest">오래된순</option>
        <option value="favorites">좋아요순</option><option value="random">랜덤</option>
      </Select>
      {view.kind === "classification" && <Toggle aria-label="이 분류만" checked={directOnly} onChange={(event) => onDirectOnlyChange(event.target.checked)}><AdjustmentsHorizontalIcon aria-hidden="true" /><span className="asset-toolbar__toggle-text">이 분류만</span></Toggle>}
      <Slider label="미리보기 크기" min={96} max={320} step={8} value={thumbnailRowHeight} onChange={(event) => onThumbnailRowHeightChange(Number(event.target.value))} />
      <Toggle aria-label="정보 표시" checked={metadataVisible} onChange={(event) => onMetadataVisibleChange(event.target.checked)}><InformationCircleIcon aria-hidden="true" /><span className="asset-toolbar__toggle-text">정보 표시</span></Toggle>
      {sort === "random" && !recent && <Tooltip content="다시 섞기"><Button size="icon" aria-label="다시 섞기" onClick={onReshuffle}><ArrowPathIcon aria-hidden="true" /></Button></Tooltip>}
    </>}
  </ViewToolbar>
);
```

> **주의:** `asset-toolbar__toggle-text` 클래스는 유지 (CSS 셀렉터가 `.view-toolbar .ui-toggle`로 이관되지만 span 클래스명은 그대로). `role="toolbar" aria-label="자산 도구"`는 ViewToolbar의 `ariaLabel` prop으로 전달 (App.test.tsx:264가 `getByRole("toolbar", { name: "자산 도구" })`를 검증).

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `npm test -- --run src/assets/AssetToolbar.test.tsx`
Expected: PASS (기존 toolbar role 검증이 있다면 조정)

- [ ] **Step 5: 커밋**

```bash
git add app/src/assets/AssetToolbar.tsx app/src/assets/AssetToolbar.test.tsx
git commit -m "refactor: use the shared view toolbar in the asset toolbar"
```

---

### Task 8: 전체 검증

**Files:**
- 없음 (검증만)

**Interfaces:**
- Consumes: 모든 이전 Task
- Produces: 최종 검증 결과

- [ ] **Step 1: 전체 프론트 테스트 실행**

Run: `npm test` in `C:\chatgpt\app`
Expected: 전체 PASS (34+ 파일)

- [ ] **Step 2: 타입 검사**

Run: `npx tsc --noEmit` in `C:\chatgpt\app`
Expected: 오류 없음

- [ ] **Step 3: 잔여 툴바 클래스 확인**

Run: `Select-String -Path app/src/styles/global.css -Pattern "asset-toolbar|similarity-review__toolbar|trash-browser__toolbar|settings-view__toolbar|manga-browser__toolbar"`
Expected: `.view-toolbar`로 이관된 룰 외 잔여 없음 (뷰별 특수 룰만 남을 수 있음 — 예: `.asset-toolbar__toggle-text`는 span 클래스로 유지)

- [ ] **Step 4: git 상태 확인**

Run: `git status --short`
Expected: `manual-skill-commands.txt`와 `.lnk` 파일만 남음 (커밋 제외 대상)
