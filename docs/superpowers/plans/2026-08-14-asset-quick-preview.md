# Asset Quick Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이미지와 GIF 타일의 우측 하단 `+` 트리거에 호버하거나 포커스하면 기존 전체 화면 뷰어와 별개인 원본 이미지 빠른 미리보기를 표시한다.

**Architecture:** 기존 가상화 갤러리 구조는 유지하고 `AssetGallery`가 지연 타이머와 활성 미리보기 하나만 소유한다. 각 이미지 타일은 트리거 이벤트와 `DOMRect`만 전달하며, 갤러리는 에셋 원본 비율과 뷰포트 크기로 고정 위치를 계산해 팝오버 하나를 렌더링한다.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, CSS design tokens, Heroicons

## Global Constraints

- 이미지와 GIF에만 적용하고 영상의 기존 호버 재생은 변경하지 않는다.
- 원본 이미지는 기존 `assetUrl(asset.id)`을 사용한다.
- 호버·포커스 지연은 150ms다.
- 팝오버 최대 크기는 뷰포트 너비의 55%, 높이의 70%다.
- 외부 위치 지정 라이브러리나 새 런타임 의존성을 추가하지 않는다.
- 갤러리 선택, 드래그, 더블클릭 전체 화면 뷰어 동작을 유지한다.
- 활성 팝오버 DOM은 최대 하나다.

---

### Task 1: 이미지 전용 빠른 미리보기 상호작용

**Files:**
- Modify: `app/src/assets/AssetGallery.test.tsx`
- Modify: `app/src/assets/AssetGallery.tsx`

**Interfaces:**
- Consumes: `AssetSummary`, `assetUrl(assetId: string): string`, 기존 `AssetTile` 이벤트 흐름
- Produces: `QuickPreviewState = { asset: AssetSummary; anchor: DOMRect }`, 이미지 타일의 `빠른 확대 미리보기` 버튼, `AssetGallery`의 단일 활성 미리보기

- [ ] **Step 1: 이미지와 영상의 트리거 범위를 보여주는 실패 테스트 작성**

```tsx
it("offers quick preview only for image assets", async () => {
  render(<AssetGallery items={[asset(0), videoAsset(1)]} />);

  expect(await screen.findByRole("button", { name: "asset-0.png 빠른 확대 미리보기" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "video-1.webm 빠른 확대 미리보기" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트를 실행해 기능 부재로 실패하는지 확인**

Run: `npm.cmd test -- --run src/assets/AssetGallery.test.tsx -t "offers quick preview only"`

Expected: `빠른 확대 미리보기` 버튼을 찾지 못해 FAIL.

- [ ] **Step 3: 이미지 타일에 quiet 트리거를 최소 구현**

`AssetGallery.tsx`에서 `PlusIcon`을 가져오고 `AssetTile`에 이미지 전용 버튼을 추가한다.

```tsx
{asset.media.kind === "image" && <button
  type="button"
  className="asset-gallery__quick-preview-trigger"
  aria-label={`${alt} 빠른 확대 미리보기`}
  onClick={(event) => event.stopPropagation()}
  onDoubleClick={(event) => event.stopPropagation()}
  onPointerDown={(event) => event.stopPropagation()}
>
  <PlusIcon aria-hidden="true" />
</button>}
```

- [ ] **Step 4: 범위 테스트가 통과하는지 확인**

Run: `npm.cmd test -- --run src/assets/AssetGallery.test.tsx -t "offers quick preview only"`

Expected: PASS.

- [ ] **Step 5: 호버 지연·원본 URL·닫힘 동작 실패 테스트 작성**

```tsx
it("opens one original image preview after the hover delay and closes it on leave", async () => {
  vi.useFakeTimers();
  render(<AssetGallery items={[asset(0), asset(1)]} />);
  const trigger = await screen.findByRole("button", { name: "asset-0.png 빠른 확대 미리보기" });

  fireEvent.pointerEnter(trigger);
  act(() => vi.advanceTimersByTime(149));
  expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();

  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("img", { name: "asset-0.png 빠른 미리보기" })).toHaveAttribute(
    "src",
    "http://lakomics.localhost/asset/asset-0",
  );

  const second = screen.getByRole("button", { name: "asset-1.png 빠른 확대 미리보기" });
  fireEvent.pointerEnter(second);
  act(() => vi.advanceTimersByTime(150));
  expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("img", { name: /빠른 미리보기/ })).toHaveLength(1);

  fireEvent.pointerLeave(second);
  expect(screen.queryByRole("img", { name: "asset-1.png 빠른 미리보기" })).not.toBeInTheDocument();
});
```

- [ ] **Step 6: 지연 타이머와 단일 활성 미리보기 상태 구현**

`AssetGallery`에 다음 상태와 요청 함수를 추가하고 이미지 트리거의 pointer/focus 이벤트에 연결한다.

```tsx
const QUICK_PREVIEW_DELAY_MS = 150;
type QuickPreviewState = { asset: AssetSummary; anchor: DOMRect };

