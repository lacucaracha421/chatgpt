import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AppShell } from "./AppShell";
import { ChromeTarget, WorkspaceChromeProvider } from "./WorkspaceChrome";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import { MangaToolbar } from "../manga/MangaToolbar";
import { startViewSwap } from "../shared/motion/viewSwap";

const indexHiddenKey = "lakomics.workspace.indexHidden.v1";
const AREA = "data-area-view-transition";
const props = { collectionType: "game" as const, width: 256, onWidthChange: vi.fn(), onNavigate: vi.fn(), assetNavigation: null, reviewCount: 0, trashCount: 0 };

type Pending = { update: () => void; skip: ReturnType<typeof vi.fn>; finish(): void };
let pending: Pending[];
const transitionDescriptor = Object.getOwnPropertyDescriptor(document, "startViewTransition");
function mockViewTransitions() {
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: (update: () => void) => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const entry: Pending = { update, skip: vi.fn(), finish: () => finish() };
    pending.push(entry);
    return { ready: Promise.resolve(), finished, updateCallbackDone: Promise.resolve(), skipTransition: entry.skip } as unknown as ViewTransition;
  } });
}
function reduceMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  pending = [];
  reduceMotion(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (transitionDescriptor) Object.defineProperty(document, "startViewTransition", transitionDescriptor);
  else Reflect.deleteProperty(document, "startViewTransition");
  localStorage.removeItem(indexHiddenKey);
  document.documentElement.removeAttribute(AREA);
});

function Workspace() {
  return <WorkspaceChromeProvider scope="manga">
    <AppShell sidebar={<WorkspaceNavigation {...props} view={{ kind: "manga" }} />} content={<div className="workspace-content">
      <ChromeTarget name="header" />
      <div className="library-content" data-testid="content">
        <MangaToolbar source="all" onSourceChange={vi.fn()} chrome={{ navigation: <nav aria-label="망가 인덱스">고정</nav> }} />
      </div>
    </div>} />
  </WorkspaceChromeProvider>;
}
const slot = (container: HTMLElement) => container.querySelector<HTMLElement>(".workspace-index-slot")!;
const stored = () => JSON.parse(localStorage.getItem(indexHiddenKey)!);

it("shows the sidebar through one area-switch view transition that flips the state inside its update", async () => {
  mockViewTransitions();
  const { container } = render(<Workspace />);
  fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
  // The old frame stays painted until the browser's snapshot; the choice is remembered at once.
  expect(pending).toHaveLength(1);
  expect(document.documentElement.getAttribute(AREA)).toBe("index");
  expect(slot(container)).toHaveAttribute("data-state", "closed");
  expect(stored()).toEqual({ manga: false });
  act(() => {
    pending[0].update();
    // Synchronous inside the update: the new snapshot sees the open sidebar and the content at its new width.
    expect(slot(container)).toHaveAttribute("data-state", "open");
  });
  expect(screen.getByRole("complementary", { name: "탐색 인덱스" })).toBeInTheDocument();
  // No width transition, frozen layout or second swap.
  expect(slot(container)).not.toHaveAttribute("data-toggling");
  expect(screen.getByTestId("content").style.width).toBe("");
  await act(async () => { pending[0].finish(); });
  expect(document.documentElement).not.toHaveAttribute(AREA);
  expect(pending).toHaveLength(1);
});

it("hides the sidebar the same way", async () => {
  localStorage.setItem(indexHiddenKey, JSON.stringify({ manga: false }));
  mockViewTransitions();
  const { container } = render(<Workspace />);
  fireEvent.click(screen.getByRole("button", { name: "사이드바 숨기기" }));
  expect(document.documentElement.getAttribute(AREA)).toBe("index");
  expect(slot(container)).toHaveAttribute("data-state", "open");
  act(() => pending[0].update());
  expect(slot(container)).toHaveAttribute("data-state", "closed");
  expect(stored()).toEqual({ manga: true });
  await act(async () => { pending[0].finish(); });
  expect(document.documentElement).not.toHaveAttribute(AREA);
});

