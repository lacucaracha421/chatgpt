import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { CardAlbum } from "./CardAlbum";
import { groupAlbum } from "./groupAlbum";
import { HomeDailyCard } from "./HomeDailyCard";
import { PackOpening } from "./PackOpening";
import { TradingCard } from "./TradingCard";
import { cutoutUrl, displayCards, operationId, saveResult, type CardsApi, type CardState, type OpenResult, type ServerCard } from "./api";

const serverCard = (changes: Partial<ServerCard> = {}): ServerCard => ({ slot: 0, characterId: "c1", characterName: "루나", seriesName: "별자리", tier: "sr", artAssetId: "a1", artWidth: 1000, artHeight: 1400, cutout: null, count: 1, level: 1, serial: null, isNew: true, firstDrawnAt: "2026-10-15T01:00:00Z", ...changes });
const state = (changes: Partial<CardState> = {}): CardState => ({ version: 1, revision: 1, day: "2026-10-15", nextResetAt: "2026-10-15T20:00:00Z", unopened: [{ id: "d-20261015", kind: "daily", day: "2026-10-15" }], pendingKeep: [], prefetch: [], savedToday: 0, bonusThreshold: 50, bonusGranted: false, cover: { day: "2026-10-15", assetIds: ["cover1"] }, albumSummary: { cards: 1, total: 3 }, ...changes });
const result = (alreadyOpened = false): OpenResult => ({ packId: "d-20261015", openedAt: "2026-10-15T01:00:00Z", alreadyOpened, cards: Array.from({ length: 5 }, (_, slot) => serverCard({ slot, tier: slot === 4 ? "lr" : "n", characterName: `서버 카드 ${slot}`, artAssetId: `art${slot}` })) });
const decided = (slots: number[], packId = "d-20261015"): OpenResult => ({
  ...result(true), packId, keptAt: "2026-10-15T02:00:00Z", alreadyKept: false,
  cards: result().cards.map(card => ({ ...card, kept: slots.includes(card.slot!), serial: slots.includes(card.slot!) && card.tier === "lr" ? "7" : null })),
});
function apiFixture(snapshot = state()) {
  const listeners = new Set<() => void>();
  const api: CardsApi = {
    state: vi.fn(async () => snapshot), open: vi.fn(async () => result()),
    keep: vi.fn(async (packId: string, _operation: string, slots: number[]) => decided(slots, packId)),
    pack: vi.fn(async (packId: string) => ({ ...result(true), packId })),
    album: vi.fn(async () => ({ version: 1, revision: 1, cards: [serverCard()], nextCursor: null })),
    art: vi.fn(async (id, cutout) => `https://art.test/${id}${cutout ? ".png" : ".jpg"}`),
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
  return { api, change: () => listeners.forEach(fn => fn()) };
}
const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
let reduced = true;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T02:00:00Z")); localStorage.clear(); reduced = true;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shows the server pack, cover, bonus and album totals; restores focus on close", async () => {
  const { api } = apiFixture(state({ bonusGranted: true })), album = vi.fn();
  render(<HomeDailyCard api={api} onAlbum={album} root="library" />); await settle();
  expect(screen.getByText("남은 팩 1")).toBeInTheDocument();
  expect(screen.getByText("오늘 50장 저장 · 보너스 팩")).toBeInTheDocument();
  expect(screen.getByText("05:00에 새 팩")).toBeInTheDocument();
  expect(api.art).toHaveBeenCalledWith("cover1", false);
  const opener = screen.getByRole("button", { name: "오늘의 카드 팩 열기" }); opener.focus(); fireEvent.click(opener);
  expect(screen.getByRole("dialog", { name: "오늘의 카드" })).toHaveClass("ui-dialog--fullscreen");
  expect(api.open).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "닫기" })); await settle(500);
  expect(opener).toHaveFocus(); fireEvent.click(screen.getByRole("button", { name: "앨범 1/3" })); expect(album).toHaveBeenCalledOnce();
});

it("shows the stored result of the newest pack without any open request", async () => {
  saveResult("library", result()); const { api } = apiFixture(state({ unopened: [] }));
  render(<HomeDailyCard api={api} root="library" />); await settle();
  expect(screen.getByText("남은 팩 없음")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /LR 서버 카드 4/ })).toBeInTheDocument();
  expect(api.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "결과 보기" })); await settle();
  expect(document.querySelector(".pack-opening")).toHaveAttribute("data-phase", "results"); expect(api.open).not.toHaveBeenCalled();
});

