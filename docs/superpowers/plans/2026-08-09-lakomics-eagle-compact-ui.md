# Lakomics Eagle Compact UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 기능과 3단 구조를 유지하면서 Lakomics를 Eagle에 가까운 밀도 높은 Windows 미디어 관리 UI로 정돈하고, 외부 이미지 드롭 상태를 분명하게 만든다.

**Architecture:** 현재 `layout`, `classification`, `assets`, `ingestion`, `shared/ui`, `styles` 경계를 유지한다. 전역 토큰이 크기와 색상을 소유하고, shadcn/Radix 방식은 공통 오버레이 부품에만 적용하며 갤러리와 업무 상태는 기존 Module이 계속 소유한다.

**Tech Stack:** React 19, TypeScript 5.8, Vite 7, Vitest, Testing Library, Tauri 2, TanStack React Virtual, Radix UI primitives, plain CSS design tokens

## Global Constraints

- 사용자의 지시에 따라 서브에이전트를 사용하지 않고 현재 세션에서 순서대로 실행한다.
- Windows만 지원하며 Linux 전용 코드나 문서를 추가하지 않는다.
- 테스트용 라이브러리가 등록되지 않았으면 `C:\Users\namwoojun\Desktop\test`를 사용한다.
- 상단 도구 모음은 40px, 상태 표시줄은 24px, 사이드바 기본 너비는 208px, 조절 범위는 176~320px, 정보 패널은 272px을 사용한다.
- 갤러리 바깥 여백은 6px, 이미지 사이 간격은 4~6px, 일반 행과 컨트롤 높이는 28px을 기준으로 한다.
- 색상, 간격, 글자, 모서리 값은 `app/src/styles/tokens.css`가 소유하며 업무 컴포넌트에 반복해서 하드코딩하지 않는다.
- 전체 Tailwind 전환, shadcn 프리셋 초기화, `components.json` 도입은 하지 않는다.
- justified-row, 가상화, 정렬, 선택, 분류, 좋아요, 휴지통, 감상, 탐색기 복사 동작을 유지한다.
- 유사 이미지 판별 알고리즘과 컬렉션은 이번 계획에서 구현하지 않는다.
- 각 Task는 RED 테스트, 최소 구현, 관련 테스트, 빌드 또는 전체 검증, 독립 커밋 순서로 끝낸다.

## File Map

- `app/src/styles/tokens.css`: Eagle Compact 색상, 간격, 크기, 모서리의 단일 소유자
- `app/src/styles/global.css`: 토큰을 사용하는 shell, sidebar, toolbar, gallery, inspector, overlay 표현
- `app/src/shared/ui/Menu.tsx`: Radix dropdown/context menu 기반 공통 메뉴
- `app/src/shared/ui/Dialog.tsx`: Radix dialog 기반 공통 대화상자와 포커스 복귀
- `app/src/shared/ui/Tooltip.tsx`: 아이콘 버튼용 공통 툴팁
- `app/src/shared/ui/{Button,Select,Slider,Toggle,Toast}.tsx`: 기존 Interface를 유지하는 compact 공통 컨트롤
- `app/src/classification/ClassificationSidebar.tsx`: 빠른 보기, 분류 트리, 너비 조절만 소유
- `app/src/assets/AssetToolbar.tsx`: 일반/선택 상태 도구 모음 전환
- `app/src/assets/AssetBrowser.tsx`: 선택 상태와 정보 패널 자동 열기 규칙
- `app/src/assets/AssetInspector.tsx`: 단일/다중 선택 정보 표시와 직접 닫기
- `app/src/assets/AssetGallery.tsx`: 기존 가상화와 선택을 유지한 타일 표현
- `app/src/ingestion/{DropOverlay,WorkTray}.tsx`: 외부 드롭 진입과 수집 진행/실패 표시
- `app/src/ingestion/useFileDrop.ts`: FIFO 수집과 정확한 중복/실패 결과
- `app/src/app/App.tsx`: 드롭 가능 화면과 공통 상태 표시의 조립
- `app/README.md`: 실제 확인 절차와 테스트 라이브러리 경로

---

### Task 1: Eagle Compact 디자인 토큰과 기본 밀도

**Files:**
- Modify: `app/src/styles/tokens.css`
- Modify: `app/src/styles/global.css`
- Modify: `app/src/preferences/uiPreferences.ts`
- Modify: `app/src/preferences/uiPreferences.test.ts`
- Modify: `app/src/layout/AppShell.test.tsx`

