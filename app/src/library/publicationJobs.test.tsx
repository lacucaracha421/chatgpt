import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicationStatus } from "../layout/PublicationStatus";
import { dismissPublication, startPublication, type PublishProgress } from "./publicationJobs";

afterEach(() => { cleanup(); dismissPublication("catalog"); dismissPublication("collections"); });

it("keeps progress and duplicate protection across screen unmounts, completing only after the server returns", async () => {
  let progress!: (value: PublishProgress) => void;
  let complete!: (value: number) => void;
  const run = vi.fn((notify: (value: PublishProgress) => void) => { progress = notify; return new Promise<number>(resolve => { complete = resolve; }); });
  const first = render(<PublicationStatus />);
  let task!: Promise<void>;
  act(() => { task = startPublication("catalog", run, result => `${result}개 완료`); });
  first.unmount();
  act(() => { progress({ phase: "uploading", completed: 5, total: 10, unit: "bytes" }); });
  render(<PublicationStatus />);
  expect(screen.getByText(/50%/)).toBeTruthy();
  await act(async () => { await startPublication("catalog", run, String); });
  expect(run).toHaveBeenCalledTimes(1);
  act(() => { progress({ phase: "publishing", completed: 0, total: null, unit: "items" }); });
  expect(screen.getByText(/서버 반영/)).toBeTruthy();
  expect(screen.queryByText(/개 완료/)).toBeNull();
  await act(async () => { complete(12); await task; });
  expect(screen.getByText(/12개 완료/)).toBeTruthy();
});

it("retains errors after navigation and allows an explicit retry without blocking the other job", async () => {
  await act(async () => { await startPublication("collections", async () => { throw new Error("offline"); }, String); });
  const first = render(<PublicationStatus />);
  expect(screen.getByRole("alert")).toBeTruthy();
  first.unmount();
  render(<PublicationStatus />);
  expect(screen.getByRole("alert")).toBeTruthy();
  await act(async () => { await Promise.all([
    startPublication("collections", async () => 4, result => `${result}개 완료`),
    startPublication("catalog", async () => 9, result => `${result}개 완료`),
  ]); });
  expect(screen.getByText(/4개 완료/)).toBeTruthy();
  expect(screen.getByText(/9개 완료/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