const quickPreviewTimerRef = useRef<number | null>(null);
const [quickPreview, setQuickPreview] = useState<QuickPreviewState | null>(null);

const cancelQuickPreview = () => {
  if (quickPreviewTimerRef.current !== null) window.clearTimeout(quickPreviewTimerRef.current);
  quickPreviewTimerRef.current = null;
  setQuickPreview(null);
};
const requestQuickPreview = (asset: AssetSummary, trigger: HTMLElement) => {
  if (quickPreviewTimerRef.current !== null) window.clearTimeout(quickPreviewTimerRef.current);
  quickPreviewTimerRef.current = window.setTimeout(() => {
    setQuickPreview({ asset, anchor: trigger.getBoundingClientRect() });
    quickPreviewTimerRef.current = null;
  }, QUICK_PREVIEW_DELAY_MS);
};
```

팝오버는 `assetUrl`을 사용해 갤러리의 sibling으로 하나만 렌더링한다.

```tsx
{quickPreview && <div className="asset-gallery__quick-preview" style={quickPreviewLayout(quickPreview)}>
  <img
    src={assetUrl(quickPreview.asset.id)}
    alt={`${quickPreview.asset.title || quickPreview.asset.originalName} 빠른 미리보기`}
    draggable={false}
    onError={cancelQuickPreview}
  />
</div>}
```

- [ ] **Step 7: 호버 테스트가 통과하는지 확인**

Run: `npm.cmd test -- --run src/assets/AssetGallery.test.tsx -t "opens one original image preview"`

Expected: PASS.

- [ ] **Step 8: 포커스·Escape·스크롤 닫힘과 이벤트 격리 실패 테스트 작성**

```tsx
it("supports keyboard quick preview and dismisses it without selecting or opening the tile", async () => {
  vi.useFakeTimers();
  const select = vi.fn();
  const open = vi.fn();
  const { container } = render(<AssetGallery items={[asset(0)]} onSelectionGesture={select} onOpen={open} />);
  const trigger = await screen.findByRole("button", { name: "asset-0.png 빠른 확대 미리보기" });

  fireEvent.focus(trigger);
  act(() => vi.advanceTimersByTime(150));
  expect(screen.getByRole("img", { name: "asset-0.png 빠른 미리보기" })).toBeInTheDocument();
  fireEvent.blur(trigger);
  expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();

  fireEvent.focus(trigger);
  act(() => vi.advanceTimersByTime(150));
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();

  fireEvent.click(trigger);
  fireEvent.doubleClick(trigger);
  fireEvent.pointerDown(trigger, { button: 0 });
  expect(select).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();

  fireEvent.focus(trigger);
  act(() => vi.advanceTimersByTime(150));
  fireEvent.error(screen.getByRole("img", { name: "asset-0.png 빠른 미리보기" }));
  expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();

  fireEvent.focus(trigger);
  act(() => vi.advanceTimersByTime(150));
  fireEvent.scroll(container.querySelector(".asset-gallery__scroll")!);
  expect(screen.queryByRole("img", { name: "asset-0.png 빠른 미리보기" })).not.toBeInTheDocument();
});
```

- [ ] **Step 9: 키보드·스크롤 정리와 타이머 cleanup 구현**

- 트리거 `onFocus`는 `requestQuickPreview`, `onBlur`는 `cancelQuickPreview`를 호출한다.
- 트리거 `onKeyDown`에서 `Escape`를 처리하고 전파를 막는다.
- 갤러리 `onScroll`에서 기존 `scrollTop` 갱신과 함께 `cancelQuickPreview`를 호출한다.
- 컴포넌트 unmount 시 예약된 timeout을 해제하는 `useEffect` cleanup을 추가한다.
- 트리거의 click, double click, pointer down 이벤트 전파를 막는다.

- [ ] **Step 10: AssetGallery 전체 테스트 실행**

Run: `npm.cmd test -- --run src/assets/AssetGallery.test.tsx`

Expected: 기존 테스트와 새 테스트 모두 PASS.

- [ ] **Step 11: 상호작용 변경 커밋**

```powershell
git add app/src/assets/AssetGallery.tsx app/src/assets/AssetGallery.test.tsx
git diff --cached --check
git commit -m "feat: add image quick preview interaction"
```

### Task 2: 뷰포트 안전 배치와 갤러리 스타일

**Files:**
- Modify: `app/src/assets/AssetGallery.test.tsx`
- Modify: `app/src/assets/AssetGallery.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: Task 1의 `QuickPreviewState`
- Produces: `quickPreviewLayout(preview: QuickPreviewState): React.CSSProperties`, `.asset-gallery__quick-preview-trigger`, `.asset-gallery__quick-preview`

