import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryGateway, SimilarityReviewSummary } from "../library/types";
import { assetUrl } from "../assets/mediaUrl";
import { SimilarityReviewBrowser } from "./SimilarityReviewBrowser";

afterEach(cleanup);

it("shows both public assets and advances after a successful decision", async () => {
  const gateway = reviewGateway();
  vi.mocked(gateway.listSimilarityReviews)
    .mockResolvedValueOnce(reviewPage([review("review-1")], 2))
    .mockResolvedValueOnce(reviewPage([review("review-2")], 1));
  const onCountChange = vi.fn();
  render(<SimilarityReviewBrowser gateway={gateway} onCountChange={onCountChange} onClose={vi.fn()} />);

  expect(await screen.findByRole("heading", { name: "유사 이미지 검토" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "기존 이미지" })).toHaveAttribute("src", assetUrl("existing-review-1"));
  expect(screen.getByRole("img", { name: "새 이미지" })).toHaveAttribute("src", assetUrl("candidate-review-1"));
  expect(screen.getAllByText("1920 × 1080")).toHaveLength(2);

  await userEvent.click(screen.getByRole("button", { name: "둘 다 보관" }));
  expect(gateway.decideSimilarityReview).toHaveBeenCalledWith({ reviewId: "review-1", decision: "keep_both" });
  expect(await screen.findByText("candidate-review-2.png")).toBeInTheDocument();
  expect(onCountChange).toHaveBeenLastCalledWith(1);
});

it("keeps the current pair and disables decisions while a decision is pending", async () => {
  const gateway = reviewGateway();
  vi.mocked(gateway.listSimilarityReviews).mockResolvedValue(reviewPage([review("review-1")], 1));
  let reject!: (reason: unknown) => void;
  vi.mocked(gateway.decideSimilarityReview).mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  render(<SimilarityReviewBrowser gateway={gateway} onCountChange={vi.fn()} onClose={vi.fn()} />);
  await screen.findByText("candidate-review-1.png");

  await userEvent.click(screen.getByRole("button", { name: "새 이미지로 교체" }));
  expect(screen.getByRole("button", { name: "기존 이미지 유지" })).toBeDisabled();
  reject(new Error("conflict"));
  expect(await screen.findByRole("status")).toBeInTheDocument();
  expect(screen.getByText("candidate-review-1.png")).toBeInTheDocument();
});

it("closes with Escape without deciding and shows an empty queue", async () => {
  const gateway = reviewGateway();
  vi.mocked(gateway.listSimilarityReviews).mockResolvedValue(reviewPage([], 0));
  const onClose = vi.fn();
  render(<SimilarityReviewBrowser gateway={gateway} onCountChange={vi.fn()} onClose={onClose} />);
  expect(await screen.findByRole("heading", { name: "검토할 유사 이미지가 없습니다" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  expect(gateway.decideSimilarityReview).not.toHaveBeenCalled();
});

function review(id: string): SimilarityReviewSummary {
  return {
    id,
    distance: 2,
    existing: reviewAsset(`existing-${id}`, `existing-${id}.png`),
    candidate: reviewAsset(`candidate-${id}`, `candidate-${id}.png`),
  };
}

function reviewAsset(id: string, originalName: string) {
  return {
    asset: {
      id, title: null, originalName, byteSize: 2_048, width: 1920, height: 1080,
      collectedAt: "2026-08-09T00:00:00Z", favorite: false, sourceUrl: "https://x.com/user/status/1",
    },
    format: "PNG",
    classifications: [{ id: "tag", kind: "tag" as const, name: "아로나", parentId: "work" }],
  };
}

function reviewPage(items: SimilarityReviewSummary[], totalCount: number) {
  return { items, totalCount, nextCursor: null };
}

function reviewGateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(), currentLibrary: vi.fn(), listClassifications: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), deleteClassification: vi.fn(),
    listAssets: vi.fn(), indexMissingSimilarityHashes: vi.fn(),
    listSimilarityReviews: vi.fn(),
    decideSimilarityReview: vi.fn().mockResolvedValue({ status: "resolved", nextReviewId: "review-2" }),
    getAsset: vi.fn(), trashAsset: vi.fn(), trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn(), emptyTrash: vi.fn(), getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(), restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
    setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(), setAssetClassifications: vi.fn(), patchAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn(), ingestImage: vi.fn(),
  };
}
