import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LONG_PRESS_MS, useLongPress } from "./useLongPress";

function Probe({ onLong, onClick, enabled = true }: { onLong: () => void; onClick: () => void; enabled?: boolean }) {
  const press = useLongPress({ onLongPress: onLong, enabled });
  return <button {...press.bind} onClick={press.click(onClick)}>대상</button>;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

const hold = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

it("fires after 450 ms of holding, then swallows only the click that follows", () => {
  const onLong = vi.fn(), onClick = vi.fn();
  render(<Probe onLong={onLong} onClick={onClick} />);
  const target = screen.getByRole("button");
  fireEvent.pointerDown(target, { button: 0, clientX: 20, clientY: 20 });
  hold(LONG_PRESS_MS - 1);
  expect(onLong).not.toHaveBeenCalled();
  hold(1);
  expect(onLong).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(target, { button: 0 });
  fireEvent.click(target);
  expect(onClick).not.toHaveBeenCalled();
  fireEvent.click(target);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("is a plain tap when released early", () => {
  const onLong = vi.fn(), onClick = vi.fn();
  render(<Probe onLong={onLong} onClick={onClick} />);
  const target = screen.getByRole("button");
  fireEvent.pointerDown(target, { button: 0, clientX: 20, clientY: 20 });
  hold(200);
  fireEvent.pointerUp(target, { button: 0 });
  fireEvent.click(target);
  hold(1000);
  expect(onLong).not.toHaveBeenCalled();
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("cancels when the finger moves past 10 px but not for a small tremor", () => {
  const onLong = vi.fn(), onClick = vi.fn();
  render(<Probe onLong={onLong} onClick={onClick} />);
  const target = screen.getByRole("button");
  fireEvent.pointerDown(target, { button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(target, { clientX: 26, clientY: 24 });
  hold(LONG_PRESS_MS);
  expect(onLong).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(target, { button: 0 });
  fireEvent.click(target);
  fireEvent.pointerDown(target, { button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(target, { clientX: 20, clientY: 40 });
  hold(LONG_PRESS_MS);
  expect(onLong).toHaveBeenCalledTimes(1);
});

it("lets the next tap through after the system took the touch for scrolling", () => {
  const onLong = vi.fn(), onClick = vi.fn();
  render(<Probe onLong={onLong} onClick={onClick} />);
  const target = screen.getByRole("button");
  fireEvent.pointerDown(target, { button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerCancel(target);
  hold(1000);
  fireEvent.click(target);
  expect(onLong).not.toHaveBeenCalled();
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("keeps the system menu and the gesture out of the way while disabled", () => {
  const onLong = vi.fn(), onClick = vi.fn();
  render(<Probe onLong={onLong} onClick={onClick} enabled={false} />);
  const target = screen.getByRole("button");
  fireEvent.pointerDown(target, { button: 0, clientX: 20, clientY: 20 });
  hold(1000);
  expect(onLong).not.toHaveBeenCalled();
  expect(fireEvent.contextMenu(target)).toBe(true);
});