**Interfaces:**
- Consumes: 기존 CSS class 이름과 `UiPreferences`
- Produces: `--toolbar-height`, `--statusbar-height`, `--sidebar-width-default`, `--inspector-width`, `--gallery-gap` 토큰과 새 기본 사이드바 너비

- [x] **Step 1: 환경설정 RED 테스트 작성**

`uiPreferences.test.ts`에는 저장값이 범위를 벗어날 때 176~320px로 제한되고 기본값이 208px인지 검증한다.

```ts
expect(DEFAULT_UI_PREFERENCES.sidebarWidth).toBe(208);
expect(loadUiPreferences(storageWith({ sidebarWidth: 100 })).sidebarWidth).toBe(176);
expect(loadUiPreferences(storageWith({ sidebarWidth: 400 })).sidebarWidth).toBe(320);
```

- [x] **Step 2: RED 확인**

Run: `cd app && npm.cmd test -- src/layout/AppShell.test.tsx src/preferences/uiPreferences.test.ts`

Expected: 기존 232px 기본값과 184~360px 제한 때문에 FAIL

- [x] **Step 3: 중앙 토큰과 기본값 변경**

`tokens.css`의 기준값을 다음처럼 바꾸고 `global.css`에서는 값 대신 변수만 사용한다.

```css
:root {
  --color-bg: #111316;
  --color-sidebar: #181b1f;
  --color-toolbar: #1b1e22;
  --color-surface: #202328;
  --color-surface-elevated: #202328;
  --color-surface-hover: #282c31;
  --color-text: #e7e9ec;
  --color-muted: #8e959f;
  --color-accent: #4e8df7;
  --color-border: #2b2f35;
  --color-danger: #e26767;
  --space-1: 4px;
  --space-compact: 6px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --radius-tile: 2px;
  --radius-sm: 4px;
  --radius-md: 8px;
  --control-height-sm: 28px;
  --control-height-md: 28px;
  --control-height-icon: 28px;
  --sidebar-width-default: 208px;
  --toolbar-height: 40px;
  --statusbar-height: 24px;
  --inspector-width: 272px;
  --gallery-gap: 6px;
}
```

`uiPreferences.ts`의 기본값과 clamp를 208, 176, 320으로 맞춘다.

CSS 토큰은 실행 로직이 아닌 시각 설정이므로 소스 문자열을 검사하는 가짜 테스트를 추가하지 않는다. Task 8에서 실제 1536px/960px 렌더링으로 도구 모음, 상태 표시줄, 사이드바, 정보 패널, 갤러리 간격을 검증한다. `AppShell.test.tsx`의 기존 viewport 제약 테스트만 유지한다.

- [x] **Step 4: GREEN 확인**

Run: `cd app && npm.cmd test -- src/layout/AppShell.test.tsx src/preferences/uiPreferences.test.ts`

Expected: PASS

- [x] **Step 5: 빌드와 커밋**

Run: `cd app && npm.cmd run build`

Expected: exit 0

```powershell
git add app/src/styles/tokens.css app/src/styles/global.css app/src/preferences/uiPreferences.ts app/src/preferences/uiPreferences.test.ts app/src/layout/AppShell.test.tsx
git commit -m "style: establish Eagle compact design tokens"
```

검증 기록 (2026-08-09): RED는 기존 기본값 232px, 상한 360px, 하한 184px을 각각 확인하며 3건 실패했다. GREEN은 `AppShell.test.tsx`와 `uiPreferences.test.ts`의 10개 테스트가 통과했고 `npm.cmd run build`가 exit 0이었다.

### Task 2: shadcn/Radix 공통 오버레이 부품

