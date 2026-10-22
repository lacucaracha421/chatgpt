import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { FOLDER_PINS_PENDING_KEY, pinCommands, useFolderPins, type FolderPinsReply } from "./useFolderPins";

beforeEach(() => localStorage.removeItem(FOLDER_PINS_PENDING_KEY));
afterEach(() => { cleanup(); vi.useRealTimers(); });

const reply = (revision: number, pinnedIds: string[]): FolderPinsReply => ({ version: 1, revision, pinnedIds });
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

function mount(local: string[], folderPins: ReturnType<typeof vi.fn>, changeFolderPins: ReturnType<typeof vi.fn>) {
  const gateway = { folderPins, changeFolderPins } as unknown as LibraryGateway;
  return renderHook(() => {
    const [pins, setPins] = useState(local);
    return { pins, change: useFolderPins(gateway, "root", pins, setPins) };
  });
}

it("turns a pin list edit into per-id commands", () => {
  expect(pinCommands(["a", "b"], ["a", "b", "c"])).toEqual([{ op: "add", ids: ["c"] }]);
  expect(pinCommands(["a", "b"], ["b"])).toEqual([{ op: "remove", ids: ["a"] }]);
  expect(pinCommands(["a", "b"], ["b", "a"])).toEqual([{ op: "order", ids: ["b", "a"] }]);
  expect(pinCommands(["a"], ["a"])).toEqual([]);
});

it("imports this PC's local pins once when the server list was never written", async () => {
  vi.useFakeTimers();
  const folderPins = vi.fn().mockResolvedValue(reply(0, []));
  const changeFolderPins = vi.fn().mockResolvedValue(reply(1, ["a", "b"]));
  const view = mount(["a", "b"], folderPins, changeFolderPins);
  await settle();
  expect(changeFolderPins).toHaveBeenCalledWith([{ op: "add", ids: ["a", "b"] }]);
  expect(view.result.current.pins).toEqual(["a", "b"]);
});

it("takes the server list over once it has one, and keeps local pins when it cannot be reached", async () => {
  vi.useFakeTimers();
  const folderPins = vi.fn().mockResolvedValueOnce(reply(3, ["x"])).mockRejectedValue(new Error("offline"));
  const changeFolderPins = vi.fn();
  const view = mount(["a"], folderPins, changeFolderPins);
  await settle();
  expect(changeFolderPins).not.toHaveBeenCalled();
  expect(view.result.current.pins).toEqual(["x"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(folderPins.mock.calls.length).toBeGreaterThan(1);
  expect(view.result.current.pins).toEqual(["x"]);
});

it("shows an edit at once, sends it, and adopts a pin the tablet added meanwhile", async () => {
  vi.useFakeTimers();
  const folderPins = vi.fn().mockResolvedValue(reply(2, ["a"]));
  const changeFolderPins = vi.fn().mockResolvedValue(reply(3, ["a", "b", "tablet"]));
  const view = mount([], folderPins, changeFolderPins);
  await settle();
  act(() => view.result.current.change(["a", "b"]));
  expect(view.result.current.pins).toEqual(["a", "b"]);
  await settle();
  expect(changeFolderPins).toHaveBeenCalledWith([{ op: "add", ids: ["b"] }]);
  expect(view.result.current.pins).toEqual(["a", "b", "tablet"]);
});

it("keeps an edit made while the server is unreachable and sends it on the next try", async () => {
  vi.useFakeTimers();
  const folderPins = vi.fn().mockResolvedValue(reply(2, ["a"]));
  const changeFolderPins = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(reply(3, ["a", "b"]));
  const view = mount(["a"], folderPins, changeFolderPins);
  await settle();
  act(() => view.result.current.change(["a", "b"]));
  await settle();
  expect(view.result.current.pins).toEqual(["a", "b"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
  expect(changeFolderPins).toHaveBeenCalledTimes(2);
  expect(changeFolderPins).toHaveBeenLastCalledWith([{ op: "add", ids: ["b"] }]);
  expect(localStorage.getItem(FOLDER_PINS_PENDING_KEY)).toBeNull();
  expect(view.result.current.pins).toEqual(["a", "b"]);
});

it("sends a long offline queue in batches the server accepts, and drops a refused batch", async () => {
  vi.useFakeTimers();
  const queued = Array.from({ length: 25 }, (_, index) => ({ op: "add", ids: [`f${index}`] }));
  localStorage.setItem(FOLDER_PINS_PENDING_KEY, JSON.stringify(queued));
  const folderPins = vi.fn().mockResolvedValue(reply(9, ["server"]));
  const changeFolderPins = vi.fn().mockImplementation((commands: unknown[]) => commands.length > 20
    ? Promise.reject({ code: "invalid_cloud_response" }) : Promise.resolve(reply(5, ["a"])));
  mount(["a"], folderPins, changeFolderPins);
  await settle();
  expect(changeFolderPins.mock.calls.map(([commands]) => commands.length)).toEqual([20, 5]);
  expect(localStorage.getItem(FOLDER_PINS_PENDING_KEY)).toBeNull();

  const refused = vi.fn().mockRejectedValue({ code: "cloud_asset_registration_rejected", message: "클라우드 자산 등록이 거부됐습니다: HTTP 422" });
  localStorage.setItem(FOLDER_PINS_PENDING_KEY, JSON.stringify([{ op: "add", ids: ["b"] }]));
  cleanup();
  const view = mount(["a"], folderPins, refused);
  await settle();
  expect(refused).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(FOLDER_PINS_PENDING_KEY)).toBeNull();
  expect(view.result.current.pins).toEqual(["server"]);
});
