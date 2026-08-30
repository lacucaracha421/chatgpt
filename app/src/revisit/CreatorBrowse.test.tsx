import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

afterEach(() => cleanup());
beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get: () => 900 },
  clientWidth: { configurable: true, get: () => 840 },
  offsetHeight: { configurable: true, get: () => 600 },
  clientHeight: { configurable: true, get: () => 600 },
}));
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetCreatorSummary, LibraryGateway } from "../library/types";
import { CreatorBrowse } from "./CreatorBrowse";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

let gateway: LibraryGateway;

function creator(overrides: Partial<AssetCreatorSummary>): AssetCreatorSummary {
  return {
    key: "key",
    creatorName: null,
    creatorHandle: null,
    creatorUrl: null,
    assetCount: 0,
    lastCollectedAt: null,
    coverAssetIds: [],
    lastOpenedAt: null,
    recommendationScore: 0,
    ...overrides,
  };
}

const major = creator({ key: "major", creatorName: "major", assetCount: 8, coverAssetIds: ["a1", "a2", "a3", "a4"] });
const minor = creator({ key: "minor", creatorName: "minor", assetCount: 1, coverAssetIds: ["a5"] });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  gateway = {
    listAssetCreators: vi.fn().mockResolvedValue([major, minor]),
  } as unknown as LibraryGateway;
});

it("shows 3+ creators by default and searches every creator", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={gateway}>
      <CreatorBrowse onOpenCreator={vi.fn()} privacyMode={false} />
    </LibraryProvider>,
  );
  expect(await screen.findByRole("button", { name: /major/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /minor/ })).toBeNull();
  await user.type(screen.getByRole("searchbox", { name: "작가 검색" }), "minor");
  expect(screen.getByRole("button", { name: /minor/ })).toBeVisible();
});

it("uses four permanent collage images without hover preview", async () => {
  render(
    <LibraryProvider gateway={gateway}>
      <CreatorBrowse onOpenCreator={vi.fn()} privacyMode={false} />
    </LibraryProvider>,
  );
  const card = await screen.findByRole("button", { name: /major/ });
  expect(within(card).getAllByRole("presentation")).toHaveLength(4);
  expect(card.querySelector(".creator-browse__hover-preview")).toBeNull();
});