- [ ] **Step 1: 원본 비율·좌우 전환·수직 제한 실패 테스트 작성**

```tsx
it("places the quick preview beside its trigger and clamps it inside the viewport", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
  render(<AssetGallery items={[{ ...asset(0), width: 400, height: 800 }]} />);
  const trigger = await screen.findByRole("button", { name: "asset-0.png 빠른 확대 미리보기" });
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    left: 900, right: 924, top: 760, bottom: 784, width: 24, height: 24,
    x: 900, y: 760, toJSON: () => ({}),
  });

  fireEvent.pointerEnter(trigger);
  act(() => vi.advanceTimersByTime(150));
  const preview = screen.getByRole("img", { name: "asset-0.png 빠른 미리보기" }).parentElement!;

  expect(Number.parseFloat(preview.style.left)).toBeLessThan(900);
  expect(Number.parseFloat(preview.style.top)).toBeGreaterThanOrEqual(12);
  expect(Number.parseFloat(preview.style.top) + Number.parseFloat(preview.style.height)).toBeLessThanOrEqual(788);
  expect(Number.parseFloat(preview.style.width) / Number.parseFloat(preview.style.height)).toBeCloseTo(0.5);
});
```

- [ ] **Step 2: 위치 테스트를 실행해 스타일 부재로 실패하는지 확인**

Run: `npm.cmd test -- --run src/assets/AssetGallery.test.tsx -t "places the quick preview"`

Expected: 팝오버의 `left`, `top`, `width`, `height`가 없어 FAIL.

- [ ] **Step 3: 최소 위치 계산 구현**

```tsx
const QUICK_PREVIEW_GAP = 8;
const QUICK_PREVIEW_MARGIN = 12;

function quickPreviewLayout({ asset, anchor }: QuickPreviewState): React.CSSProperties {
  const maxWidth = window.innerWidth * 0.55;
  const maxHeight = window.innerHeight * 0.7;
  const sourceWidth = Math.max(1, asset.width);
  const sourceHeight = Math.max(1, asset.height);
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const preferredRight = anchor.right + QUICK_PREVIEW_GAP;
  const left = preferredRight + width + QUICK_PREVIEW_MARGIN <= window.innerWidth
    ? preferredRight
    : Math.max(QUICK_PREVIEW_MARGIN, anchor.left - QUICK_PREVIEW_GAP - width);
  const top = Math.min(
    window.innerHeight - QUICK_PREVIEW_MARGIN - height,
    Math.max(QUICK_PREVIEW_MARGIN, anchor.top + anchor.height / 2 - height / 2),
  );
  return { left, top, width, height };
}
```

- [ ] **Step 4: 위치 테스트가 통과하는지 확인**

Run: `npm.cmd test -- --run src/assets/AssetGallery.test.tsx -t "places the quick preview"`

