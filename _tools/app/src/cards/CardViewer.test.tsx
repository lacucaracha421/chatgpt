import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { CardViewer, CARD_VIEWER_FADE_MS } from "./CardViewer";
import type { CardData } from "./types";

const card = (name: string, changes: Partial<CardData> = {}): CardData => ({
  id: `${name}:sr`, characterId: `c-${name}`, characterName: name, seriesName: "별자리", tier: "sr", artAssetId: `a-${name}`,
  artUrl: `https://art.test/${name}.jpg`, artWidth: 1000, artHeight: 1400, count: 2, level: 3, firstDrawnAt: "2026-10-15T01:00:00Z", ...changes,
});
const list = [card("루나"), card("미카"), card("하나", { serial: "7", tier: "ssr", id: "하나:ssr" })];
let reduced = true;
const instant = () => Promise.resolve();
beforeEach(() => {
  vi.useFakeTimers(); reduced = true;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

/** A controlled host: the viewer index lives in state, as in the albums. */
function Host({ cards = list, start = 0, onClose = vi.fn(), preload = instant, ...rest }: {
  cards?: CardData[]; start?: number; onClose?: () => void; preload?: (card: CardData) => Promise<unknown>;
  onOpenAsset?: (id: string) => void; onCharacter?: (id: string) => void;
}) {
  const [index, setIndex] = useState(start);
  return <CardViewer cards={cards} index={index} onIndexChange={setIndex} onClose={onClose} preload={preload} {...rest} />;
}
const shownName = () => screen.getByRole("img", { name: /,/ }).getAttribute("aria-label")!;

it("opens as a dialog with the card, its details and the actions the album wires", async () => {
  const asset = vi.fn(), character = vi.fn();
  render(<Host start={2} onOpenAsset={asset} onCharacter={character} />); await settle();
  const dialog = screen.getByRole("dialog", { name: "하나 SSR 크게 보기" });
  expect(within(dialog).getByRole("img", { name: /SSR 하나/ })).toBeInTheDocument();
  const info = within(dialog).getByLabelText("카드 정보");
  for (const text of ["별자리", "SSR", "2장", "Lv.3", "10.15", "7"]) expect(info).toHaveTextContent(text);
  expect(within(dialog).getByText("3 / 3")).toBeInTheDocument();
  fireEvent.click(within(info).getByRole("button", { name: "원본 열기" })); expect(asset).toHaveBeenCalledWith("a-하나");
  fireEvent.click(within(info).getByRole("button", { name: "캐릭터 폴더" })); expect(character).toHaveBeenCalledWith("c-하나");
});

it("shows no dead buttons when the album wires no callbacks", async () => {
  render(<Host />); await settle();
  expect(screen.queryByRole("button", { name: "원본 열기" })).toBeNull();
  expect(screen.queryByRole("button", { name: "캐릭터 폴더" })).toBeNull();
});

it("closes with the close button and with Escape", async () => {
  const onClose = vi.fn();
  render(<Host onClose={onClose} />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "닫기" })); expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); expect(onClose).toHaveBeenCalledTimes(2);
});

