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