it("ends in the last requested state when toggled again, before or after the first snapshot commits", async () => {
  mockViewTransitions();
  const { container } = render(<Workspace />);
  // Twice before the first snapshot: the first is skipped and its commit dropped.
  fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
  fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
  expect(pending[0].skip).toHaveBeenCalledOnce();
  act(() => pending[0].update());
  expect(slot(container)).toHaveAttribute("data-state", "closed");
  act(() => pending[1].update());
  expect(slot(container)).toHaveAttribute("data-state", "open");
  // Hidden again while that one still animates: it ends at once and the next one takes over.
  fireEvent.click(screen.getByRole("button", { name: "사이드바 숨기기" }));
  expect(pending[1].skip).toHaveBeenCalledOnce();
  expect(document.documentElement.getAttribute(AREA)).toBe("index");
  act(() => pending[2].update());
  expect(slot(container)).toHaveAttribute("data-state", "closed");
  expect(stored()).toEqual({ manga: true });
  await act(async () => { for (const entry of pending) entry.finish(); });
  expect(document.documentElement).not.toHaveAttribute(AREA);
});

it("snaps under reduced motion", () => {
  reduceMotion(true);
  mockViewTransitions();
  const { container } = render(<Workspace />);
  fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
  expect(pending).toHaveLength(0);
  expect(slot(container)).toHaveAttribute("data-state", "open");
  expect(document.documentElement).not.toHaveAttribute(AREA);
});

it("snaps without the View Transitions API", () => {
  Reflect.deleteProperty(document, "startViewTransition");
  const { container } = render(<Workspace />);
  fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
  expect(slot(container)).toHaveAttribute("data-state", "open");
  expect(document.documentElement).not.toHaveAttribute(AREA);
});

it("yields to a running area switch and does not end an area switch that interrupts it", async () => {
  mockViewTransitions();
  const { container } = render(<Workspace />);
  // An area switch owns the document: the toggle switches at once.
  document.documentElement.setAttribute(AREA, "");
  fireEvent.click(screen.getByRole("button", { name: "사이드바 보이기" }));
  expect(pending).toHaveLength(0);
  expect(slot(container)).toHaveAttribute("data-state", "open");
  document.documentElement.removeAttribute(AREA);
  // A toggle runs; an area switch starts over it (the browser skips the toggle, whose update still commits).
  fireEvent.click(screen.getByRole("button", { name: "사이드바 숨기기" }));
  const area = startViewSwap({ attribute: AREA, value: "", commit: vi.fn() })!;
  act(() => pending[0].update());
  expect(slot(container)).toHaveAttribute("data-state", "closed");
  await act(async () => { pending[0].finish(); });
  // The toggle's end leaves the area switch's names in place.
  expect(document.documentElement.getAttribute(AREA)).toBe("");
  pending[1].update();
  await act(async () => { pending[1].finish(); await area.finished; });
  expect(document.documentElement).not.toHaveAttribute(AREA);
});

it("moves each content frame at its own size, the new one over the solid old one, above the sidebar", () => {
  const css = readFileSync("src/shared/motion/viewTransitions.css", "utf8");
  expect(css).toContain('html[data-area-view-transition="index"]::view-transition-group(main) { z-index: 1; overflow: clip; }');
  expect(css).toMatch(/html\[data-area-view-transition="index"\]::view-transition-new\(main\) \{ inline-size: auto; block-size: auto; mix-blend-mode: normal; \}/);
  expect(css).toContain('html[data-area-view-transition="index"]::view-transition-old(main) { animation: none; }');
  expect(css).toContain('html[data-area-view-transition="index"]::view-transition-new(main) { animation-name: index-toggle-content-in; animation-duration: 90ms; }');
  // The former width slide and its relayout swap are gone.
  const chrome = readFileSync("src/styles/chrome.css", "utf8");
  expect(chrome).not.toMatch(/data-toggling|data-index-slide/);
});
