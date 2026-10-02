import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

const deferred = vi.hoisted(() => ({ held: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useDeferredValue: <T,>(value: T) => {
    const result = actual.useDeferredValue(value);
    return deferred.held ? "old" : result;
  } };
});
afterEach(() => { cleanup(); deferred.held = false; });

it("does not run the previous query while the deferred result list is catching up", () => {
  const apply = vi.fn(), close = vi.fn();
  const props = { open: true, onClose: close, entries: [], search: {
    info: { kind: "query" as const, scope: "망가", label: "검색", query: "" }, apply, open: vi.fn(),
  } };
  const { rerender } = render(<CommandPalette {...props} />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "old" } });
  deferred.held = true;
  fireEvent.change(input, { target: { value: "new" } });
  expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("option")).toHaveTextContent("‘old’");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(apply).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("option"));
  expect(apply).not.toHaveBeenCalled();
  deferred.held = false;
  rerender(<CommandPalette {...props} />);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(apply).toHaveBeenCalledExactlyOnceWith("new");
});
