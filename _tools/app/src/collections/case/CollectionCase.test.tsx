import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { casePlatform, CollectionCase, type CaseData } from "./CollectionCase";
import { useState } from "react";
afterEach(cleanup);
const data: CaseData = { title: "게임", front: "/front", platform: "sw2", publisher: "배급사", privacy: false };
function Case({ value = data }: { value?: CaseData }) {
  const [open, setOpen] = useState(false);
  return <CollectionCase data={value} open={open} onOpenChange={setOpen} />;
}
describe("CollectionCase", () => {
  it("uses an untouched real spine ahead of the platform template after decoding", async () => {
    const { container } = render(<Case value={{ ...data, spine: "/spine" }} />);
    await act(async () => fireEvent.load(container.querySelector<HTMLImageElement>('img[src="/spine"]')!));
    expect(screen.getByRole("img", { name: "게임 책등" })).toHaveAttribute("src", "/spine");
    expect(container.querySelector("[data-spine-template]")).toBeNull();
  });
  it.each(["sw2", "sw", "ps5"] as const)("draws the %s package blocks without invented logos", platform => {
    const { container } = render(<Case value={{ ...data, platform }} />);
    expect(container.querySelector(`[data-spine-template="${platform}"]`)).not.toBeNull();
    expect(screen.getAllByText("게임")).toHaveLength(1);
    expect(screen.getByText("배급사")).toBeInTheDocument();
    expect(container.querySelector(".t-head img")).toBeNull();
  });
  it("derives the template from actual platform data", () => {
    expect(casePlatform("Nintendo Switch 2 · PC")).toBe("sw2");
    expect(casePlatform("Nintendo Switch")).toBe("sw");
    expect(casePlatform("PC · PlayStation 5")).toBe("ps5");
    expect(casePlatform(null)).toBe("other");
  });
  it("rotates by keyboard, resets front, and folds open/closed", () => {
    render(<Case />);
    const object = screen.getByRole("group", { name: "케이스" });
    fireEvent.keyDown(object, { key: "ArrowRight" }); expect(object).toHaveAttribute("data-angle", "43");
    fireEvent.keyDown(object, { key: "ArrowLeft" }); expect(object).toHaveAttribute("data-angle", "28");
    fireEvent.keyDown(object, { key: "Home" }); expect(object).toHaveAttribute("data-angle", "0");
    fireEvent.keyDown(object, { key: "Enter" }); expect(object).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(object, { key: "Enter" }); expect(object).toHaveAttribute("aria-expanded", "false");
    // One click (no drag) opens; a drag never toggles.
    fireEvent.pointerDown(object, { button: 0, clientX: 100 }); fireEvent.pointerUp(object, { clientX: 100 }); expect(object).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(object, { button: 0, clientX: 100 }); fireEvent.pointerMove(object, { clientX: 160 }); fireEvent.pointerUp(object, { clientX: 160 }); expect(object).toHaveAttribute("aria-expanded", "true");
  });
  it("turns freely during a drag and stops on release", () => {
    render(<Case />);
    const object = screen.getByRole("group", { name: "케이스" });
    fireEvent.pointerDown(object, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(object, { pointerId: 1, clientX: 300 });
    expect(object).toHaveAttribute("data-angle", "148");
    fireEvent.pointerUp(object, { pointerId: 1 });
    fireEvent.pointerMove(object, { pointerId: 1, clientX: 400 });
    expect(object).toHaveAttribute("data-angle", "148");
  });
  it("uses the real cover ratio and settles only after every face decodes", async () => {
    const ready = vi.fn(); let resolve!: () => void;
    render(<CollectionCase data={{ ...data, spine: "/spine", back: "/back" }} open={false} onOpenChange={vi.fn()} onReady={ready} />);
    const front = screen.getByRole("img", { name: "게임 앞면" });
    Object.defineProperties(front, { naturalWidth: { value: 600 }, naturalHeight: { value: 900 }, decode: { value: () => new Promise<void>(r => { resolve = r; }) } });
    fireEvent.load(front); fireEvent.load(document.querySelector<HTMLImageElement>('img[src="/spine"]')!); fireEvent.load(screen.getByRole("img", { name: "게임 뒷면" }));
    expect(ready).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(ready).toHaveBeenCalled();
    expect(front.closest(".collection-case")).toHaveStyle({ "--ratio": String(600 / 900) });
  });
  it("masks all artwork in privacy mode", () => {
    render(<Case value={{ ...data, privacy: true, spine: "/spine", back: "/back" }} />);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });
});