it("recovers a pack opened on another device and replays it without the reveal", async () => {
  const { api } = apiFixture(state({ unopened: [] }));
  vi.mocked(api.open).mockResolvedValue(result(true));
  render(<HomeDailyCard api={api} root="library" />); await settle();
  expect(screen.getByText("남은 팩 없음")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /LR 서버 카드 4/ })).toBeInTheDocument();
  expect(api.open).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "결과 보기" })); await settle();
  expect(document.querySelector(".pack-opening")).toHaveAttribute("data-phase", "results"); expect(api.open).toHaveBeenCalledOnce();
});

it("retains content on refresh error and retries; busy text waits 400 ms", async () => {
  const { api, change } = apiFixture(); render(<HomeDailyCard api={api} />); await settle();
  let reject!: (reason: unknown) => void;
  vi.mocked(api.state).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  act(change); await settle(399);
  expect(screen.getByText("남은 팩 1")).toBeInTheDocument();
  await act(async () => reject(new Error("offline"))); expect(screen.getByRole("alert")).toHaveTextContent("카드를 불러오지 못했습니다");
  expect(screen.getByText("남은 팩 1")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" })); await settle(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("persists a UUID before opening and reuses it after a failed tear", async () => {
  const { api } = apiFixture(); vi.mocked(api.open).mockRejectedValueOnce(new Error("offline"));
  render(<HomeDailyCard api={api} root="library" />); await settle(); fireEvent.click(screen.getByRole("button", { name: "뜯기" }));
  fireEvent.keyDown(screen.getByRole("button", { name: /팩 뜯기/ }), { key: "Enter" }); await settle();
  expect(screen.getByRole("alert")).toHaveTextContent("팩을 열지 못했습니다");
  expect(document.querySelector(".pack.torn")).toBeNull();
  const firstId = vi.mocked(api.open).mock.calls[0][1]; expect(firstId).toBe(operationId("library", "d-20261015"));
  fireEvent.keyDown(screen.getByRole("button", { name: /팩 뜯기/ }), { key: "Enter" }); await settle(500);
  expect(vi.mocked(api.open).mock.calls[1][1]).toBe(firstId);
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getAllByRole("img", { name: /서버 카드/ })).toHaveLength(5);
  expect(document.querySelector(".pack-opening")).toHaveAttribute("data-phase", "results");
});

it("starts the open on drag start, waits for the server before dealing, and bypasses reveal for already-opened", async () => {
  reduced = false; const { api } = apiFixture(); const cards = await displayCards(api, result().cards, "pack");
  let resolve!: (value: { cards: typeof cards; alreadyOpened: boolean }) => void;
  const load = vi.fn(() => new Promise<{ cards: typeof cards; alreadyOpened: boolean }>(done => { resolve = done; }));
  render(<PackOpening cover={{ imageUrls: [] }} loadDraw={load} onClose={vi.fn()} />);
  const grip = screen.getByRole("button", { name: /팩 뜯기/ }); fireEvent.pointerDown(grip, { pointerId: 1, clientX: 0 });
  expect(load).toHaveBeenCalledOnce(); expect(document.querySelectorAll(".pack-opening__slot")).toHaveLength(0);
  fireEvent.keyDown(grip, { key: "Enter" }); await settle(399); expect(screen.queryByText("팩을 여는 중")).not.toBeInTheDocument();
  await settle(1); expect(screen.getByText("팩을 여는 중")).toBeInTheDocument();
  await act(async () => resolve({ cards, alreadyOpened: true })); await settle(400);
  expect(document.querySelector(".pack-opening")).toHaveAttribute("data-phase", "results");
  expect(screen.queryByRole("button", { name: "카드 뒤집기" })).not.toBeInTheDocument(); expect(load).toHaveBeenCalledOnce();
});

it("refreshes once at the reset and coalesces signals while a read is pending", async () => {
  const reset = new Date(Date.now() + 1000).toISOString(); const { api, change } = apiFixture(state({ nextResetAt: reset }));
  render(<HomeDailyCard api={api} />); await settle(); await settle(1000); expect(api.state).toHaveBeenCalledTimes(2);
  await settle(5000); expect(api.state).toHaveBeenCalledTimes(2);
  let resolve!: (value: CardState) => void;
  vi.mocked(api.state).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  act(change); act(change); act(change); expect(api.state).toHaveBeenCalledTimes(3);
  await act(async () => resolve(state({ nextResetAt: reset }))); await settle(); expect(api.state).toHaveBeenCalledTimes(4);
});