**Files:**
- Modify: `app/package.json`
- Modify: `app/package-lock.json`
- Modify: `app/src/shared/ui/Menu.tsx`
- Modify: `app/src/shared/ui/Menu.test.tsx`
- Create: `app/src/shared/ui/ContextMenu.tsx`
- Create: `app/src/shared/ui/ContextMenu.test.tsx`
- Modify: `app/src/shared/ui/Dialog.tsx`
- Create: `app/src/shared/ui/Dialog.test.tsx`
- Create: `app/src/shared/ui/Tooltip.tsx`
- Create: `app/src/shared/ui/Tooltip.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: 기존 `MenuItem`, `Dialog` 호출부와 분류 행의 우클릭 동작
- Produces: 버튼 전용 `Menu`, 행을 감싸는 `ContextMenu`, 기존 호출부와 호환되는 `Dialog`, `Tooltip({ content, children })`

- [x] **Step 1: 공통 부품 RED 테스트 작성**

기존 `Menu.test.tsx`의 버튼 열기, 키보드, 바깥 클릭, 포커스 복귀 검증을 유지한다. 외부 ref 좌표를 직접 계산하던 우클릭 테스트는 `ContextMenu.test.tsx`의 실제 trigger composition 테스트로 교체한다. `Dialog.test.tsx`와 `Tooltip.test.tsx`를 추가한다.

```tsx
it("returns focus to the opener after closing", async () => {
  const user = userEvent.setup();
  render(<DialogFixture />);
  const opener = screen.getByRole("button", { name: "열기" });
  await user.click(opener);
  await user.keyboard("{Escape}");
  expect(opener).toHaveFocus();
});

