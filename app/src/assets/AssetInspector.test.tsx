import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, ClassificationEntry, LibraryGateway } from "../library/types";
import { AssetInspector } from "./AssetInspector";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));
afterEach(() => { cleanup(); openUrl.mockClear(); });

const classifications: ClassificationEntry[] = [
  { id: "tag", kind: "tag", name: "태그", parentId: null },
  { id: "work", kind: "work", name: "작품", parentId: null },
];

it("hides the open control when there is no selection", () => {
  render(
    <LibraryProvider gateway={createGateway([])}>
      <AssetInspector assets={[]} classifications={[]} open={false} onOpenChange={vi.fn()} onPatchClassifications={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
});

it("stays collapsed by default and renders nothing while closed", () => {
  render(
    <LibraryProvider gateway={createGateway([])}>
      <AssetInspector assets={[asset("a")]} classifications={[]} open={false} onOpenChange={vi.fn()} onPatchClassifications={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
});

it("closes from Escape while focus is inside the inspector", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(
    <LibraryProvider gateway={createGateway([])}>
      <AssetInspector assets={[asset("a")]} classifications={[]} open onOpenChange={onOpenChange} onPatchClassifications={vi.fn()} />
    </LibraryProvider>,
  );

  screen.getByRole("button", { name: "정보 닫기" }).focus();
  await user.keyboard("{Escape}");

  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("shows one-asset metadata and opens its source URL", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={createGateway([])}>
      <AssetInspector assets={[asset("a")]} classifications={[]} open onOpenChange={vi.fn()} onPatchClassifications={vi.fn()} />
    </LibraryProvider>,
  );

  expect(screen.getByText("a.png")).toBeVisible();
  expect(screen.getByText("example.com/source/a")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "출처 열기" }));
  expect(openUrl).toHaveBeenCalledWith("https://example.com/source/a");
});

it("checks a classification that every selected asset has and toggles it off", async () => {
  const gateway = createGateway(["tag"]);
  const onPatchClassifications = vi.fn();
  render(
    <LibraryProvider gateway={gateway}>
      <AssetInspector assets={[asset("a")]} classifications={classifications} open onOpenChange={vi.fn()} onPatchClassifications={onPatchClassifications} />
    </LibraryProvider>,
  );
  const checkbox = await screen.findByRole("checkbox", { name: "태그 분류" });
  expect(checkbox).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "작품 분류" })).not.toBeChecked();

  await userEvent.click(checkbox);
  expect(onPatchClassifications).toHaveBeenCalledWith("tag", "remove");
});

it("shows indeterminate state when only some of the selection has a classification", async () => {
  const getAssetClassifications = vi.fn().mockImplementation((assetId: string) => Promise.resolve(assetId === "a" ? ["tag"] : []));
  const gateway = { getAssetClassifications } as unknown as LibraryGateway;
  render(
    <LibraryProvider gateway={gateway}>
      <AssetInspector assets={[asset("a"), asset("b")]} classifications={classifications} open onOpenChange={vi.fn()} onPatchClassifications={vi.fn()} />
    </LibraryProvider>,
  );
  const checkbox = await screen.findByRole("checkbox", { name: "태그 분류" });
  await waitFor(() => expect(checkbox).toHaveProperty("indeterminate", true));
});

it("reports when classification membership cannot be loaded", async () => {
  const gateway = createGateway([], true);
  render(
    <LibraryProvider gateway={gateway}>
      <AssetInspector assets={[asset("a")]} classifications={classifications} open onOpenChange={vi.fn()} onPatchClassifications={vi.fn()} />
    </LibraryProvider>,
  );
  expect(await screen.findByText("분류 상태를 불러오지 못했습니다.")).toBeVisible();
});

function createGateway(classificationIds: string[], reject = false): LibraryGateway {
  return {
    getAssetClassifications: vi.fn().mockImplementation(() => reject ? Promise.reject(new Error("membership failed")) : Promise.resolve(classificationIds)),
  } as unknown as LibraryGateway;
}

function asset(id: string): AssetSummary {
  return { id, title: null, originalName: `${id}.png`, byteSize: 1024, width: 200, height: 100, collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: `https://example.com/source/${id}`, media: { kind: "image" } };
}