it("groups owned characters by series, chooses the best tier, pages and filters, and opens details", async () => {
  const { api } = apiFixture();
  vi.mocked(api.album).mockResolvedValueOnce({ version: 1, revision: 1, cards: [serverCard({ tier: "n" }), serverCard({ tier: "ur", count: 3, level: 3 })], nextCursor: "next" })
    .mockResolvedValueOnce({ version: 1, revision: 1, cards: [serverCard({ characterId: "c2", characterName: "아리아", seriesName: "새 시리즈", tier: "lr" })], nextCursor: null });
  const original = vi.fn(), folder = vi.fn(); render(<CardAlbum api={api} onBack={vi.fn()} onOpenAsset={original} onCharacter={folder} />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "루나 · UR" }));
  expect(screen.getByRole("dialog", { name: "루나 UR 크게 보기" })).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "닫기" })); await settle();
  const detail = screen.getByRole("complementary", { name: "카드 상세" }); expect(detail).toHaveTextContent("Lv.3"); expect(detail).toHaveTextContent("10.15");
  fireEvent.click(within(detail).getByRole("button", { name: "원본 열기" })); expect(original).toHaveBeenCalledWith("a1");
  fireEvent.click(within(detail).getByRole("button", { name: "캐릭터 폴더" })); expect(folder).toHaveBeenCalledWith("c1");
  fireEvent.click(screen.getByRole("button", { name: "더 보기" })); await settle(); expect(api.album).toHaveBeenLastCalledWith("next"); expect(screen.getByRole("button", { name: "아리아 · LR" })).toBeInTheDocument();
  fireEvent.click(within(screen.getByLabelText("카드 등급")).getByRole("button", { name: "N" })); expect(screen.getByRole("button", { name: "루나 · N" })).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "아리아 · LR" })).not.toBeInTheDocument();
  const displayed = await displayCards(api, [serverCard({ tier: "n" }), serverCard({ tier: "lr" })]); expect(groupAlbum(displayed)[0][1].get("c1")?.[0].tier).toBe("lr");
});

const viewerAlbum = () => {
  const { api } = apiFixture();
  vi.mocked(api.album).mockResolvedValue({ version: 1, revision: 1, nextCursor: null, cards: [
    serverCard({ tier: "n" }), serverCard({ tier: "ur", count: 3, level: 3 }),
    serverCard({ characterId: "c2", characterName: "아리아", seriesName: "새 시리즈", tier: "n", artAssetId: "a2" }),
    serverCard({ characterId: "c3", characterName: "하나", seriesName: "새 시리즈", tier: "r", artAssetId: "a3" }),
  ] });
  return api;
};
const viewerCard = () => screen.getByRole("dialog").querySelector("[data-viewer-card] [role=img]")!.getAttribute("aria-label")!;

it("opens the card viewer from a tile or 크게 보기, walks the filtered list with the arrow keys, and Esc returns to the same scroll position", async () => {
  const api = viewerAlbum(), asset = vi.fn(), folder = vi.fn();
  render(<CardAlbum api={api} onBack={vi.fn()} onOpenAsset={asset} onCharacter={folder} />); await settle();
  const list = document.querySelector<HTMLElement>(".card-album__list")!; list.scrollTop = 240;
  fireEvent.click(within(screen.getByLabelText("카드 등급")).getByRole("button", { name: "N" }));
  fireEvent.click(screen.getByRole("button", { name: "루나 · N" })); await settle();
  const dialog = screen.getByRole("dialog", { name: "루나 N 크게 보기" });
  expect(within(dialog).getByText("1 / 2")).toBeInTheDocument(); // only the N cards are in the filtered list
  expect(viewerCard()).toContain("N 루나");
  fireEvent.keyDown(dialog, { key: "ArrowRight" }); await settle();
  expect(viewerCard()).toContain("N 아리아"); expect(within(dialog).getByRole("button", { name: "다음 카드" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "원본 열기" })); expect(asset).toHaveBeenCalledWith("a2");
  fireEvent.click(within(dialog).getByRole("button", { name: "캐릭터 폴더" })); expect(folder).toHaveBeenCalledWith("c2");
  fireEvent.keyDown(dialog, { key: "Escape" }); await settle(500);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.querySelector(".card-album__list")).toBe(list); expect(list.scrollTop).toBe(240);
  // The detail panel followed the last viewed card, and 크게 보기 reopens it.
  expect(screen.getByRole("complementary", { name: "카드 상세" })).toHaveTextContent("아리아");
  fireEvent.click(screen.getByRole("button", { name: "크게 보기" })); await settle();
  expect(viewerCard()).toContain("N 아리아");
});

