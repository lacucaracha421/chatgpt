import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AppShell } from "./AppShell";
import { ChromeTarget, WorkspaceChromeProvider } from "./WorkspaceChrome";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { MangaToolbar } from "../manga/MangaToolbar";
import { ViewToolbar } from "./ViewToolbar";
import type { AssetView } from "../library/types";

const indexHiddenKey = "lakomics.workspace.indexHidden.v1";
const props = { collectionType: "game" as const, width: 256, onWidthChange: vi.fn(), onNavigate: vi.fn(), assetNavigation: null, reviewCount: 0, trashCount: 0 };
/** Laid-out widths jsdom lacks: the content before the slide and the column it gets afterwards. */
const widths = { before: 1000, after: 744 };

type Pending = { update: () => void; finish(): void };
let pending: Pending[];
const transitionDescriptor = Object.getOwnPropertyDescriptor(document, "startViewTransition");
function mockViewTransitions() {
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: (update: () => void) => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    pending.push({ update, finish: () => finish() });
    return { ready: Promise.resolve(), finished, updateCallbackDone: Promise.resolve(), skipTransition: vi.fn() } as unknown as ViewTransition;
  } });
}
function reduceMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  pending = [];
  reduceMotion(false);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains("library-content") ? widths.before : this.classList.contains("workspace-content") ? widths.after : 0;
    return { width, height: 600, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 600, toJSON() {} } as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (transitionDescriptor) Object.defineProperty(document, "startViewTransition", transitionDescriptor);
  else Reflect.deleteProperty(document, "startViewTransition");
  localStorage.removeItem(indexHiddenKey);
  for (const name of ["data-view-swap", "data-index-slide"]) document.documentElement.removeAttribute(name);
});

function Workspace({ view = { kind: "manga" } }: { view?: AssetView }) {
  return <WorkspaceChromeProvider scope={view.kind}>
    <AppShell sidebar={<WorkspaceNavigation {...props} view={view} />} content={<div className="workspace-content">
      <ChromeTarget name="header" />
      <div className="library-content" data-testid="content">
        {view.kind === "manga" ? <MangaToolbar source="all" onSourceChange={vi.fn()} chrome={{ navigation: <nav aria-label="망가 인덱스">고정</nav> }} /> : <ViewToolbar title={view.kind} chrome={{}} />}
      </div>
    </div>} />
  </WorkspaceChromeProvider>;
}
const content = () => screen.getByTestId("content");
const scroller = () => content().closest<HTMLElement>(".app-shell__content")!;
const slot = (container: HTMLElement) => container.querySelector<HTMLElement>(".workspace-index-slot")!;
function endWidthTransition(element: HTMLElement) {
  const event = new Event("transitionend");
  Object.defineProperty(event, "propertyName", { value: "width" });
  fireEvent(element, event);
}

it("keeps the content's layout while the sidebar slides, then lays it out once inside the content swap", async () => {
  mockViewTransitions();
  const { container } = render(<Workspace />);
  fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
  // Frozen at the old width: the content follows the sidebar edge as one piece without reflowing.
  expect(slot(container)).toHaveAttribute("data-toggling");
  expect(content().style.width).toBe(`${widths.before}px`);
  expect(scroller().style.overflowX).toBe("hidden");
  expect(pending).toHaveLength(0);
  endWidthTransition(slot(container));
  // The one relayout waits for the swap's snapshot: the old frame stays painted until then.
  expect(pending).toHaveLength(1);
  expect(document.documentElement.getAttribute("data-view-swap")).toBe("rise");
  expect(document.documentElement).toHaveAttribute("data-index-slide");
  expect(content()).toHaveAttribute("data-view-swap-target");
  expect(content().style.width).toBe(`${widths.before}px`);
  act(() => pending[0].update());
  expect(content().style.width).toBe("");
  expect(scroller().style.overflowX).toBe("");
  await act(async () => { pending[0].finish(); });
  expect(document.documentElement).not.toHaveAttribute("data-view-swap");
  expect(document.documentElement).not.toHaveAttribute("data-index-slide");
  // The fallback timer never swaps a second time.
  await act(async () => { vi.advanceTimersByTime(400); });
  expect(pending).toHaveLength(1);
});

it("settles by its fallback timer when the width transition never reports its end", async () => {
  mockViewTransitions();
  render(<Workspace />);
  fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
  await act(async () => { vi.advanceTimersByTime(200); });
  expect(pending).toHaveLength(0);
  await act(async () => { vi.advanceTimersByTime(100); });
  expect(pending).toHaveLength(1);
  act(() => pending[0].update());
  expect(content().style.width).toBe("");
});

it("keeps the first frozen layout through a toggle reversed mid-slide and skips a swap that would change nothing", async () => {
  mockViewTransitions();
  widths.after = widths.before;
  try {
    const { container } = render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
    fireEvent.click(screen.getByRole("button", { name: "사이드바 숨기기" }));
    expect(content().style.width).toBe(`${widths.before}px`);
    endWidthTransition(slot(container));
    expect(pending).toHaveLength(0);
    expect(content().style.width).toBe("");
  } finally {
    widths.after = 744;
  }
});

it("leaves area switches alone and ends a running slide at once when the area changes", async () => {
  mockViewTransitions();
  const view = render(<Workspace view={{ kind: "classification", classificationId: null }} />);
  view.rerender(<Workspace view={{ kind: "manga" }} />);
  expect(content().style.width).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
  expect(content().style.width).toBe(`${widths.before}px`);
  view.rerender(<Workspace view={{ kind: "classification", classificationId: null }} />);
  expect(content().style.width).toBe("");
  expect(scroller().style.overflowX).toBe("");
  await act(async () => { vi.advanceTimersByTime(400); });
  expect(pending).toHaveLength(0);
});

it("snaps under reduced motion: no frozen layout and no swap", async () => {
  reduceMotion(true);
  mockViewTransitions();
  const { container } = render(<Workspace />);
  fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
  expect(content().style.width).toBe("");
  endWidthTransition(slot(container));
  await act(async () => { vi.advanceTimersByTime(400); });
  expect(pending).toHaveLength(0);
});

it("sizes only the old frame of the relayout swap at its own width", () => {
  const css = readFileSync("src/styles/chrome.css", "utf8");
  expect(css).toMatch(/html\[data-index-slide\]::view-transition-old\(view-swap\) \{ inline-size: auto; \}/);
});
