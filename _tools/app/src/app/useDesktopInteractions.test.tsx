import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDesktopInteractions } from "./useDesktopInteractions";

afterEach(cleanup);

function Harness({ onBack = () => false }: { onBack?: () => boolean }) {
  useDesktopInteractions(onBack);
  return <button>대상</button>;
}

it("blocks the WebView context menu", () => {
  render(<Harness />);
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

  document.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
});

it("routes mouse button four through the shared back request", () => {
  const onBack = vi.fn(() => true);
  render(<Harness onBack={onBack} />);

  fireEvent.mouseUp(window, { button: 3 });
  fireEvent.mouseUp(window, { button: 4 });

  expect(onBack).toHaveBeenCalledOnce();
});

it("reads mouse button four from pointerup when the compatibility mouseup is suppressed", () => {
  const onBack = vi.fn(() => true);
  render(<Harness onBack={onBack} />);

  // e.g. over the video element, which cancels pointerdown
  fireEvent.pointerUp(window, { button: 3 });
  expect(onBack).toHaveBeenCalledOnce();

  // a normal press delivers pointerup and then mouseup in the same task: still one back
  onBack.mockClear();
  fireEvent.pointerUp(window, { button: 3 });
  fireEvent.mouseUp(window, { button: 3 });
  expect(onBack).toHaveBeenCalledOnce();
});