it("walks all tiers in album order when unfiltered and respects the series filter", async () => {
  render(<CardAlbum api={viewerAlbum()} onBack={vi.fn()} />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "루나 · UR" })); await settle();
  const dialog = screen.getByRole("dialog"); expect(within(dialog).getByText("1 / 4")).toBeInTheDocument();
  expect(viewerCard()).toContain("UR 루나");
  fireEvent.keyDown(dialog, { key: "ArrowRight" }); await settle(); expect(viewerCard()).toContain("N 루나");
  fireEvent.click(within(dialog).getByRole("button", { name: "닫기" })); await settle(500);
  fireEvent.click(screen.getByRole("button", { name: "새 시리즈 · 2명" }));
  fireEvent.click(screen.getByRole("button", { name: "하나 · R" })); await settle();
  expect(within(screen.getByRole("dialog")).getByText(/\d \/ 2/)).toBeInTheDocument();
});

it("masks card art and cutouts in privacy and never requests an unreported cutout from the server", async () => {
  const { api } = apiFixture(); const cards = await displayCards(api, [serverCard({ tier: "ssr", cutout: { assetId: "a1" } }), serverCard({ characterId: "c2", tier: "ur", artAssetId: "a2" })]);
  const cutoutCalls = vi.mocked(api.art).mock.calls.filter(([, cutout]) => cutout);
  expect(cutoutCalls.filter(([id, , localOnly]) => !localOnly && id === "a2")).toHaveLength(0); // unreported: this PC's copy only, never a ticket
  const { container, rerender } = render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><TradingCard card={cards[0]} /></PrivacyProvider>);
  expect(container.querySelectorAll("img")).toHaveLength(0); expect(screen.getByLabelText("이미지 숨김")).toHaveClass("privacy-mask");
  rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><TradingCard card={cards[0]} /></PrivacyProvider>); expect(container.querySelectorAll("img")).toHaveLength(2);
});

it("resolves a cutout from this PC's copy first, then the server ticket, and only for SSR and above", async () => {
  const { api } = apiFixture(), art = vi.mocked(api.art), local = new Set(["a-local", "a-both", "a-pc-only"]);
  art.mockImplementation(async (id, cutout, localOnly) => {
    if (!cutout) return `https://art.test/${id}.jpg`;
    if (local.has(id)) return `http://lakomics.localhost/card-cutout/${id}`;
    if (localOnly) throw new Error("no local copy");
    return `https://ticket.test/${id}`;
  });
  const [onPc, both, remote, pcOnly, none, sr] = await displayCards(api, [
    serverCard({ tier: "ssr", artAssetId: "a-local", cutout: { assetId: "a-local" } }),
    serverCard({ tier: "lr", artAssetId: "a-both", cutout: { assetId: "a-both" } }),
    serverCard({ tier: "ur", artAssetId: "a-remote", cutout: { assetId: "a-remote" } }),
    serverCard({ tier: "ur", artAssetId: "a-pc-only", cutout: null }),   // made here, not listed by the server yet
    serverCard({ tier: "lr", artAssetId: "a-none", cutout: null }),
    serverCard({ tier: "sr", artAssetId: "a-sr", cutout: { assetId: "a-sr" } }),
  ]);
  expect(onPc.cutoutUrl).toBe("http://lakomics.localhost/card-cutout/a-local");
  expect(both.cutoutUrl).toBe("http://lakomics.localhost/card-cutout/a-both");
  expect(remote.cutoutUrl).toBe("https://ticket.test/a-remote");
  expect(pcOnly.cutoutUrl).toBe("http://lakomics.localhost/card-cutout/a-pc-only");
  expect(none.cutoutUrl).toBeUndefined();
  expect(sr.cutoutUrl).toBeUndefined();
  const asked = (id: string) => art.mock.calls.filter(([asset, cutout]) => asset === id && cutout);
  expect(asked("a-local").every(([, , localOnly]) => localOnly)).toBe(true);           // no ticket when the copy is here
  expect(asked("a-remote").map(([, , localOnly]) => !!localOnly)).toEqual([true, false]); // local first, then the ticket
  expect(asked("a-none").every(([, , localOnly]) => localOnly)).toBe(true);            // never a ticket for an unreported cutout
  expect(asked("a-sr")).toHaveLength(0);
  expect(await cutoutUrl(api, "a-remote", false)).toBe("");
});