it("steps through the list with the arrow keys and the buttons, and stops at both ends", async () => {
  render(<Host />); await settle();
  const dialog = screen.getByRole("dialog");
  expect(screen.getByRole("button", { name: "이전 카드" })).toBeDisabled();
  fireEvent.keyDown(dialog, { key: "ArrowLeft" }); await settle();
  expect(shownName()).toContain("루나");
  fireEvent.keyDown(dialog, { key: "ArrowRight" }); await settle();
  expect(shownName()).toContain("미카"); expect(screen.getByText("2 / 3")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다음 카드" })); await settle();
  expect(shownName()).toContain("하나");
  fireEvent.keyDown(dialog, { key: "ArrowRight" }); await settle();
  expect(shownName()).toContain("하나"); expect(screen.getByRole("button", { name: "다음 카드" })).toBeDisabled();
  fireEvent.keyDown(dialog, { key: "ArrowLeft" }); await settle();
  expect(shownName()).toContain("미카");
});

const flick = (target: Element, from: number, to: number, y = 0, endY = 0) => {
  fireEvent.pointerDown(target, { pointerType: "touch", clientX: from, clientY: y });
  fireEvent.pointerUp(target, { pointerType: "touch", clientX: to, clientY: endY });
};
it("swipes between cards, but a short, vertical or mouse drag does not", async () => {
  render(<Host start={1} />); await settle();
  const stage = document.querySelector(".card-viewer__stage")!;
  flick(stage, 300, 280); await settle(); expect(shownName()).toContain("미카");           // too short
  flick(stage, 300, 200, 0, 140); await settle(); expect(shownName()).toContain("미카");    // mostly vertical
  fireEvent.pointerDown(stage, { pointerType: "mouse", clientX: 300 }); fireEvent.pointerUp(stage, { pointerType: "mouse", clientX: 100 });
  await settle(); expect(shownName()).toContain("미카");
  flick(stage, 300, 120); await settle(); expect(shownName()).toContain("하나");            // swipe left = next
  flick(stage, 120, 300); await settle(); expect(shownName()).toContain("미카");            // swipe right = previous
});

it("toggles the info on a tap of the empty backdrop but not on a tap of the card", async () => {
  render(<Host />); await settle();
  const info = screen.getByLabelText("카드 정보"), layer = document.querySelector(".card-viewer__layer")!;
  expect(info).toHaveAttribute("data-open", "true");
  fireEvent.click(screen.getByRole("img", { name: /루나/ })); expect(info).toHaveAttribute("data-open", "true");
  fireEvent.click(layer); expect(info).toHaveAttribute("data-open", "false");
  fireEvent.click(layer); expect(info).toHaveAttribute("data-open", "true");
});

it("keeps the current card until the next one is ready, then cross-fades; the old layer leaves after the fade", async () => {
  reduced = false;
  let ready!: () => void; const gate = new Promise<void>(resolve => { ready = resolve; });
  render(<Host preload={card => card.characterName === "미카" ? gate : Promise.resolve()} />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "다음 카드" })); await settle(500);
  expect(shownName()).toContain("루나");                                       // still the old card: no blank
  expect(document.querySelectorAll(".card-viewer__layer")).toHaveLength(1);
  ready(); await settle();
  expect(shownName()).toContain("미카");
  expect(document.querySelectorAll(".card-viewer__layer--out")).toHaveLength(1);
  expect(document.querySelectorAll(".card-viewer__layer--in")).toHaveLength(1);
  await settle(CARD_VIEWER_FADE_MS + 100);
  expect(document.querySelectorAll(".card-viewer__layer--out")).toHaveLength(0);
});

it("under reduced motion the swap is instant, without a second layer", async () => {
  render(<Host />); await settle();
  expect(document.querySelector(".card-viewer")).toHaveAttribute("data-reduced", "true");
  fireEvent.click(screen.getByRole("button", { name: "다음 카드" })); await settle();
  expect(shownName()).toContain("미카");
  expect(document.querySelectorAll(".card-viewer__layer")).toHaveLength(1);
});

it("a fast second step skips the card still being prepared and shows the latest one", async () => {
  let release!: () => void; const slow = new Promise<void>(resolve => { release = resolve; });
  render(<Host preload={card => card.characterName === "미카" ? slow : Promise.resolve()} />); await settle();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" }); await settle();
  expect(shownName()).toContain("하나");
  release(); await settle();
  expect(shownName()).toContain("하나");
});

it("decodes the neighbours ahead of time", async () => {
  const preload = vi.fn((_card: CardData) => instant());
  render(<Host start={1} preload={preload} />); await settle();
  expect(preload.mock.calls.map(([c]) => c.characterName).sort()).toEqual(["루나", "하나"]);
});

it("shows the original art full-size and back, stepping keeps the art mode", async () => {
  render(<Host />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "그림 보기" }));
  const art = screen.getByRole("img", { name: "루나 원본 그림" }); expect(art).toHaveAttribute("src", "https://art.test/루나.jpg");
  expect(screen.getByRole("button", { name: "카드 보기" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "다음 카드" })); await settle();
  // The old art stays visible while the next one loads in the spare slot (no flash).
  const sources = [...document.querySelectorAll(".card-viewer__art")].map(image => image.getAttribute("src"));
  expect(sources).toEqual(["https://art.test/루나.jpg", "https://art.test/미카.jpg"]);
  expect(screen.getByRole("img", { name: "루나 원본 그림" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "카드 보기" }));
  expect(shownName()).toContain("미카");
});

it("masks the card and the original art in privacy mode", async () => {
  render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><Host /></PrivacyProvider>); await settle();
  const dialog = screen.getByRole("dialog");
  expect(dialog.querySelectorAll("img")).toHaveLength(0);
  expect(within(dialog).getByLabelText("이미지 숨김")).toHaveClass("privacy-mask");
  fireEvent.click(screen.getByRole("button", { name: "그림 보기" }));
  expect(dialog.querySelectorAll("img")).toHaveLength(0);
  expect(within(dialog).getByRole("img", { name: "이미지 숨김" })).toHaveClass("privacy-mask");
});
