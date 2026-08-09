import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkTray } from "./WorkTray";

afterEach(cleanup);

it("announces progress, shows only failed filenames, and retries one failed batch", async () => {
  const retryFailed = vi.fn();
  const user = userEvent.setup();
  render(<WorkTray works={[
    work({ id: "work-1", total: 3, completed: 1, added: 1, status: "running" }),
    work({ id: "work-2", total: 2, completed: 2, added: 1, failures: [{ fileName: "broken.png", message: "지원하지 않는 이미지" }], status: "failed" }),
  ]} retryFailed={retryFailed} dismissWork={vi.fn()} openReview={vi.fn()} openExisting={vi.fn()} />);

  expect(screen.getByText(/가져오는 중/)).toHaveTextContent("1 / 3");
  expect(screen.getByText("broken.png")).toBeInTheDocument();
  expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "실패 파일 다시 시도" }));
  expect(retryFailed).toHaveBeenCalledWith("work-2");
});

it("keeps completed results and exposes duplicate, review, retry, and dismiss actions", async () => {
  const user = userEvent.setup();
  const retryFailed = vi.fn();
  const dismissWork = vi.fn();
  const openReview = vi.fn();
  const openExisting = vi.fn();
  render(<WorkTray
    works={[work({
      id: "work-result",
      total: 4,
      completed: 4,
      added: 1,
      exactDuplicates: [{ fileName: "same.png", existingAssetId: "existing" }],
      reviewPending: [{ fileName: "variant.jpg", reviewId: "review" }],
      failures: [{ fileName: "bad.txt", message: "지원하지 않는 파일" }],
      status: "failed",
    })]}
    retryFailed={retryFailed}
    dismissWork={dismissWork}
    openReview={openReview}
    openExisting={openExisting}
  />);

  expect(screen.getByRole("button", { name: /same.png/ })).toBeInTheDocument();
  expect(screen.getByText("variant.jpg")).toBeInTheDocument();
  expect(screen.getByText("bad.txt")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /same.png/ }));
  await user.click(screen.getByRole("button", { name: /검토 대기.*열기/ }));
  await user.click(screen.getByRole("button", { name: /실패.*다시/ }));
  await user.click(screen.getByRole("button", { name: "닫기" }));

  expect(openExisting).toHaveBeenCalledWith("existing");
  expect(openReview).toHaveBeenCalledOnce();
  expect(retryFailed).toHaveBeenCalledWith("work-result");
  expect(dismissWork).toHaveBeenCalledWith("work-result");
});

function work(overrides: Partial<import("./useFileDrop").IngestionWork> = {}): import("./useFileDrop").IngestionWork {
  return {
    kind: "ingestion",
    id: "work",
    total: 1,
    completed: 1,
    added: 0,
    exactDuplicates: [],
    reviewPending: [],
    failures: [],
    status: "completed",
    ...overrides,
  };
}
