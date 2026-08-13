import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkTray } from "./WorkTray";

it("shows metadata folder import skips and retries the whole folder", () => {
  const retry = vi.fn();
  render(<WorkTray
    works={[{ kind: "metadata_import", id: "metadata-1", folder: "C:\\export", total: 1, completed: 1, added: 1, foldersCreated: 2, pathsReused: 1, exactDuplicates: [], reviewPending: [], skipped: [{ fileName: "missing.jpg", message: "원본 파일이 없습니다." }], failures: [], status: "completed" }]}
    retryFailed={retry}
    dismissWork={vi.fn()}
    openReview={vi.fn()}
    openExisting={vi.fn()}
  />);
  expect(screen.getByText(/건너뜀 1/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "폴더 다시 가져오기" }));
  expect(retry).toHaveBeenCalledWith("metadata-1");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("dismisses a completed result after eight seconds", () => {
  vi.useFakeTimers();
  const dismissWork = vi.fn();
  render(<WorkTray works={[work({ id: "done", status: "completed" })]} retryFailed={vi.fn()} dismissWork={dismissWork} openReview={vi.fn()} openExisting={vi.fn()} />);

  act(() => vi.advanceTimersByTime(7_999));
  expect(dismissWork).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(dismissWork).toHaveBeenCalledWith("done");
});

it("does not dismiss running work", () => {
  vi.useFakeTimers();
  const dismissWork = vi.fn();
  render(<WorkTray works={[work({ status: "running" })]} retryFailed={vi.fn()} dismissWork={dismissWork} openReview={vi.fn()} openExisting={vi.fn()} />);

  act(() => vi.advanceTimersByTime(8_000));
  expect(dismissWork).not.toHaveBeenCalled();
});

it("pauses completed result dismissal while the pointer is inside", () => {
  vi.useFakeTimers();
  const dismissWork = vi.fn();
  render(<WorkTray works={[work({ id: "hovered", status: "completed" })]} retryFailed={vi.fn()} dismissWork={dismissWork} openReview={vi.fn()} openExisting={vi.fn()} />);
  const row = screen.getByText("가져오기 결과").closest(".work-tray__row")!;

  act(() => vi.advanceTimersByTime(3_000));
  fireEvent.pointerEnter(row);
  act(() => vi.advanceTimersByTime(8_000));
  expect(dismissWork).not.toHaveBeenCalled();
  fireEvent.pointerLeave(row);
  act(() => vi.advanceTimersByTime(4_999));
  expect(dismissWork).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(dismissWork).toHaveBeenCalledWith("hovered");
});

it("pauses completed result dismissal while an action has focus", () => {
  vi.useFakeTimers();
  const dismissWork = vi.fn();
  render(<WorkTray works={[work({ id: "focused", status: "completed" })]} retryFailed={vi.fn()} dismissWork={dismissWork} openReview={vi.fn()} openExisting={vi.fn()} />);
  const row = screen.getByText("가져오기 결과").closest(".work-tray__row")!;
  const action = row.querySelector("button")!;

  act(() => vi.advanceTimersByTime(3_000));
  fireEvent.focus(action);
  act(() => vi.advanceTimersByTime(8_000));
  expect(dismissWork).not.toHaveBeenCalled();
  fireEvent.blur(action);
  act(() => vi.advanceTimersByTime(4_999));
  expect(dismissWork).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(dismissWork).toHaveBeenCalledWith("focused");
});

it("limits metadata result details and preserves the full visible message", () => {
  const longDetail = "first-very-long-file-name.jpg: 원본 파일이 없습니다.";
  render(<WorkTray
    works={[{
      kind: "metadata_import",
      id: "metadata-details",
      folder: "C:\\export",
      total: 4,
      completed: 4,
      added: 0,
      foldersCreated: 0,
      pathsReused: 0,
      exactDuplicates: [],
      reviewPending: [],
      skipped: [
        { fileName: "first-very-long-file-name.jpg", message: "원본 파일이 없습니다." },
        { fileName: "second.jpg", message: "원본 파일이 없습니다." },
        { fileName: "third.jpg", message: "원본 파일이 없습니다." },
      ],
      failures: [{ fileName: "fourth.jpg", message: "읽지 못했습니다." }],
      status: "failed",
    }]}
    retryFailed={vi.fn()}
    dismissWork={vi.fn()}
    openReview={vi.fn()}
    openExisting={vi.fn()}
  />);

  expect(screen.getByText(longDetail)).toHaveClass("work-tray__detail");
  expect(screen.getByText(longDetail)).toHaveAttribute("title", longDetail);
  expect(screen.getByText("외 1건")).toBeVisible();
  expect(screen.queryByText(/fourth\.jpg/)).not.toBeInTheDocument();
});

it("offers an explicit result dismiss action", () => {
  const dismissWork = vi.fn();
  render(<WorkTray works={[work({ id: "manual", status: "completed" })]} retryFailed={vi.fn()} dismissWork={dismissWork} openReview={vi.fn()} openExisting={vi.fn()} />);

  fireEvent.click(screen.getByRole("button", { name: "결과 닫기" }));
  expect(dismissWork).toHaveBeenCalledWith("manual");
});

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
  await user.click(screen.getByRole("button", { name: "결과 닫기" }));

  expect(openExisting).toHaveBeenCalledWith("existing");
  expect(openReview).toHaveBeenCalledOnce();
  expect(retryFailed).toHaveBeenCalledWith("work-result");
  expect(dismissWork).toHaveBeenCalledWith("work-result");
});

it("shows video preparation progress, completion, and retry", async () => {
  const retryFailed = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <WorkTray
      works={[work({ kind: "preparation", id: "video", total: 2, completed: 1, status: "running" })]}
      retryFailed={retryFailed}
      dismissWork={vi.fn()}
      openReview={vi.fn()}
      openExisting={vi.fn()}
    />,
  );
  expect(screen.getByText(/미리보기/)).toHaveTextContent("1 / 2");

  rerender(
    <WorkTray
      works={[work({ kind: "preparation", id: "video", failures: [{ fileName: "v1", message: "failed" }], status: "failed" })]}
      retryFailed={retryFailed}
      dismissWork={vi.fn()}
      openReview={vi.fn()}
      openExisting={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: /미리보기.*다시/ }));
  expect(retryFailed).toHaveBeenCalledWith("video");
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
