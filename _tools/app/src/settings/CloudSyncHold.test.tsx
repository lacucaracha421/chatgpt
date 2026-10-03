import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CloudSyncHold } from "./CloudSyncHold";

afterEach(cleanup);

it("keeps receiving mode visible when release is scheduled", async () => {
  const read = vi.fn().mockResolvedValue({ held: true, releaseAfterRestart: false });
  const save = vi.fn().mockResolvedValue({ held: true, releaseAfterRestart: true });
  render(<CloudSyncHold endpoint="https://fixture.invalid" read={read} save={save} />);
  expect(await screen.findByText("받기만" )).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "보류 해제" }));
  expect(await screen.findByText("재시작 후 해제")).toBeVisible();
  expect(screen.getByText("받기만")).toBeVisible();
  expect(save).toHaveBeenCalledWith("https://fixture.invalid", false);
});

it("enables before credentials and retains content while saving", async () => {
  const read = vi.fn().mockResolvedValue({ held: false, releaseAfterRestart: false });
  let resolve!: (value: { held: boolean; releaseAfterRestart: boolean }) => void;
  const save = vi.fn().mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<CloudSyncHold endpoint="https://fixture.invalid" read={read} save={save} />);
  await userEvent.click(await screen.findByRole("button", { name: "송신 보류" }));
  expect(screen.getByText("받기·보내기")).toBeVisible();
  expect(screen.getByRole("button", { name: "송신 보류" })).toBeDisabled();
  resolve({ held: true, releaseAfterRestart: false });
  await waitFor(() => expect(screen.getByText("받기만")).toBeVisible());
});

it("does not claim sends are enabled when reading fails", async () => {
  render(<CloudSyncHold endpoint="https://fixture.invalid" read={vi.fn().mockRejectedValue(new Error())} save={vi.fn()} />);
  expect(await screen.findByText("송신 보류 상태를 확인하지 못했습니다.")).toBeVisible();
  expect(screen.queryByText("받기·보내기")).toBeNull();
});

it("shows tablet changes waiting for missing IDs", async () => {
  render(<CloudSyncHold endpoint="https://fixture.invalid" read={vi.fn().mockResolvedValue({ held: true, releaseAfterRestart: false, tabletWait: { count: 2, targetIds: ["collection-a"] } })} save={vi.fn()} />);
  expect(await screen.findByText(/태블릿 변경 2개가 누락된 항목을 기다립니다 · collection-a/)).toBeVisible();
});