it("shows the pop-out layer only on SSR, UR and LR cards", () => {
  for (const tier of ["n", "r", "sr", "ssr", "ur", "lr"] as const) {
    const { container, unmount } = render(<TradingCard card={{ id: `x-${tier}`, characterName: "루나", seriesName: "별자리", tier, artUrl: "https://art.test/a.jpg", artWidth: 1000, artHeight: 1400, cutoutUrl: "https://art.test/a.png", count: 1, level: 1 }} />);
    const popOut = ["ssr", "ur", "lr"].includes(tier);
    expect(container.querySelector(".f-subj") !== null, tier).toBe(popOut);
    expect(container.querySelector(`[data-tier="${tier}"]`)?.getAttribute("data-cut"), tier).toBe(popOut ? "1" : "0");
    unmount();
  }
});

it("does not cache a failed art lookup, so a later view can try again", async () => {
  const { api } = apiFixture();
  vi.mocked(api.art).mockRejectedValueOnce(new Error("offline"));
  expect((await displayCards(api, [serverCard({ artAssetId: "retry" })]))[0].artUrl).toBe("");
  expect((await displayCards(api, [serverCard({ artAssetId: "retry" })]))[0].artUrl).toBe("https://art.test/retry.jpg");
});

const waitingPack = { packId: "d-20261015", openedAt: "2026-10-15T01:00:00Z", expiresAt: "2026-10-22T01:00:00Z" };
const tearToResults = async (api: CardsApi) => {
  render(<HomeDailyCard api={api} root="library" />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "뜯기" }));
  fireEvent.keyDown(screen.getByRole("button", { name: /팩 뜯기/ }), { key: "Enter" }); await settle(500);
};
const boxes = () => screen.getAllByRole("checkbox");
const slots = () => [...document.querySelectorAll<HTMLElement>(".pack-opening__slot")];

it("starts the keep step with nothing selected; a click lifts and marks a card, again settles it back", async () => {
  const { api } = apiFixture(); await tearToResults(api);
  expect(document.querySelector(".pack-opening")).toHaveAttribute("data-phase", "results");
  expect(boxes()).toHaveLength(5); boxes().forEach(box => expect(box).toHaveAttribute("aria-checked", "false"));
  expect(slots().every(slot => slot.dataset.selected === "false")).toBe(true);
  expect(screen.queryByText("선택됨")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "앨범에 넣기 (0장)" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "나중에" })).toBeEnabled();
  fireEvent.click(slots()[1]);
  expect(slots()[1]).toHaveAttribute("data-selected", "true"); expect(boxes()[1]).toHaveAttribute("aria-checked", "true");
  expect(within(slots()[1]).getByText("선택됨")).toBeInTheDocument();
  expect(slots()[0]).toHaveAttribute("data-selected", "false");  // unselected cards stay as they were
  expect(screen.getByRole("button", { name: "앨범에 넣기 (1장)" })).toBeEnabled();
  fireEvent.click(slots()[1]);
  expect(slots()[1]).toHaveAttribute("data-selected", "false"); expect(screen.queryByText("선택됨")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "앨범에 넣기 (0장)" })).toBeDisabled();
  fireEvent.click(boxes()[2]);  // the mark itself toggles exactly once, not twice through the card
  expect(slots()[2]).toHaveAttribute("data-selected", "true");
  expect(api.keep).not.toHaveBeenCalled();
});

it("toggles the focused card with Space and Enter", async () => {
  const { api } = apiFixture(); await tearToResults(api);
  vi.useRealTimers();  // user-event waits on real timers; the keep step needs none
  const user = userEvent.setup();
  expect(boxes()[3].tagName).toBe("BUTTON");  // so a real browser turns Space and Enter into a click
  boxes()[3].focus(); await user.keyboard(" ");
  expect(boxes()[3]).toHaveAttribute("aria-checked", "true");
  await user.keyboard("{Enter}");
  expect(boxes()[3]).toHaveAttribute("aria-checked", "false");
  await user.keyboard("{Enter}"); expect(screen.getByRole("button", { name: "앨범에 넣기 (1장)" })).toBeEnabled();
});

