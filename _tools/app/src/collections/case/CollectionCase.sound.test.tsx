import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { CollectionCase, type CaseData } from "./CollectionCase";
import { playCaseSound } from "./caseSounds";

vi.mock("./caseSounds", async original => ({ ...await original<typeof import("./caseSounds")>(), playCaseSound: vi.fn(), preloadCaseSounds: vi.fn() }));
const play = vi.mocked(playCaseSound);
const data: CaseData = { title: "게임", front: null, platform: "ps5", privacy: false };
/** A work screen in miniature: the case's own click/key bumps the turn, as `pick` does on PC and tablet. */
function Screen({ work = "w1", active = true, initiallyOpen = false }: { work?: string; active?: boolean; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [turn, setTurn] = useState(0);
  return <CollectionCase data={data} open={open} sound={active ? { turn, work } : undefined} onOpenChange={next => { setOpen(next); setTurn(value => value + 1); }} />;
}
const toggle = () => fireEvent.keyDown(screen.getByRole("group", { name: "케이스" }), { key: "Enter" });
const lid = (container: HTMLElement) => container.querySelector<HTMLElement>(".k-lid")!;
function transitionEnd(target: HTMLElement, propertyName: string) {
  const event = new Event("transitionend", { bubbles: true });
  Object.assign(event, { propertyName });
  act(() => { target.dispatchEvent(event); });
}

beforeEach(() => { vi.useFakeTimers(); play.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("CollectionCase sounds", () => {
  it("plays nothing on mount, open or closed, or without a cue", () => {
    render(<><Screen /><Screen work="w2" initiallyOpen /><CollectionCase data={data} open onOpenChange={vi.fn()} /></>);
    act(() => vi.advanceTimersByTime(2000));
    expect(play).not.toHaveBeenCalled();
  });
  it("opens with one sound at once and closes with one as the lid lands", () => {
    render(<Screen />);
    toggle();
    expect(play.mock.calls).toEqual([["ps5", "open"]]);
    toggle();
    act(() => vi.advanceTimersByTime(529));
    expect(play).toHaveBeenCalledTimes(1);
    // 560 ms lid minus the clip's 30 ms attack.
    act(() => vi.advanceTimersByTime(1));
    expect(play.mock.calls).toEqual([["ps5", "open"], ["ps5", "close"]]);
    act(() => vi.advanceTimersByTime(2000));
    expect(play).toHaveBeenCalledTimes(2);
  });
  it("plays the close sound once when the lid's transform transition ends first", () => {
    const { container } = render(<Screen initiallyOpen />);
    toggle();
    transitionEnd(container.querySelector(".k-front")!, "transform");
    transitionEnd(lid(container), "opacity");
    expect(play).not.toHaveBeenCalled();
    transitionEnd(lid(container), "transform");
    expect(play.mock.calls).toEqual([["ps5", "close"]]);
    act(() => vi.advanceTimersByTime(2000));
    transitionEnd(lid(container), "transform");
    expect(play).toHaveBeenCalledTimes(1);
  });
  it("closes at once under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));
    render(<Screen initiallyOpen />);
    toggle();
    expect(play.mock.calls).toEqual([["ps5", "close"]]);
  });
  it("cancels a waiting close sound when the case reopens, the work changes, the surface goes inactive or unmounts", () => {
    const { rerender, unmount } = render(<Screen initiallyOpen />);
    toggle(); toggle();
    expect(play.mock.calls).toEqual([["ps5", "open"]]);
    act(() => vi.advanceTimersByTime(2000));
    expect(play).toHaveBeenCalledTimes(1);
    toggle();
    rerender(<Screen work="w2" />);
    act(() => vi.advanceTimersByTime(2000));
    expect(play).toHaveBeenCalledTimes(1);
    toggle(); toggle(); play.mockClear();
    rerender(<Screen work="w2" active={false} />);
    act(() => vi.advanceTimersByTime(2000));
    rerender(<Screen work="w2" />);
    act(() => vi.advanceTimersByTime(2000));
    expect(play).not.toHaveBeenCalled();
    toggle(); toggle(); play.mockClear();
    unmount();
    act(() => vi.advanceTimersByTime(2000));
    expect(play).not.toHaveBeenCalled();
  });
  it("stays silent when the open state changes without a user turn", () => {
    const { rerender } = render(<CollectionCase data={data} open sound={{ turn: 3, work: "w1" }} onOpenChange={vi.fn()} />);
    rerender(<CollectionCase data={data} open={false} sound={{ turn: 3, work: "w2" }} onOpenChange={vi.fn()} />);
    rerender(<CollectionCase data={data} open sound={{ turn: 3, work: "w2" }} onOpenChange={vi.fn()} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(play).not.toHaveBeenCalled();
  });
});
