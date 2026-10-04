import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { ChromeQueryBadge } from "./ChromeSearch";

const descriptor = Object.getOwnPropertyDescriptor(document, "startViewTransition");
let transitions: { update: () => void; finish(): void }[];
beforeEach(() => {
  transitions = [];
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: (update: () => void) => {
    let finish!: () => void; const finished = new Promise<void>(resolve => { finish = resolve; });
    transitions.push({ update, finish: () => finish() });
    return { ready: Promise.resolve(), finished, updateCallbackDone: Promise.resolve(), skipTransition: vi.fn() };
  } });
});
afterEach(() => {
  cleanup();
  if (descriptor) Object.defineProperty(document, "startViewTransition", descriptor); else Reflect.deleteProperty(document, "startViewTransition");
});

function View({ results = true }: { results?: boolean }) {
  const [query, setQuery] = useState("라쿠");
  const apply = vi.fn(setQuery);
  return <>
    <ChromeQueryBadge search={{ scope: "컬렉션", label: "검색", query, onApply: apply }} />
    {results && <div data-search-results="" data-testid="results">{query ? `결과: ${query}` : "전체 목록"}</div>}
  </>;
}

it("clears the toolbar search through one view swap: the old results stay until the commit", async () => {
  render(<View />);
  fireEvent.click(screen.getByRole("button", { name: "검색 해제" }));
  expect(transitions).toHaveLength(1);
  expect(screen.getByTestId("results")).toHaveTextContent("결과: 라쿠");
  expect(document.documentElement).toHaveAttribute("data-view-swap", "rise");
  expect(screen.getByTestId("results")).toHaveAttribute("data-view-swap-target");
  act(() => transitions[0].update());
  expect(screen.getByTestId("results")).toHaveTextContent("전체 목록");
  await act(async () => transitions[0].finish());
  expect(document.documentElement).not.toHaveAttribute("data-view-swap");
  expect(screen.getByTestId("results")).not.toHaveAttribute("data-view-swap-target");
});

it("applies at once when no results are on screen", () => {
  render(<View results={false} />);
  fireEvent.click(screen.getByRole("button", { name: "검색 해제" }));
  expect(transitions).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "검색 해제" })).toBeNull();
});
