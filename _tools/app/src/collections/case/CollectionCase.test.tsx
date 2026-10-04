import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseInside, casePlatform, CollectionCase, type CaseData } from "./CollectionCase";
import { useState } from "react";
import { readFileSync } from "node:fs";
const caseStyles = readFileSync("src/collections/case/CollectionCase.css", "utf8");
afterEach(cleanup);
const data: CaseData = { title: "게임", front: "/front", platform: "sw2", publisher: "배급사", privacy: false };
function Case({ value = data }: { value?: CaseData }) {
  const [open, setOpen] = useState(false);
  return <CollectionCase data={value} open={open} onOpenChange={setOpen} />;
}
describe("CollectionCase", () => {
  it("refits the opening case on the unfolding's curve instead of snapping smaller first", () => {
    vi.useFakeTimers();
    const style = document.createElement("style"); style.textContent = caseStyles; document.head.append(style);
    try {
      const stageBox = { width: 900, height: 700 };
      const view = render(<CollectionCase data={data} stageBox={stageBox} large open={false} onOpenChange={vi.fn()} />);
      const root = view.container.querySelector<HTMLElement>(".collection-case")!, kase = root.querySelector<HTMLElement>(".kase")!;
      const closedScale = root.style.getPropertyValue("--case-scale");
      // A stage resize or settling cover applies at once: no scale transition at rest.
      expect(root).not.toHaveAttribute("data-unfolding");
      expect(getComputedStyle(kase).transition).not.toContain("scale");
      view.rerender(<CollectionCase data={data} stageBox={stageBox} large open onOpenChange={vi.fn()} />);
      // The open case is twice as wide, so its fit shrinks; that change moves with the rotation and lid.
      expect(Number(root.style.getPropertyValue("--case-scale"))).toBeLessThan(Number(closedScale));
      expect(root).toHaveAttribute("data-unfolding");
      expect(getComputedStyle(kase).transition).toBe("transform 560ms var(--ease-standard), scale 560ms var(--ease-standard)");
      act(() => vi.advanceTimersByTime(600));
      expect(root).not.toHaveAttribute("data-unfolding");
      view.rerender(<CollectionCase data={data} stageBox={stageBox} large open={false} onOpenChange={vi.fn()} />);
      expect(root).toHaveAttribute("data-unfolding");
      expect(root.style.getPropertyValue("--case-scale")).toBe(closedScale);
    } finally { style.remove(); vi.useRealTimers(); }
  });
  it("prints each AV rim on its own one-turn text path without waiting for portraits", () => {
    const ready = vi.fn();
    const av = { ...data, platform: "av" as const, front: null, discLabel: "ABC-123 · Maker · Label" };
    const { container } = render(<>
      <CollectionCase data={av} open onOpenChange={vi.fn()} onReady={ready} inside={<CaseInside title="AV" type="av" record={[]} facts={[]} people={[{ id: "person", name: "Performer", role: "performer", order: 0, portrait: <img src="/pending-portrait" alt="Performer portrait" /> }]} />}/>
      <CollectionCase data={av} open onOpenChange={vi.fn()} />
    </>);
    const paths = [...container.querySelectorAll("textPath")];
    expect(paths).toHaveLength(2);
    expect(paths[0]).toHaveTextContent("ABC-123 · Maker · Label");
    expect(Number(paths[0]!.getAttribute("textLength"))).toBeCloseTo(2 * Math.PI * 82);
    expect(paths[0]!.getAttribute("href")).not.toBe(paths[1]!.getAttribute("href"));
    expect(container.querySelector(".case-pola")).toBeInTheDocument();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("img", { name: "Performer portrait" })).toBeNull();
    fireEvent.error(screen.getByAltText("Performer portrait"));
    expect(screen.getByAltText("Performer portrait")).not.toBeVisible();
    expect(container.querySelector(".case-silhouette")).toBeVisible();
    expect(ready).toHaveBeenCalledTimes(1);
  });
  it("removes AV rim text, booklet and portraits immediately in privacy mode", () => {
    const av = { ...data, platform: "av" as const, front: null, discLabel: "SECRET-123 · Maker · Label" };
    const inside = <CaseInside title="Secret" type="av" record={[]} facts={[["품번", "SECRET-123"]]} people={[{ id: "person", name: "Performer", role: "performer", order: 0, portrait: <img src="/portrait" alt="Performer portrait" /> }]} />;
    const { container, rerender } = render(<CollectionCase data={av} open onOpenChange={vi.fn()} inside={inside} />);
    expect(container.querySelector("textPath")).toBeInTheDocument();
    rerender(<CollectionCase data={{ ...av, privacy: true }} open onOpenChange={vi.fn()} inside={inside} />);
    expect(container.querySelector("textPath, .case-cast, .case-av-book, img")).toBeNull();
    expect(container.querySelector(".k-inner .case-mask")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("SECRET-123");
  });
  it("builds both trays with outer walls, inner faces and rim lips", () => {
    const { container } = render(<Case />);
    for (const tray of ["base", "lid"]) {
      for (const wall of ["top", "bottom", "outer"]) {
        expect(container.querySelector(`.k-${tray}-wall.k-wall-${wall}`)).not.toBeNull();
        expect(container.querySelector(`.k-${tray}-wall.k-wall-${wall}-in`)).not.toBeNull();
        expect(container.querySelector(`.k-${tray}-lip.k-lip-${wall}`)).not.toBeNull();
      }
    }
    expect(container.querySelector(".k-ridge")).not.toBeNull();
    expect(container.querySelectorAll(".k-lid .k-lid-wall")).toHaveLength(6);
  });
  it("folds the lid a full 90 degrees relative to the spine", () => {
    render(<Case />);
    fireEvent.keyDown(screen.getByRole("group", { name: "케이스" }), { key: "Enter" });
    expect(document.querySelector(".kase")).toHaveStyle({ "--open": "1" });
    // jsdom cannot resolve CSS 3D matrices; keep the angle contract explicit.
    expect(caseStyles).toMatch(/\.k-hinge > \.k-lid\s*\{[^}]*transform: rotateY\(calc\(90deg - var\(--open\) \* 90deg\)\)/);
  });
  it("puts the unfolded inner hinge on the same plane as the lid floor", () => {
    const transform = (face: string) => caseStyles.match(new RegExp(`\\.collection-case \\.${face} \\{[^}]*?transform: ([^;]+);`))?.[1];
    // Both are children of the flat hinge when open; a missing thickness leaves a visible step.
    expect(transform("k-spine-in")).toBe(transform("k-inner"));
    expect(transform("k-inner")).toBe("translateZ(calc(var(--t) * -1)) rotateY(180deg)");
  });
  it("never paints a generic spine while the chosen spine decodes", async () => {
    const ready = vi.fn();
    const { container } = render(<CollectionCase data={{ ...data, front: null, spine: "/slow-spine" }} open={false} onOpenChange={vi.fn()} onReady={ready} />);
    const image = container.querySelector<HTMLImageElement>('img[src="/slow-spine"]')!;
    let decode!: () => void;
    image.decode = () => new Promise<void>(resolve => { decode = resolve; });
    fireEvent.load(image);
    expect(container.querySelector("[data-spine-template]")).toBeNull();
    expect(ready).not.toHaveBeenCalled();
    await act(async () => decode());
    expect(image).toBeVisible();
    expect(ready).toHaveBeenCalledTimes(1);
  });
  it("commits a failed spine fallback before announcing readiness", () => {
    const ready = vi.fn(() => expect(document.querySelector('[data-spine-template="sw2"]')).toBeVisible());
    const { container } = render(<CollectionCase data={{ ...data, front: null, spine: "/missing-spine" }} open={false} onOpenChange={vi.fn()} onReady={ready} />);
    fireEvent.error(container.querySelector('img[src="/missing-spine"]')!);
    expect(ready).toHaveBeenCalledTimes(1);
  });
  it("keeps an already painted failure fallback while a replacement spine loads", async () => {
    const props = { open: false, onOpenChange: vi.fn() };
    const { container, rerender } = render(<CollectionCase {...props} data={{ ...data, front: null, spine: "/failed" }} />);
    fireEvent.error(container.querySelector('img[src="/failed"]')!);
    const fallback = container.querySelector("[data-spine-template]");
    rerender(<CollectionCase {...props} data={{ ...data, front: null, spine: "/replacement" }} />);
    expect(fallback).toBeVisible();
    await act(async () => fireEvent.load(container.querySelector('img[src="/replacement"]')!));
    expect(fallback).not.toBeInTheDocument();
    expect(container.querySelector('img[src="/replacement"]')).toBeVisible();
  });
  it.each(["sw", "sw2", "ps5", "pc", "other", "film", "av"] as const)("uses the %s platform's media tray", platform => {
    const { container } = render(<Case value={{ ...data, platform }} />);
    const isCard = platform === "sw" || platform === "sw2";
    expect(container.querySelectorAll(".cart-slot")).toHaveLength(isCard ? 1 : 0);
    expect(container.querySelectorAll(".holder")).toHaveLength(isCard ? 0 : 1);
    if (isCard) {
      expect(container.querySelectorAll(".cart-slot .nub")).toHaveLength(2);
      expect(container.querySelectorAll(".tray-rib")).toHaveLength(2);
      expect(container.querySelector(".finger-notch")).not.toBeNull();
      expect(screen.getByText("GAME CARD")).toBeInTheDocument();
    } else {
      expect(container.querySelectorAll(".holder .thumb")).toHaveLength(2);
      expect(container.querySelector(".holder .hub")).not.toBeNull();
      expect(screen.getByText("PUSH")).toBeInTheDocument();
    }
  });
  it.each(["sw2", "av"] as const)("reuses the loaded front for the %s label without adding a readiness dependency", async platform => {
    const ready = vi.fn();
    const { container, rerender } = render(<CollectionCase data={{ ...data, platform }} open={false} onOpenChange={vi.fn()} onReady={ready} />);
    const label = container.querySelector<HTMLElement>(".media-label")!;
    expect(label.style.backgroundImage).toBe("");
    await act(async () => fireEvent.load(screen.getByRole("img", { name: "게임 앞면" })));
    expect(label.style.backgroundImage).toContain("/front");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(ready).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("group", { name: "케이스" }), { key: "ArrowRight" });
    rerender(<CollectionCase data={{ ...data, platform }} open onOpenChange={vi.fn()} onReady={ready} />);
    expect(ready).toHaveBeenCalledTimes(1);
  });
  it("keeps the supplied inside and note in the lid and base tray", () => {
    const { container } = render(<CollectionCase data={data} open onOpenChange={vi.fn()} inside={<b>Record content</b>} note={<b>Note content</b>} />);
    expect(container.querySelector(".k-lid .k-inner")).toHaveTextContent("Record content");
    expect(container.querySelector(".k-floor .note")).toHaveTextContent("Note content");
  });
  it("settles a failed front once and leaves the interior label unprinted", () => {
    const ready = vi.fn();
    const { container } = render(<CollectionCase data={data} open onOpenChange={vi.fn()} onReady={ready} />);
    fireEvent.error(screen.getByRole("img", { name: "게임 앞면" }));
    expect(ready).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLElement>(".media-label")!.style.backgroundImage).toBe("");
    fireEvent.keyDown(screen.getByRole("group", { name: "케이스" }), { key: "ArrowLeft" });
    expect(ready).toHaveBeenCalledTimes(1);
  });
  it("waits for a replacement front and announces each set of faces once", async () => {
    const ready = vi.fn();
    const { container, rerender } = render(<CollectionCase data={data} open onOpenChange={vi.fn()} onReady={ready} />);
    await act(async () => fireEvent.load(screen.getByRole("img", { name: "게임 앞면" })));
    expect(ready).toHaveBeenCalledTimes(1);
    rerender(<CollectionCase data={{ ...data, front: "/next-front" }} open onOpenChange={vi.fn()} onReady={ready} />);
    expect(container.querySelector<HTMLElement>(".media-label")!.style.backgroundImage).toBe("");
    expect(ready).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.load(screen.getByRole("img", { name: "게임 앞면" })));
    expect(container.querySelector<HTMLElement>(".media-label")!.style.backgroundImage).toContain("/next-front");
    expect(ready).toHaveBeenCalledTimes(2);
    await act(async () => fireEvent.load(screen.getByRole("img", { name: "게임 앞면" })));
    expect(ready).toHaveBeenCalledTimes(2);
  });
  it("settles privacy mode once without waiting for any artwork", () => {
    const ready = vi.fn();
    render(<CollectionCase data={{ ...data, privacy: true, back: "/back", spine: "/spine" }} open onOpenChange={vi.fn()} onReady={ready} />);
    expect(ready).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("group", { name: "케이스" }), { key: "ArrowRight" });
    expect(ready).toHaveBeenCalledTimes(1);
  });
  it("uses an untouched real spine ahead of the platform template after decoding", async () => {
    const { container } = render(<Case value={{ ...data, spine: "/spine" }} />);
    await act(async () => fireEvent.load(container.querySelector<HTMLImageElement>('img[src="/spine"]')!));
    expect(screen.getByRole("img", { name: "게임 책등" })).toHaveAttribute("src", "/spine");
    expect(container.querySelector("[data-spine-template]")).toBeNull();
  });
  it.each(["sw2", "sw", "ps5"] as const)("draws the %s package blocks without invented logos", platform => {
    const { container } = render(<Case value={{ ...data, platform }} />);
    expect(container.querySelector(`[data-spine-template="${platform}"]`)).not.toBeNull();
    expect(container.querySelector(".k-spine")).toHaveTextContent("게임");
    expect(container.querySelector(".k-spine")).toHaveTextContent("배급사");
    expect(container.querySelector(".t-head img")).toBeNull();
  });
  it("derives the template from actual platform data", () => {
    expect(casePlatform("Nintendo Switch 2 · PC")).toBe("sw2");
    expect(casePlatform("Nintendo Switch")).toBe("sw");
    expect(casePlatform("PC · PlayStation 5")).toBe("pc");
    expect(casePlatform("PC · Nintendo Switch 2")).toBe("pc");
    expect(casePlatform("PC · Nintendo Switch 2", "PS5")).toBe("ps5");
    expect(casePlatform("Nintendo Switch 2", "Xbox One")).toBe("other");
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
    expect(ready).toHaveBeenCalledTimes(1);
    expect(front.closest(".collection-case")).toHaveStyle({ "--ratio": String(600 / 900) });
  });
  it.each(["sw2", "av"] as const)("masks all artwork including the %s media label in privacy mode", async platform => {
    const { container, rerender } = render(<Case value={{ ...data, platform, spine: "/spine", back: "/back" }} />);
    await act(async () => fireEvent.load(screen.getByRole("img", { name: "게임 앞면" })));
    rerender(<Case value={{ ...data, platform, privacy: true, spine: "/spine", back: "/back" }} />);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    for (const face of [".k-front", ".k-back", ".k-spine", ".media-label"]) {
      expect(container.querySelector(`${face} .case-mask`)).not.toBeNull();
    }
    expect(container.querySelector<HTMLElement>(".media-label")!.style.backgroundImage).toBe("");
  });
});
