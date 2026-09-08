import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WindowResizeHandles } from "./WindowResizeHandles";

const native = vi.hoisted(() => ({
  maximized: false, fullscreen: false, resizable: true,
  resize: vi.fn().mockResolvedValue(undefined),
  unlisten: vi.fn(), listener: () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  isMaximized: async () => native.maximized,
  isFullscreen: async () => native.fullscreen,
  isResizable: async () => native.resizable,
  onResized: async (listener: () => void) => { native.listener = listener; return native.unlisten; },
  startResizeDragging: native.resize,
}) }));
afterEach(() => { cleanup(); native.maximized = false; native.fullscreen = false; native.resizable = true; vi.clearAllMocks(); });

it("dispatches native resize directions only for primary-button drags", async () => {
  const { container } = render(<WindowResizeHandles />);
  await waitFor(() => expect(container.querySelectorAll(".window-resize__handle")).toHaveLength(8));
  for (const direction of ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"]) {
    const handle = container.querySelector(`.window-resize__handle--${direction}`)!;
    fireEvent.mouseDown(handle, { button: 2 });
    expect(native.resize).not.toHaveBeenCalled();
    fireEvent.mouseDown(handle, { button: 0 });
    expect(native.resize).toHaveBeenCalledWith(direction);
    native.resize.mockClear();
  }
});

it("hides the targets while maximized or fullscreen and cleans up its listener", async () => {
  const { container, unmount } = render(<WindowResizeHandles />);
  await waitFor(() => expect(container.firstChild).not.toBeNull());
  native.maximized = true;
  await act(async () => native.listener());
  expect(container.firstChild).toBeNull();
  native.maximized = false;
  native.fullscreen = true;
  await act(async () => native.listener());
  expect(container.firstChild).toBeNull();
  native.fullscreen = false;
  await act(async () => native.listener());
  expect(container.firstChild).not.toBeNull();
  unmount();
  await waitFor(() => expect(native.unlisten).toHaveBeenCalledOnce());
});
