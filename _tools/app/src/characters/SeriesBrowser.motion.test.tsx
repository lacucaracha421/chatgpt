import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesInlineInspector } from "./SeriesBrowser";
import { fixtureAssets } from "./characterFixtures";

vi.mock("../assets/AssetInspector", () => ({
  AssetInspector: ({ assets, open, onOpenChange }: { assets: typeof fixtureAssets; open: boolean; onOpenChange(open: boolean): void }) => open && <aside aria-label="자산 정보">
    {assets.map(asset => <span key={asset.id}>{asset.originalName}</span>)}
    <button onClick={() => onOpenChange(false)}>정보 닫기</button>
  </aside>,
}));
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])("retains content during exit, disables input and restores focus (reduced: %s)", reduced => {
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const props = { assets: [fixtureAssets[0]], onOpenChange: vi.fn() };
  const view = render(<SeriesInlineInspector {...props} open={false} />);
  expect(screen.queryByRole("complementary")).toBeNull();
  view.rerender(<SeriesInlineInspector {...props} open />);
  act(() => vi.advanceTimersByTime(32));
  const panel = screen.getByRole("complementary"), presence = panel.parentElement!;
  expect(presence).toHaveAttribute("data-visible", "true");
  const close = screen.getByRole("button", { name: "정보 닫기" }); close.focus(); fireEvent.click(close);
  expect(props.onOpenChange).toHaveBeenCalledWith(false);
  view.rerender(<SeriesInlineInspector {...props} assets={[]} open={false} />);
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(panel).toHaveTextContent(fixtureAssets[0].originalName);
  expect(presence).toHaveAttribute("inert");
  expect(presence).toHaveAttribute("data-open", "false");
  expect(opener).toHaveFocus();
  act(() => vi.advanceTimersByTime((reduced ? 120 : 168) - 1));
  expect(panel).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(2));
  expect(panel).not.toBeInTheDocument();
  opener.remove();
});

it("reverses rapid close/open with the same inspector instead of queuing a removal", () => {
  const props = { assets: [fixtureAssets[0]], onOpenChange: vi.fn() };
  const view = render(<SeriesInlineInspector {...props} open />);
  act(() => vi.advanceTimersByTime(32));
  const panel = screen.getByRole("complementary");
  view.rerender(<SeriesInlineInspector {...props} open={false} />);
  act(() => vi.advanceTimersByTime(80));
  view.rerender(<SeriesInlineInspector {...props} open />);
  act(() => vi.advanceTimersByTime(240));
  expect(screen.getByRole("complementary")).toBe(panel);
  expect(panel.parentElement).toHaveAttribute("data-visible", "true");
  expect(panel.parentElement).not.toHaveAttribute("inert");
});
