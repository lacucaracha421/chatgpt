import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
vi.mock("../app/workloadProfile", () => ({ nativeWorkload: () => true }));
import { useActivityRegistry } from "./useActivityRegistry";
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("reads once, listens once, and rejects a snapshot overtaken by an event", async () => {
  let emit!: (event: { payload: unknown }) => void;
  let initial!: (value: unknown) => void;
  const stop = vi.fn();
  api.listen.mockImplementation(async (_name, callback) => { emit = callback; return stop; });
  api.invoke.mockImplementation(() => new Promise(resolve => { initial = resolve; }));
  function Harness() { const jobs = useActivityRegistry(); return <span>{jobs.map(job => job.label).join(",")}</span>; }
  const { unmount } = render(<Harness />);
  await act(async () => {});
  act(() => emit({ payload: { revision: 2, jobs: [{ id: "a", label: "new" }] } }));
  await act(async () => initial({ revision: 1, jobs: [{ id: "a", label: "old" }] }));
  expect(screen.getByText("new")).toBeVisible();
  expect(api.invoke).toHaveBeenCalledExactlyOnceWith("activity_snapshot");
  expect(api.listen).toHaveBeenCalledExactlyOnceWith("library://activities-changed", expect.any(Function));
  unmount(); expect(stop).toHaveBeenCalledTimes(1);
});
