import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CatalogReviewPage, LibraryGateway } from "../library/types";
import { CatalogReviewDialog } from "./CatalogReviewDialog";

afterEach(cleanup);
function setup() {
  const w = { workId: "1", groupId: "group-a", title: "Candidate Alpha", titleJpn: "日本語タイトル", pages: 20, category: 2, creators: ["artist:alice"], languages: ["korean"] };
  const data: CatalogReviewPage = { rows: [{ leftAnchor: "1", rightAnchor: "2", reviewToken: "displayed-evidence", state: "pending", actionable: true, evidence: { left: w, right: { ...w, workId: "2", groupId: "group-b" }, reason: "제목·작가·페이지·언어 일치", algorithm: "v1" } }], inspectedWorks: 2, comparisons: 1, skippedBuckets: 0 };
  const gateway = { listCatalogReview: vi.fn().mockResolvedValue(data), generateCatalogReview: vi.fn().mockResolvedValue(data), decideCatalogReview: vi.fn().mockResolvedValue(undefined) };
  const changed = vi.fn();
  render(<LibraryProvider gateway={gateway as unknown as LibraryGateway}><CatalogReviewDialog onClose={vi.fn()} onChange={changed} /></LibraryProvider>);
  return { gateway, data, changed };
}
it("opens read-only, shows evidence and explicitly generates candidates", async () => {
  const { gateway } = setup();
  expect(await screen.findByText("제목·작가·페이지·언어 일치")).toBeVisible();
  expect(screen.getAllByText("artist:alice")).toHaveLength(2);
  expect(screen.getAllByText("20페이지 · korean · 만화")).toHaveLength(2);
  expect(gateway.generateCatalogReview).not.toHaveBeenCalled();
  expect(gateway.decideCatalogReview).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "후보 생성" }));
  await waitFor(() => expect(gateway.generateCatalogReview).toHaveBeenCalledTimes(1));
});
it("confirms then splits through explicit actions and refreshes the catalog", async () => {
  const { gateway, data, changed } = setup();
  await screen.findByText("검토 대기");
  gateway.listCatalogReview.mockResolvedValue({ ...data, rows: [{ ...data.rows[0], state: "confirm" }] });
  await userEvent.click(screen.getByRole("button", { name: "같은 작품으로 확인" }));
  expect(await screen.findByRole("button", { name: "분리" })).toBeEnabled();
  expect(gateway.decideCatalogReview).toHaveBeenCalledWith({ leftAnchor: "1", rightAnchor: "2", reviewToken: "displayed-evidence", decision: "confirm" });
  gateway.listCatalogReview.mockResolvedValue({ ...data, rows: [{ ...data.rows[0], state: "split" }] });
  await userEvent.click(screen.getByRole("button", { name: "분리" }));
  expect(await screen.findByText("분리됨")).toBeVisible();
  expect(gateway.decideCatalogReview).toHaveBeenLastCalledWith({ leftAnchor: "1", rightAnchor: "2", reviewToken: "displayed-evidence", decision: "split" });
  expect(changed).toHaveBeenCalledTimes(2);
});
it("persists rejection and exposes failed saves without optimistic grouping", async () => {
  const { gateway, data, changed } = setup();
  await screen.findByText("검토 대기");
  gateway.decideCatalogReview.mockRejectedValueOnce(new Error("stale candidate"));
  await userEvent.click(screen.getByRole("button", { name: "다른 작품" }));
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
  gateway.listCatalogReview.mockResolvedValue({ ...data, rows: [{ ...data.rows[0], state: "falsePositive" }] });
  await userEvent.click(screen.getByRole("button", { name: "다른 작품" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "다른 작품" })).not.toBeInTheDocument());
  expect(gateway.decideCatalogReview).toHaveBeenLastCalledWith({ leftAnchor: "1", rightAnchor: "2", reviewToken: "displayed-evidence", decision: "falsePositive" });
});
