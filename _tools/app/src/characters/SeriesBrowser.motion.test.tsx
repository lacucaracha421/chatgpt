import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import type { CharacterHubApi } from "./hubApi";
import { emptyShadowSummary, type ShadowReviewApi } from "./shadowReviewApi";
import { INFO_PANEL_KEY } from "../assets/useInfoPanelPreference";

vi.mock("./suggestions/client", async importOriginal => {
  const actual = await importOriginal<typeof import("./suggestions/client")>();
  return { ...actual, suggestionApi: { ...actual.suggestionApi, list: async () => [], ignored: async () => [] } };
});

beforeEach(() => { Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 850 }, clientHeight: { configurable: true, get: () => 650 } }); });
afterEach(() => { cleanup(); localStorage.removeItem(INFO_PANEL_KEY); vi.restoreAllMocks(); });

async function mount() {
  const api = createCharacterFixture(), targets = await api.targets();
  const hubApi = { folderExclusions: vi.fn().mockResolvedValue([]), seriesFolders: vi.fn().mockResolvedValue([]), browse: vi.fn().mockResolvedValue({ items: fixtureAssets.slice(5), nextCursor: null, totalCount: 13 }),
    excludedAssets: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 }) } as unknown as CharacterHubApi;
  const shadowApi = { page: vi.fn(async () => ({ items: [], nextOffset: null, policyVersion: null, summary: emptyShadowSummary() })) } as unknown as ShadowReviewApi;
  const gateway = { listAssets: vi.fn().mockResolvedValue({ items: fixtureAssets, nextCursor: null }) } as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><SeriesBrowser series={{ classificationId: "series", heroAssetId: null, autoClassify: true }} targets={targets} classifications={fixtureClassifications}
    galleryLayout="masonry" onGalleryLayoutChange={vi.fn()} privacyMode={false} onPrivacyModeChange={vi.fn()} metadataVisible onMetadataVisibleChange={vi.fn()} thumbnailRowHeight={180} onThumbnailRowHeightChange={vi.fn()}
    refreshVersion={0} onNavigate={vi.fn()} onChanged={vi.fn()} api={api} hubApi={hubApi} shadowApi={shadowApi} /></LibraryProvider>);
  await screen.findByRole("option", { name: "이미지 5.webp" });
}

it("docks 정보 beside the series gallery like a plain folder: remembered, following the focused tile", async () => {
  localStorage.setItem(INFO_PANEL_KEY, "true");
  await mount();
  const workspace = document.querySelector(".series-browser__body")!;
  // The plain-folder workspace grid, not the former narrow inline presence.
  expect(workspace).toHaveClass("asset-browser__workspace");
  expect(workspace).toHaveAttribute("data-info-open", "true");
  expect(document.querySelector(".series-inspector-presence")).toBeNull();
  const panel = screen.getByRole("complementary", { name: "자산 정보" });
  expect(panel).toHaveClass("asset-inspector--docked");
  expect(panel).toHaveTextContent("선택한 자산이 없습니다.");
  const user = userEvent.setup();
  await user.click(screen.getByRole("option", { name: "이미지 5.webp" }));
  expect(screen.getByRole("option", { name: "이미지 5.webp" })).toHaveAttribute("aria-selected", "false");
  expect(within(panel).getByRole("button", { name: "이미지 5.webp 감상 화면으로 열기" })).toBeInTheDocument();
  await user.keyboard("i");
  await waitFor(() => expect(workspace).toHaveAttribute("data-info-open", "false"));
  expect(localStorage.getItem(INFO_PANEL_KEY)).toBe("false");
  await user.keyboard("i");
  await waitFor(() => expect(workspace).toHaveAttribute("data-info-open", "true"));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(workspace).toHaveAttribute("data-info-open", "false"));
});

it("keeps 정보 closed by default and offers it from 보기 without a selection", async () => {
  await mount();
  const workspace = document.querySelector(".series-browser__body")!;
  expect(workspace).toHaveAttribute("data-info-open", "false");
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "보기" }));
  const info = screen.getByRole("switch", { name: "정보" });
  expect(info).toBeEnabled();
  await user.click(info);
  await waitFor(() => expect(workspace).toHaveAttribute("data-info-open", "true"));
});
