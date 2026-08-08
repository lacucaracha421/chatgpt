import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetSummary, ClassificationEntry } from "../library/types";
import { AssetInspector } from "./AssetInspector";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));
afterEach(() => { cleanup(); openUrl.mockClear(); });

it("stays collapsed by default and opens on request", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(<AssetInspector assets={[asset("a")]} classifications={[]} open={false} onOpenChange={onOpenChange} onPatchClassifications={vi.fn()} />);

  expect(screen.queryByRole("complementary", { name: "자산 정보" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "정보 열기" }));
  expect(onOpenChange).toHaveBeenCalledWith(true);
});

it("shows one-asset metadata and opens its source URL", async () => {
  const user = userEvent.setup();
  render(<AssetInspector assets={[asset("a")]} classifications={[]} open onOpenChange={vi.fn()} onPatchClassifications={vi.fn()} />);

  expect(screen.getByText("a.png")).toBeVisible();
  expect(screen.getByText("example.com/source/a")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "출처 열기" }));
  expect(openUrl).toHaveBeenCalledWith("https://example.com/source/a");
});

it("summarizes multi-selection and delegates classification add and remove", async () => {
  const user = userEvent.setup();
  const onPatchClassifications = vi.fn();
  const classifications: ClassificationEntry[] = [{ id: "tag", kind: "tag", name: "태그", parentId: null }];
  render(<AssetInspector assets={[asset("a"), asset("b")]} classifications={classifications} open onOpenChange={vi.fn()} onPatchClassifications={onPatchClassifications} />);

  expect(screen.getByText("2개 자산 선택")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "태그 추가" }));
  await user.click(screen.getByRole("button", { name: "태그 제거" }));
  expect(onPatchClassifications).toHaveBeenNthCalledWith(1, "tag", "add");
  expect(onPatchClassifications).toHaveBeenNthCalledWith(2, "tag", "remove");
});

function asset(id: string): AssetSummary {
  return { id, title: null, originalName: `${id}.png`, byteSize: 1024, width: 200, height: 100, collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: `https://example.com/source/${id}` };
}
