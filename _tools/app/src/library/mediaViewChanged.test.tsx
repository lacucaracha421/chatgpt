import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMediaViewChanged } from "./mediaViewChanged";

const bridge = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));

function View({ scope, visible = true }: { scope: string; visible?: boolean }) {
  useMediaViewChanged(scope, visible);
  return null;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  bridge.invoke.mockClear();
});

it("notifies changed scopes without waiting for the command", () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  bridge.invoke.mockReturnValueOnce(new Promise(() => undefined));
  const { rerender } = render(<View scope="folder-a" />);
  expect(bridge.invoke).not.toHaveBeenCalled();
  rerender(<View scope="folder-b" />);
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("media_view_changed");
  rerender(<View scope="folder-b" />);
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
});

it("ignores hidden retained scopes and works without Tauri", () => {
  const { rerender } = render(<View scope="a" />);
  rerender(<View scope="b" />);
  expect(bridge.invoke).not.toHaveBeenCalled();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  rerender(<View scope="c" visible={false} />);
  rerender(<View scope="c" />);
  expect(bridge.invoke).not.toHaveBeenCalled();
});

it("ignores a rejected native notification", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  bridge.invoke.mockRejectedValueOnce(new Error("bridge unavailable"));
  const { rerender } = render(<View scope="a" />);
  rerender(<View scope="b" />);
  await Promise.resolve();
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("media_view_changed");
});