it("keeps only the selected slots, with a stored operation id, and then shows what entered the album", async () => {
  const { api } = apiFixture(); await tearToResults(api);
  fireEvent.click(slots()[1]); fireEvent.click(slots()[4]);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "앨범에 넣기 (2장)" })); }); await settle(500);
  expect(api.keep).toHaveBeenCalledOnce();
  const [packId, operation, sent] = vi.mocked(api.keep).mock.calls[0];
  expect([packId, sent]).toEqual(["d-20261015", [1, 4]]); expect(operation).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("앨범에 2장을 넣었습니다");
  expect(document.querySelectorAll(".pack-opening__pick--saved")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /앨범에 넣기/ })).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: /LR 서버 카드 4/ })).toBeInTheDocument();
});

it("keeps the selection and the same operation id when saving fails, then succeeds on retry", async () => {
  const { api } = apiFixture(); await tearToResults(api);
  vi.mocked(api.keep).mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(slots()[0]);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "앨범에 넣기 (1장)" })); }); await settle(500);
  expect(screen.getByRole("alert")).toHaveTextContent("앨범에 넣지 못했습니다");
  expect(slots()[0]).toHaveAttribute("data-selected", "true"); expect(screen.getByRole("button", { name: "앨범에 넣기 (1장)" })).toBeEnabled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "앨범에 넣기 (1장)" })); }); await settle(500);
  expect(api.keep).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.keep).mock.calls[1][1]).toBe(vi.mocked(api.keep).mock.calls[0][1]);
  expect(screen.getByRole("status")).toHaveTextContent("앨범에 1장을 넣었습니다");
});

it("leaves the pack waiting on 나중에 and reopens it from the Home slot", async () => {
  const { api } = apiFixture();
  vi.mocked(api.state).mockResolvedValueOnce(state()).mockResolvedValue(state({ unopened: [], pendingKeep: [waitingPack] }));
  await tearToResults(api);
  fireEvent.click(slots()[0]); fireEvent.click(screen.getByRole("button", { name: "나중에" })); await settle(500);
  expect(api.keep).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => { fireEvent.click(screen.getByRole("button", { name: "정리 안 한 팩 1" })); }); await settle(500);
  expect(api.pack).toHaveBeenCalledWith("d-20261015");
  expect(boxes()).toHaveLength(5); expect(slots().every(slot => slot.dataset.selected === "false")).toBe(true);  // a fresh, empty selection
  expect(document.querySelector(".pack-opening")).toHaveAttribute("data-phase", "results");
});

it("shows a pack another device already decided without the keep step", async () => {
  const { api } = apiFixture(state({ unopened: [], pendingKeep: [waitingPack] }));
  vi.mocked(api.pack).mockResolvedValue(decided([0, 2]));
  saveResult("library", result(true));
  render(<HomeDailyCard api={api} root="library" />); await settle();
  fireEvent.click(screen.getByRole("button", { name: "정리 안 한 팩 1" })); await settle(500);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: /앨범에 넣기/ })).not.toBeInTheDocument();
  expect(document.querySelectorAll(".pack-opening__pick--saved")).toHaveLength(2);
});

it("does not offer the keep step for a stored result that is no longer waiting", async () => {
  saveResult("library", result()); const { api } = apiFixture(state({ unopened: [], pendingKeep: [] }));
  render(<HomeDailyCard api={api} root="library" />); await settle();
  expect(screen.queryByRole("button", { name: /정리 안 한 팩/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "결과 보기" })); await settle();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

it("warms the art of sealed packs in the background from the prefetch hint, locally and quietly", async () => {
  const { api } = apiFixture(state({ prefetch: [{ packId: "d-20261015", assetIds: ["warm1", "warm2"] }] }));
  render(<HomeDailyCard api={api} root="library" />); await settle(); await settle(3000);  // the first pass shows the state; the next one warms
  expect(vi.mocked(api.art).mock.calls.filter(call => call[2] === true).map(call => call[0]).sort()).toEqual(["warm1", "warm2"]);
  expect(api.open).not.toHaveBeenCalled(); expect(api.keep).not.toHaveBeenCalled(); expect(api.pack).not.toHaveBeenCalled();
});

it("carries slot and kept flag from the server onto display cards", async () => {
  const { api } = apiFixture();
  const [card] = await displayCards(api, [serverCard({ slot: 3, kept: true })], "d-20261015");
  expect([card.slot, card.kept, card.id]).toEqual([3, true, "d-20261015:3"]);
});
