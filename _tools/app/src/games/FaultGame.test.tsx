import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetPage, AssetSummary } from "../library/types";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { faultAssets, FaultGameProvider, FaultPlayButton, faultSelectionItem, loadFaultPhotos, useFaultGame, useFaultQueryScope } from "./FaultGame";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, convertFileSrc: (path: string) => path }));

function asset(id: string, overrides: Partial<AssetSummary> = {}): AssetSummary {
  return { id, title: null, originalName: `${id}.jpg`, byteSize: 1000, width: 10, height: 10, collectedAt: "2026-01-01T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "image" }, ...overrides };
}
const video = (id: string) => asset(id, { originalName: `${id}.mp4`, media: { kind: "video", durationMs: 1, preparationState: "ready" as never, scrubFrameCount: 0 } });

function host(privacyMode = false) {
  return ({ children }: { children: ReactNode }) => <PrivacyProvider privacyMode={privacyMode} setPrivacyMode={() => undefined}><FaultGameProvider>{children}</FaultGameProvider></PrivacyProvider>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("FAULT desktop entry", () => {
  it("keeps only still images the game converts", () => {
    const items = [asset("a"), video("v"), asset("g", { originalName: "g.gif", media: { kind: "gif" } }), asset("t", { originalName: "t.tiff" }), asset("big", { byteSize: 21 * 1024 * 1024 })];
    expect(faultAssets(items).map((item) => item.id)).toEqual(["a", "g"]);
  });

  it("offers the selection only with 1–24 images, ignoring videos", () => {
    const play = vi.fn();
    expect(faultSelectionItem(play, [])).toEqual([]);
    expect(faultSelectionItem(null, [asset("a")])).toEqual([]);
    expect(faultSelectionItem(play, [video("v")])[0]).toMatchObject({ disabled: true });
    const tooMany = faultSelectionItem(play, Array.from({ length: 25 }, (_, index) => asset(`a${index}`)))[0]!;
    expect(tooMany).toMatchObject({ disabled: true, label: "▶ FAULT · 24장까지 선택할 수 있습니다" });
    const item = faultSelectionItem(play, [asset("a"), video("v"), asset("b")])[0]!;
    expect(item).toMatchObject({ disabled: false, label: "▶ FAULT" });
    item.onSelect();
    return expect(play.mock.calls[0]![0](new AbortController().signal)).resolves.toEqual([asset("a"), asset("b")]);
  });

  it("reads originals as typed blobs and skips unreadable ones", async () => {
    const fetchMock = vi.fn(async (url: string) => url.includes("bad") ? new Response(null, { status: 404 }) : new Response(new Uint8Array([1, 2])));
    vi.stubGlobal("fetch", fetchMock);
    const photos = await loadFaultPhotos([asset("ok", { originalName: "ok.png" }), asset("bad"), video("v")]);
    expect(photos.map((photo) => photo.id)).toEqual(["ok"]);
    expect(photos[0]!.blob!.type).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledWith("http://lakomics.localhost/asset/ok", expect.anything());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is not offered in privacy mode", () => {
    const { result } = renderHook(() => useFaultGame(), { wrapper: host(true) });
    expect(result.current).toBeNull();
    render(<FaultPlayButton scope={async () => [asset("a")]} />, { wrapper: host(true) });
    expect(screen.queryByRole("button", { name: "이 묶음으로 플레이" })).toBeNull();
  });

  it("covers an inert workspace and Esc returns focus to the same view", async () => {
    render(<><button>behind</button><FaultPlayButton scope={async () => [video("v")]} /></>, { wrapper: host() });
    const trigger = screen.getByRole("button", { name: "이 묶음으로 플레이" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "FAULT" });
    expect(dialog.querySelector("iframe")!.getAttribute("src")).toMatch(/fault\.html#host=lakomics$/);
    expect(trigger.closest(".fault-host")!.hasAttribute("inert")).toBe(true);
    expect(await screen.findByText("플레이할 이미지가 없습니다")).toBeTruthy();
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", behind);
    expect(behind).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.closest(".fault-host")!.hasAttribute("inert")).toBe(false);
  });

  it("samples the whole query scope and hides when it shows no image", async () => {
    const listAssets = vi.fn(async (): Promise<AssetPage> => ({ items: [], nextCursor: null }));
    const gateway = { listAssets };
    const query = { classificationId: null, albumId: "album", collectionId: null, creatorKey: null, directOnly: false, unclassifiedOnly: false, aspectRatio: null, collectedRange: null };
    expect(renderHook(() => useFaultQueryScope(gateway, query, false), { wrapper: host() }).result.current).toBeNull();
    expect(renderHook(() => useFaultQueryScope(gateway, null, true), { wrapper: host() }).result.current).toBeNull();
    const { result } = renderHook(() => useFaultQueryScope(gateway, query, true), { wrapper: host() });
    expect(listAssets).not.toHaveBeenCalled();
    await act(async () => { await result.current!(new AbortController().signal); });
    expect(listAssets).toHaveBeenCalledWith(expect.objectContaining({ albumId: "album", mediaKind: "images", sort: "random", randomPivot: expect.stringMatching(/^[0-9a-f]{32}$/), after: null, limit: 200 }));
  });

  it("keeps the game loadable under the packaged CSP", () => {
    const html = readFileSync(resolve(__dirname, "fault/fault.html"), "utf8");
    // Tauri adds nonces to <style> tags, which disables inline style attributes.
    expect(html).not.toMatch(/<[^>]+\sstyle="/);
    const csp: string = JSON.parse(readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8")).app.security.csp;
    expect(csp).toMatch(/font-src 'self' data:/);
    expect(csp).toMatch(/img-src 'self' blob:/);
    expect(csp).toMatch(/connect-src 'self' lakomics: http:\/\/lakomics\.localhost/);
  });
});