Expected: PASS.

- [ ] **Step 5: 디자인 토큰을 사용하는 최소 스타일 구현**

`global.css`의 갤러리 규칙 옆에 다음 역할의 스타일을 추가한다.

```css
.asset-gallery__quick-preview-trigger {
  position: absolute;
  z-index: 2;
  right: var(--space-1);
  bottom: var(--space-1);
  display: grid;
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  padding: var(--space-1);
  place-items: center;
  color: var(--color-text);
  background: var(--video-overlay-bg);
  border: 0;
  border-radius: var(--radius-sm);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease, background 120ms ease;
}

.asset-gallery__asset:hover .asset-gallery__quick-preview-trigger,
.asset-gallery__asset:focus-within .asset-gallery__quick-preview-trigger {
  opacity: 1;
  pointer-events: auto;
}

.asset-gallery__quick-preview {
  position: fixed;
  z-index: var(--z-floating-menu);
  box-sizing: border-box;
  overflow: hidden;
  background: var(--color-surface-elevated);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-floating);
  pointer-events: none;
}

.asset-gallery__quick-preview img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
```

위 코드의 `--control-height-sm`, `--color-surface-elevated`, `--video-overlay-bg`, `--z-floating-menu`, `--shadow-floating` 기존 토큰을 그대로 사용하고 raw 색상이나 새 토큰은 만들지 않는다.

- [ ] **Step 6: CSS 클래스와 팝오버 DOM 테스트 재실행**

Run: `npm.cmd test -- --run src/assets/AssetGallery.test.tsx`

Expected: 모든 AssetGallery 테스트 PASS.

- [ ] **Step 7: 스타일과 배치 변경 커밋**

```powershell
git add app/src/assets/AssetGallery.tsx app/src/assets/AssetGallery.test.tsx app/src/styles/global.css
git diff --cached --check
git commit -m "style: position asset quick previews"
```

### Task 3: 회귀 검증과 실제 데스크톱 확인

**Files:**
- Verify: `app/src/assets/AssetGallery.test.tsx`
- Verify: `app/src/assets/AssetBrowser.test.tsx`
- Verify: `app/src/assets/AssetViewer.test.tsx`

**Interfaces:**
- Consumes: Task 1과 Task 2의 완성된 빠른 미리보기
- Produces: 테스트·빌드·실행 확인 기록

- [ ] **Step 1: 에셋 관련 집중 테스트 실행**

Run: `npm.cmd test -- --run src/assets/AssetGallery.test.tsx src/assets/AssetBrowser.test.tsx src/assets/AssetViewer.test.tsx`

Expected: 모든 테스트 PASS.

- [ ] **Step 2: 전체 프런트엔드 테스트 실행**

Run: `npm.cmd test -- --run`

Expected: 모든 테스트 PASS.

- [ ] **Step 3: 프로덕션 프런트엔드 빌드 실행**

Run: `npm.cmd run build`

Expected: TypeScript와 Vite 빌드 성공.

- [ ] **Step 4: Rust 회귀 테스트 실행**

Run: `cargo test`

Working directory: `app/src-tauri`

Expected: 모든 비-ignored 테스트 PASS.

- [ ] **Step 5: Tauri 디버그 바이너리 빌드**

Run: `npm.cmd run tauri -- build --debug --no-bundle`

Expected: `app/src-tauri/target/debug/lakomics.exe` 생성.

- [ ] **Step 6: 실제 앱에서 수동 확인**

- 이미지 타일에 호버했을 때 우측 하단 `+`가 나타나는지 확인한다.
- `+`에 잠시 머물면 원본 비율의 팝오버가 타일 옆에 표시되는지 확인한다.
- 화면 오른쪽과 아래쪽 타일에서도 팝오버가 화면 밖으로 나가지 않는지 확인한다.
- 영상 타일에는 `+`가 없고 기존 호버 재생이 동작하는지 확인한다.
- 빠른 미리보기 후 더블클릭 전체 화면 뷰어가 정상 동작하는지 확인한다.

- [ ] **Step 7: 작업 트리가 깨끗한지 확인**

```powershell
git status --short
git diff --check
```

Expected: 의도하지 않은 변경 없음.
