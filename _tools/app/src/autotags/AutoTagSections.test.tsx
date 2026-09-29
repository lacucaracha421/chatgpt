import { act, fireEvent, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetInspector } from "../assets/AssetInspector";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, LibraryGateway } from "../library/types";
import { clearAutoTagFilter, getAutoTagFilter } from "./autoTagFilter";
import { invalidateAutoTagVocabulary } from "./autoTagVocabulary";
import type { AssetAutoTags, AutoTagGateway } from "./types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
beforeEach(() => { clearAutoTagFilter(); invalidateAutoTagVocabulary(); });
afterEach(() => { cleanup(); clearAutoTagFilter(); });

const asset: AssetSummary = { id: "a", title: null, originalName: "a.png", byteSize: 1024, width: 200, height: 100, collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: "https://example.com/a", sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" } };

function tagGateway(tags: AssetAutoTags): AutoTagGateway {
  return {
    assetTags: vi.fn().mockResolvedValue(tags),
    vocabulary: vi.fn().mockResolvedValue([
      { tag: "1girl", category: "general", count: 5740 },
      { tag: "pink_hair", category: "general", count: 610 },
      { tag: "nipples", category: "general", count: 1720 },
      { tag: "thighhighs", category: "general", count: 1410 },
      { tag: "vertin_(reverse:1999)", category: "character", count: 463 },
    ]),
    edit: vi.fn().mockResolvedValue(undefined),
    importSummary: vi.fn().mockResolvedValue(null),
    importFile: vi.fn(),
  };
}

function renderInspector(autoTags: AutoTagGateway) {
  const gateway = { updateAssetMetadata: vi.fn(), listSourceGroupAssets: vi.fn().mockResolvedValue([]), autoTags } as unknown as LibraryGateway;
  return render(<LibraryProvider gateway={gateway}><AssetInspector assets={[asset]} open onOpenChange={vi.fn()} /></LibraryProvider>);
}

const tags: AssetAutoTags = { hasConfirmedCharacter: false, tags: [
  { tag: "vertin_(reverse:1999)", category: "character", score: 0.91, source: "model" },
  { tag: "1girl", category: "general", score: 0.99, source: "model" },
  { tag: "pink_hair", category: "general", score: 0.94, source: "model" },
  { tag: "nipples", category: "general", score: 0.92, source: "model" },
] };

it("shows the guessed character above 출처 and the grouped list below it", async () => {
  renderInspector(tagGateway(tags));
  const highlights = await screen.findByRole("region", { name: "주요 태그" });
  expect(within(highlights).getByRole("button", { name: /Vertin · 리버스:1999\s*추정/ })).toBeVisible();
  const list = screen.getByRole("region", { name: "자동 태그" });
  // The tag list starts closed.
  expect(within(list).queryByRole("button", { name: /인물·외모/ })).toBeNull();
  fireEvent.click(within(list).getByRole("button", { name: /자동 태그/ }));
  expect(within(list).getByRole("button", { name: /인물·외모/ })).toBeVisible();
  expect(within(list).getByRole("button", { name: /성적 표현/ })).toBeVisible();
  const body = within(list).getAllByRole("button", { name: /^(분홍 머리|여자 1명)$/ }).map((button) => button.textContent);
  expect(body).toEqual(["분홍 머리", "여자 1명"]);
  expect(screen.queryByRole("heading", { name: "캐릭터 · 자동 태그" })).not.toBeInTheDocument();
  // Source and file facts come first, beside the preview; tags follow.
  expect(screen.getByLabelText("출처와 파일").compareDocumentPosition(highlights) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("omits 주요 태그 when the asset has a confirmed character", async () => {
  renderInspector(tagGateway({ ...tags, hasConfirmedCharacter: true }));
  await screen.findByRole("region", { name: "자동 태그" });
  expect(screen.queryByRole("region", { name: "주요 태그" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Vertin/)).not.toBeInTheDocument();
});

it("applies a chip as an 에셋 filter and removes a tag with undo", async () => {
  const user = userEvent.setup();
  const gateway = tagGateway(tags);
  renderInspector(gateway);
  await user.click(await screen.findByRole("button", { name: /^자동 태그/ }));
  await user.click(await screen.findByRole("button", { name: "분홍 머리" }));
  await user.click(screen.getByRole("button", { name: "이 태그로 찾기" }));
  expect(getAutoTagFilter()).toEqual({ include: ["pink_hair"], exclude: [] });

  await user.click(screen.getByRole("button", { name: "유두 태그 빼기" }));
  expect(gateway.edit).toHaveBeenCalledWith("a", "nipples", "remove");
  const toast = await screen.findByText("태그 1개 뺌 · 유두");
  await user.click(within(toast.closest(".ui-toast") as HTMLElement).getByRole("button", { name: "되돌리기" }));
  expect(gateway.edit).toHaveBeenLastCalledWith("a", "nipples", "reset");
});

it("adds a tag from the vocabulary by Korean name", async () => {
  const user = userEvent.setup();
  const gateway = tagGateway(tags);
  renderInspector(gateway);
  await user.click(await screen.findByRole("button", { name: /^자동 태그/ }));
  await user.click(await screen.findByRole("button", { name: "태그 추가" }));
  await user.type(screen.getByRole("combobox", { name: "추가할 태그 (한국어 또는 영어)" }), "사이하");
  const option = await screen.findByRole("option", { name: /사이하이/ });
  expect(option).toHaveTextContent("1,410");
  await act(async () => { await user.keyboard("{Enter}"); });
  expect(gateway.edit).toHaveBeenCalledWith("a", "thighhighs", "add");
});