it("names an icon button without adding a permanent label", async () => {
  const user = userEvent.setup();
  render(<Tooltip content="다시 섞기"><button aria-label="다시 섞기">↻</button></Tooltip>);
  await user.hover(screen.getByRole("button", { name: "다시 섞기" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("다시 섞기");
});
```

- [x] **Step 2: RED 확인**

Run: `cd app && npm.cmd test -- src/shared/ui/Menu.test.tsx src/shared/ui/ContextMenu.test.tsx src/shared/ui/Dialog.test.tsx src/shared/ui/Tooltip.test.tsx`

Expected: `Tooltip` 모듈이 없고 새 Dialog 포커스 테스트가 아직 충족되지 않아 FAIL

- [x] **Step 3: 필요한 Radix 패키지만 설치**

Run: `cd app && npm.cmd install @radix-ui/react-context-menu @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-tooltip`

전체 shadcn CLI 초기화, Tailwind, class utility 의존성은 추가하지 않는다.

- [x] **Step 4: 기존 Interface를 보존한 wrapper 구현**

`MenuItem`은 `Menu`와 `ContextMenu`가 공유한다. `Menu`에서 `contextTarget`을 제거하고 버튼 trigger만 맡긴다.

```ts
export type MenuItem = {
  id: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

type MenuProps = {
  label: string;
  items: MenuItem[];
  trigger: ReactNode;
};

type ContextMenuProps = PropsWithChildren<{
  items: MenuItem[];
}>;
```

`ClassificationSidebar`의 tree row는 `<ContextMenu items={actions}>...</ContextMenu>`로 감싸고 내부의 `⋯` 버튼은 기존 `<Menu>`를 사용한다. 우클릭 좌표 계산, viewport clamp, document pointer listener는 모두 삭제한다.

`Dialog`도 `open`, `title`, `closeDisabled`, `variant`, `onKeyDown`, `onClose`를 유지한다. Radix Portal/Overlay/Content를 사용하고 닫힌 뒤 opener 포커스가 복귀하도록 한다.

`Tooltip`은 다음 Interface만 제공한다.

```ts
type TooltipProps = PropsWithChildren<{
  content: string;
  side?: "top" | "right" | "bottom" | "left";
}>;
```

Radix의 구조 class는 `ui-menu`, `ui-dialog`, `ui-tooltip`로 한정하고 색상과 간격은 전역 토큰을 사용한다.

- [x] **Step 5: GREEN 확인**

Run: `cd app && npm.cmd test -- src/shared/ui/Menu.test.tsx src/shared/ui/ContextMenu.test.tsx src/shared/ui/Dialog.test.tsx src/shared/ui/Tooltip.test.tsx src/classification/ClassificationSidebar.test.tsx src/safety/SafetyDialog.test.tsx`

Expected: PASS

- [x] **Step 6: 빌드와 커밋**

Run: `cd app && npm.cmd run build`

Expected: exit 0

```powershell
git add app/package.json app/package-lock.json app/src/shared/ui/Menu.tsx app/src/shared/ui/Menu.test.tsx app/src/shared/ui/ContextMenu.tsx app/src/shared/ui/ContextMenu.test.tsx app/src/shared/ui/Dialog.tsx app/src/shared/ui/Dialog.test.tsx app/src/shared/ui/Tooltip.tsx app/src/shared/ui/Tooltip.test.tsx app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/styles/global.css
git commit -m "refactor: adopt compact Radix overlay primitives"
```

검증 기록 (2026-08-09): RED는 `ContextMenu`와 `Tooltip` 부재, 기존 dialog Escape 상태 동기화로 실패했다. Radix의 modal 기본값과 jsdom focus 차이를 실제 패키지 소스와 분리해 수정한 뒤 관련 6개 파일의 27개 테스트가 통과했고 `npm.cmd run build`가 exit 0이었다.

### Task 3: 공통 컨트롤과 상단 도구 모음 정돈

**Files:**
- Modify: `app/src/shared/ui/Button.tsx`
- Modify: `app/src/shared/ui/Select.tsx`
- Modify: `app/src/shared/ui/Slider.tsx`
- Modify: `app/src/shared/ui/Toggle.tsx`
- Modify: `app/src/shared/ui/Toast.tsx`
- Modify: `app/src/assets/AssetToolbar.tsx`
- Create: `app/src/assets/AssetToolbar.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: 현재 `AssetToolbarProps`, `Button`, `Select`, `Slider`, `Toggle`, `Toast`, Task 2의 `Menu`와 `Tooltip`
- Produces: 일반 상태와 선택 상태가 한 줄에서 전환되는 40px `AssetToolbar`

- [x] **Step 1: 도구 모음 RED 테스트 작성**

```tsx
it("shows only everyday controls when nothing is selected", () => {
  renderToolbar({ selectedCount: 0 });
  expect(screen.getByRole("heading", { name: "전체 자산" })).toBeVisible();
  expect(screen.getByLabelText("정렬")).toBeVisible();
  expect(screen.getByLabelText("미리보기 크기")).toBeVisible();
  expect(screen.getByLabelText("정보 표시")).toBeVisible();
  expect(screen.queryByText(/개 선택/)).not.toBeInTheDocument();
});

it("replaces browsing controls with compact selection actions", () => {
  renderToolbar({ selectedCount: 3 });
  expect(screen.getByText("3개 선택")).toBeVisible();
  expect(screen.getByRole("button", { name: "좋아요 켜기" })).toBeVisible();
  expect(screen.getByRole("button", { name: "휴지통으로 이동" })).toBeVisible();
  expect(screen.queryByLabelText("정렬")).not.toBeInTheDocument();
});
```

좁은 폭 대응은 CSS 검증으로 `flex-wrap: nowrap`, `min-width: 0`, overflow 메뉴 class 존재를 확인한다.

- [x] **Step 2: RED 확인**

Run: `cd app && npm.cmd test -- src/assets/AssetToolbar.test.tsx`

Expected: 현재 버튼 이름과 표시 구성이 승인안과 달라 FAIL

- [x] **Step 3: 공통 컨트롤 외형 통일**

- `Button`의 기존 variant와 icon 접근성 제약은 유지한다.
- `Select`, `Slider`, `Toggle`의 기존 이벤트 Interface는 유지해 업무 호출부를 불필요하게 바꾸지 않는다.
- `Toast`는 `role="status"`와 선택적 실행 버튼을 유지한다.
- 높이, 패딩, 모서리, 색상은 토큰만 사용한다.
- 아이콘 전용 버튼은 Task 2의 `Tooltip`으로 감싼다.

- [x] **Step 4: 도구 모음 구현**

일반 상태는 위치, 정렬, 썸네일 크기, 정보 토글, 조건부 범위/랜덤 동작만 렌더링한다. 선택 상태는 선택 개수, 분류 선택, 좋아요 켜기, 휴지통, `추가 작업` 메뉴를 렌더링한다. 좋아요 끄기와 분류 제거는 `MenuItem[]`에 둔다.

```ts
const overflowItems: MenuItem[] = [
  { id: "remove-classification", label: "선택한 분류 제거", disabled: batchPending || !batchClassificationId, onSelect: () => onClassification(batchClassificationId, "remove") },
  { id: "favorite-off", label: "좋아요 끄기", disabled: batchPending, onSelect: () => onFavorite(false) },
];
```

위험 작업은 빨간 글자만 사용하고 도구 모음 전체를 빨간 버튼으로 채우지 않는다.

- [x] **Step 5: GREEN 확인**

Run: `cd app && npm.cmd test -- src/assets/AssetToolbar.test.tsx src/assets/AssetBrowser.test.tsx src/shared/ui/Menu.test.tsx`

Expected: PASS

- [x] **Step 6: 빌드와 커밋**

Run: `cd app && npm.cmd run build`

Expected: exit 0

```powershell
git add app/src/shared/ui/Button.tsx app/src/shared/ui/Select.tsx app/src/shared/ui/Slider.tsx app/src/shared/ui/Toggle.tsx app/src/shared/ui/Toast.tsx app/src/assets/AssetToolbar.tsx app/src/assets/AssetToolbar.test.tsx app/src/styles/global.css
git commit -m "style: compact the asset toolbar and controls"
```

검증 기록 (2026-08-09): RED는 기존 선택 도구 모음의 버튼 이름과 상시 노출 작업이 승인된 구성과 달라 2건 실패했다. 선택 해제와 자주 쓰는 작업은 바로 노출하고 분류 제거·좋아요 끄기는 `추가 작업` 메뉴로 옮긴 뒤 관련 3개 파일의 34개 테스트가 통과했고 `npm.cmd run build`가 exit 0이었다.

### Task 4: 사이드바 밀도와 너비 규칙

**Files:**
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: Task 1의 176~320px 토큰과 현재 분류 트리/드래그 Interface
- Produces: 28px 행, 최소 장식, 같은 키보드/드래그 동작을 갖는 사이드바

- [x] **Step 1: 사이드바 RED 테스트 작성**

```tsx
it("clamps pointer resizing to the approved compact range", async () => {
  const onSidebarWidthChange = vi.fn();
  renderSidebar({ sidebarWidth: 208, onSidebarWidthChange });
  const handle = screen.getByRole("separator", { name: "사이드바 너비 조절" });
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 208 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 50 });
  expect(onSidebarWidthChange).toHaveBeenLastCalledWith(176);
});
```

빠른 보기와 treeitem의 기존 키보드, 메뉴, 내부 드롭 테스트는 삭제하지 않는다.

- [x] **Step 2: RED 확인**

Run: `cd app && npm.cmd test -- src/classification/ClassificationSidebar.test.tsx`

Expected: 현재 184~360px 상수 때문에 FAIL

- [x] **Step 3: 사이드바 구현**

`MIN_SIDEBAR_WIDTH`와 `MAX_SIDEBAR_WIDTH`를 각각 176, 320으로 변경한다. resize handle에 `role="separator"`, `aria-orientation="vertical"`, `aria-label="사이드바 너비 조절"`을 부여한다. 빠른 보기와 트리 행은 28px 토큰을 공유하고, 선택 상태는 배경과 왼쪽 2px 강조선만 사용한다.

분류 추가, 설정, 휴지통, 백업 동작의 위치와 로직은 바꾸지 않는다.

- [x] **Step 4: GREEN 확인**

Run: `cd app && npm.cmd test -- src/classification/ClassificationSidebar.test.tsx src/app/App.test.tsx`

Expected: PASS

- [x] **Step 5: 빌드와 커밋**

Run: `cd app && npm.cmd run build`

Expected: exit 0

```powershell
git add app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/styles/global.css
git commit -m "style: tighten the classification sidebar"
```

검증 기록 (2026-08-09): RED는 기존 손잡이 이름과 184~360px 범위 때문에 실패했다. 저장 설정과 포인터 조절이 같은 `clampSidebarWidth` 규칙을 사용하도록 중복을 제거하고 선택 강조선·간격을 정돈한 뒤 관련 3개 파일의 45개 테스트가 통과했고 `npm.cmd run build`가 exit 0이었다. Radix 전환 후 남아 있던 App 통합 테스트의 네이티브 dialog 가정도 실제 Escape 동작 검증으로 교체했다.

### Task 5: 정보 패널 자동 열기와 좁은 창 동작

**Files:**
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/assets/AssetInspector.tsx`
- Modify: `app/src/assets/AssetInspector.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: `SelectionState`, `AssetInspector({ assets, open, onOpenChange })`
- Produces: 빈 선택에서 첫 선택으로 바뀔 때 자동 열리고 수동으로 닫을 수 있는 272px 패널

- [ ] **Step 1: 자동 열기 RED 테스트 작성**

```tsx
it("opens the inspector on the first selection and closes it when selection clears", async () => {
  const user = userEvent.setup();
  renderBrowserWithAssets();
  await user.click(screen.getByRole("option", { name: "a.png" }));
  expect(screen.getByRole("complementary", { name: "자산 정보" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "정보 닫기" }));
  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "b.png" }));
  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("option", { name: "b.png" }));
  expect(screen.getByRole("complementary", { name: "자산 정보" })).toBeVisible();
});
```

`AssetInspector.test.tsx`에는 자산이 없을 때 열기 버튼도 보이지 않고, 자산이 있는 상태에서 수동으로 닫은 뒤 열기 버튼으로 복귀하는 검증을 추가한다.

- [ ] **Step 2: RED 확인**

Run: `cd app && npm.cmd test -- src/assets/AssetBrowser.test.tsx src/assets/AssetInspector.test.tsx`

Expected: 현재 선택 시 자동으로 열리지 않아 FAIL

- [ ] **Step 3: 전이 기반 자동 열기 구현**

선택 개수의 이전 값을 ref로 보관하고 0에서 양수로 바뀔 때만 연다. 이 방식은 사용자가 패널을 닫아도 현재 선택이 유지되는 동안 다시 강제로 열지 않는다.

```ts
const previousSelectionCountRef = useRef(0);
useEffect(() => {
  const count = selection.ids.size;
  if (previousSelectionCountRef.current === 0 && count > 0) setInspectorOpen(true);
  if (count === 0) setInspectorOpen(false);
  previousSelectionCountRef.current = count;
}, [selection.ids.size]);
```

Escape는 전체화면 뷰어가 열려 있으면 기존 뷰어 처리가 우선하고, 그렇지 않으면 좁은 창의 정보 패널을 닫는다. 닫힌 패널의 열기 버튼은 선택 자산이 있을 때만 렌더링한다.

- [ ] **Step 4: GREEN 확인**

Run: `cd app && npm.cmd test -- src/assets/AssetBrowser.test.tsx src/assets/AssetInspector.test.tsx src/assets/AssetViewer.test.tsx`

Expected: PASS

- [ ] **Step 5: 빌드와 커밋**

Run: `cd app && npm.cmd run build`

Expected: exit 0

```powershell
git add app/src/assets/AssetBrowser.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetInspector.tsx app/src/assets/AssetInspector.test.tsx app/src/styles/global.css
git commit -m "feat: open asset details on first selection"
```

### Task 6: 갤러리 표면과 간격 개선

**Files:**
- Modify: `app/src/assets/AssetGallery.tsx`
- Modify: `app/src/assets/AssetGallery.test.tsx`
- Modify: `app/src/assets/justifiedRows.test.ts`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: 기존 `buildJustifiedRows`, TanStack virtualizer, `--gallery-gap`
- Produces: 6px 기준 간격, 2px 이하 타일 모서리, 레이아웃을 바꾸지 않는 선택 테두리

- [ ] **Step 1: 갤러리 RED 테스트 작성**

`getComputedStyle`과 `ResizeObserver` 경계만 제어하고 실제 `AssetGallery`가 6px gap을 렌더링하는지 검증한다. 메타데이터가 꺼졌을 때 overlay가 렌더링되지 않는 기존 동작을 유지한다.

```tsx
it("renders rows with the gallery gap supplied by computed styles", async () => {
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    getPropertyValue: (name: string) => name === "--gallery-gap" ? "6" : "",
  } as CSSStyleDeclaration);
  installResizeObserver({ width: 600 });
  const { container } = render(<AssetGallery items={[asset("a"), asset("b")]} />);
  await waitFor(() => expect(container.querySelector(".asset-gallery__row")).toHaveStyle({ gap: "6px" }));
});
```

- [ ] **Step 2: RED 확인**

Run: `cd app && npm.cmd test -- src/assets/AssetGallery.test.tsx src/assets/justifiedRows.test.ts`

Expected: 현재 `--space-2`를 읽기 때문에 FAIL

- [ ] **Step 3: 최소 구현**

`useGalleryMetrics`는 `--gallery-gap`을 읽는다. `.asset-gallery__scroll`에 6px 바깥 padding을 주고 virtualizer 폭 계산에는 좌우 padding이 중복 반영되지 않도록 실제 content width를 사용한다. 타일 모서리는 `--radius-tile`, 선택선은 안쪽 outline을 사용한다. hover에서 이미지 크기나 위치를 움직이는 transform은 추가하지 않는다.

가상화의 `VIRTUAL_OVERSCAN_ROWS = 3`, 다음 페이지 기준, 정렬 및 DB 조회는 변경하지 않는다.

- [ ] **Step 4: GREEN과 성능 회귀 확인**

Run: `cd app && npm.cmd test -- src/assets/AssetGallery.test.tsx src/assets/justifiedRows.test.ts src/assets/AssetBrowser.test.tsx`

Expected: PASS

- [ ] **Step 5: 빌드와 커밋**

Run: `cd app && npm.cmd run build`

Expected: exit 0

```powershell
git add app/src/assets/AssetGallery.tsx app/src/assets/AssetGallery.test.tsx app/src/assets/justifiedRows.test.ts app/src/styles/global.css
git commit -m "style: make the asset gallery content-first"
```

### Task 7: 외부 드롭과 작업 상태의 Eagle Compact 표현

**Files:**
- Modify: `app/src/ingestion/DropOverlay.tsx`
- Modify: `app/src/ingestion/DropOverlay.test.tsx`
- Modify: `app/src/ingestion/WorkTray.tsx`
- Modify: `app/src/ingestion/WorkTray.test.tsx`
- Modify: `app/src/ingestion/useFileDrop.ts`
- Modify: `app/src/ingestion/useFileDrop.test.ts`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: `FileDropState`, `IngestionWork`, 기존 `dropEnabled`
- Produces: 드롭 진입 테두리, `여기에 놓아 추가` 안내, 정확한 중복/실패/재시도 상태

- [ ] **Step 1: 드롭 상태 RED 테스트 작성**

```tsx
it("uses a quiet edge highlight and generic drop instruction", () => {
  render(<DropOverlay over={{ x: 10, y: 20 }} destinationName="게임" />);
  expect(screen.getByRole("status")).toHaveTextContent("여기에 놓아 추가");
  expect(screen.getByRole("status")).toHaveTextContent("게임");
  expect(screen.getByRole("status")).toHaveTextContent("JPEG · PNG · GIF · WebP");
});

it("keeps failed names private and retries only the failed batch", async () => {
  // 기존 테스트의 C:\\private\\broken.png 입력을 유지한다.
  expect(screen.getByText("broken.png")).toBeVisible();
  expect(screen.queryByText(/C:\\private/)).not.toBeInTheDocument();
});
```

`useFileDrop.test.ts`에는 정확한 중복 결과가 새 자산 refresh를 요구하지 않고 `exact_duplicate` 메시지를 한 번만 보내는 기존 계약을 명시한다. `App.test.tsx`에는 trash/safety/maintenance에서 드롭이 비활성화되는 검증을 유지한다.

- [ ] **Step 2: RED 확인**

Run: `cd app && npm.cmd test -- src/ingestion/DropOverlay.test.tsx src/ingestion/WorkTray.test.tsx src/ingestion/useFileDrop.test.ts src/app/App.test.tsx`

Expected: DropOverlay 문구와 새 상태 class가 없어 FAIL

- [ ] **Step 3: 오버레이와 작업창 구현**

`DropOverlay`는 현재 destination과 지원 형식을 표시하되 전체 화면을 불투명하게 가리지 않는다.

```tsx
return <div className="drop-overlay" role="status" aria-live="polite">
  <div className="drop-overlay__message">
    <strong>여기에 놓아 추가</strong>
    <span>{destinationName} · JPEG · PNG · GIF · WebP</span>
  </div>
</div>;
```

`WorkTray`는 running/failed만 표시하고 완료 성공은 기존 Toast가 맡는다. 실패 경로는 `fileName()`으로만 표시한다. `useFileDrop`의 FIFO, classification snapshot, retry context는 바꾸지 않고 한국어 결과 문구와 정확한 중복 1회 통지만 정돈한다.

CSS는 `inset: var(--space-compact)`, 2px accent outline, 투명한 내부 배경을 사용한다. 중앙 메시지에만 작은 떠 있는 표면을 사용한다.

- [ ] **Step 4: GREEN 확인**

Run: `cd app && npm.cmd test -- src/ingestion/DropOverlay.test.tsx src/ingestion/WorkTray.test.tsx src/ingestion/useFileDrop.test.ts src/app/App.test.tsx`

Expected: PASS

- [ ] **Step 5: 빌드와 커밋**

Run: `cd app && npm.cmd run build`

Expected: exit 0

```powershell
git add app/src/ingestion/DropOverlay.tsx app/src/ingestion/DropOverlay.test.tsx app/src/ingestion/WorkTray.tsx app/src/ingestion/WorkTray.test.tsx app/src/ingestion/useFileDrop.ts app/src/ingestion/useFileDrop.test.ts app/src/app/App.test.tsx app/src/styles/global.css
git commit -m "style: clarify external file drop feedback"
```

### Task 8: 전체 회귀 검증과 실제 화면 승인

**Files:**
- Modify: `app/README.md`
- Modify: `docs/superpowers/plans/2026-08-09-lakomics-eagle-compact-ui.md`
- Create: `.acceptance/eagle-compact-normal.png`
- Create: `.acceptance/eagle-compact-narrow.png`
- Create: `.acceptance/eagle-compact-drop.png`

**Interfaces:**
- Consumes: Tasks 1~7의 완성된 UI와 기존 Tauri acceptance 설정
- Produces: 자동 검증 로그, 1536px/960px/드롭 화면 증거, 사용자 시각 승인 기록

- [ ] **Step 1: 전체 자동 검증**

Run: `cd app && npm.cmd run check`

Expected: 모든 Vitest 파일 PASS, TypeScript와 Vite build exit 0

- [ ] **Step 2: 일반 창 실제 검증**

디버그 앱을 `C:\Users\namwoojun\Desktop\test` 라이브러리로 실행한다. 1536px 너비에서 다음을 확인하고 `.acceptance/eagle-compact-normal.png`를 저장한다.

- 상단 도구 모음 1줄
- 사이드바 208px 기본 너비와 조절
- 갤러리 6px 간격과 안쪽 선택선
- 선택 시 정보 패널 자동 열기
- 수동 닫기 후 강제 재열림 없음
- 가로 스크롤 없음

- [ ] **Step 3: 좁은 창 실제 검증**

960×650에서 정보 패널을 연 뒤 `.acceptance/eagle-compact-narrow.png`를 저장한다. 패널은 갤러리 위에 겹치고, 툴바는 한 줄을 유지하며, 사이드바와 컨트롤이 잘리지 않아야 한다.

- [ ] **Step 4: Windows 탐색기 드롭 검증**

한 이미지와 여러 이미지를 탐색기에서 앱의 사이드바, 갤러리, 정보 패널 위치에 각각 놓는다. `.acceptance/eagle-compact-drop.png`에는 파란 가장자리와 중앙의 작은 안내가 보여야 한다. 정확한 중복은 새 자산을 만들지 않고 알림만 표시해야 하며 실패 항목은 파일명만 표시해야 한다.

- [ ] **Step 5: 기존 탐색기 복사 회귀 검증**

앱에서 이미지 하나와 여러 이미지를 Windows 탐색기 폴더로 끌어 복사한다. 라이브러리 원본이 남고 대상 폴더에 복사본이 생기는지 확인한다.

- [ ] **Step 6: README와 계획 증거 갱신**

`app/README.md`에 다음 수동 확인 명령과 테스트 라이브러리 규칙을 기록한다.

```powershell
cd C:\chatgpt\.worktrees\daily-use-ui\app
npm.cmd run tauri dev
```

이 Task의 체크박스 아래에 실행 날짜, 전체 테스트 개수, build 결과, 캡처 파일명을 기록한다. 실패를 성공으로 기록하지 않는다.

- [ ] **Step 7: 사용자 시각 승인**

일반 창, 좁은 창, 드롭 상태 캡처를 사용자에게 보여준다. 간격, 대비, 툴바 밀도, 정보 패널을 승인받기 전에는 UI 완료로 표시하지 않는다. 수정 요청이 있으면 해당 Task의 테스트부터 다시 실행한다.

- [ ] **Step 8: 문서 커밋**

`.acceptance`가 gitignore 대상이면 캡처는 커밋하지 않고 로컬 검증 증거로만 둔다.

```powershell
git add app/README.md docs/superpowers/plans/2026-08-09-lakomics-eagle-compact-ui.md
git commit -m "docs: record Eagle compact UI verification"
```

## Plan Self-Review

- Spec coverage: 토큰, 3단 배치, 선택적 shadcn/Radix, 툴바 전환, 사이드바, 정보 패널, 가상화 갤러리, 외부 드롭, 오류, 접근성, 1536px/960px 검증을 Tasks 1~8에 연결했다.
- Scope: 컬렉션, 검색, 영상, 만화, 유사도 계산은 포함하지 않았다.
- Type consistency: `MenuItem`, `Menu`, `Dialog`, `Tooltip`, `AssetToolbarProps`, `FileDropState`, `IngestionWork` 이름은 현재 코드 및 앞선 Task와 일치한다.
- State ownership: 선택과 정보 패널은 `AssetBrowser`, 분류는 `ClassificationSidebar`, 수집 queue는 `useFileDrop`, 토큰은 `styles`가 계속 소유한다.
- Hardcoding: 승인된 기준 숫자와 색상은 Task 1의 토큰에만 정의하고 이후 Task는 변수만 사용한다.
