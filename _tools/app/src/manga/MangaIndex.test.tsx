import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, MangaIndexIdentity, MangaLocalIndex } from "../library/types";
import { MangaIndex, MangaIndexToken } from "./MangaIndex";
import { useState } from "react";
import { mangaIndexQuery, withMangaIndexQuery } from "./mangaIndexModel";

const tag = (n: number) => ({ kind: "tag" as const, namespace: "female", value: `tag${n}`, label: `태그 ${n}`, count: 12 - n });
afterEach(cleanup);
function gatewayFixture() {
  let pins: MangaIndexIdentity[] = [];
  let local: MangaLocalIndex = { folders: [{ name: "작가 A", relativePath: "작가 A", seriesCount: 3, seriesIds: ["a", "b", "c"] }], vanished: [{ name: "gone", relativePath: "gone", seriesCount: 2, seriesIds: ["x", "y"] }, { name: "old", relativePath: "old", seriesCount: 1, seriesIds: ["z"] }] };
  return { open: vi.fn(), close: vi.fn(),
    getMangaFrequentIndex: vi.fn(async () => ({ bookmarkCount: 12, tagLimit: 8, artistLimit: 5, tags: Array.from({ length: 10 }, (_, n) => tag(n)), artists: Array.from({ length: 6 }, (_, n) => ({ kind: "artist" as const, namespace: "artist", value: `artist${n}`, label: `작가 ${n}`, count: 6 - n })) })),
    listMangaIndexPins: vi.fn(async () => [...pins]),
    addMangaIndexPin: vi.fn(async (pin: MangaIndexIdentity) => { pins.push(pin); }),
    removeMangaIndexPin: vi.fn(async (pin: MangaIndexIdentity) => { pins = pins.filter(p => p.value !== pin.value); }),
    getMangaLocalIndex: vi.fn(async () => local),
    purgeVanishedMangaFolders: vi.fn(async (paths: string[]) => { const removedFolders = local.vanished.filter(f => paths.includes(f.relativePath)); local = { ...local, vanished: local.vanished.filter(f => !paths.includes(f.relativePath)) }; return { removedFolders, removedSeriesCount: 2, backupPath: "/test/backups/verified.sqlite" }; }),
  };
}
function Fixture({ local = false, onPurge = async () => {}, onFolder = vi.fn() }: { local?: boolean; onPurge?: () => Promise<void>; onFolder?: (folder: string | null) => void }) {
  const [filter, setFilter] = useState<MangaIndexIdentity | null>(null);
  return <><MangaIndexToken filter={filter} onClear={() => setFilter(null)} /><MangaIndex source={local ? "local" : "all"} filter={filter} onFilter={setFilter} folder={null} onFolder={onFolder} localCount={6} revision={0} onLocalIndex={() => {}} onPurge={onPurge} /></>;
}
function mount(gateway: ReturnType<typeof gatewayFixture>, props = {}) {
  return render(<LibraryProvider gateway={gateway as unknown as LibraryGateway}><Fixture {...props} /></LibraryProvider>);
}
describe("PC Manga index", () => {
  it("shows 8 tags/5 artists, expands, pins above frequent rows, and clears the single filter", async () => {
    const gateway = gatewayFixture(); mount(gateway);
    await screen.findByText("자주 찾는 태그");
    const tags = screen.getByRole("navigation", { name: "망가 목차" }).querySelector('section[aria-label="자주 찾는 태그"]') as HTMLElement;
    expect(within(tags).getAllByRole("button", { name: /고정$/ })).toHaveLength(8);
    expect(screen.queryByRole("button", { name: "작가 5 1" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "모두 보기 (10)" }));
    expect(within(tags).getAllByRole("button", { name: /고정$/ })).toHaveLength(10);
    await userEvent.click(screen.getByRole("button", { name: "접기" }));
    await userEvent.click(screen.getByRole("button", { name: "태그 0 12" }));
    expect(screen.getByRole("button", { name: "태그 0 필터 해제" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "태그 1 11" }));
    expect(screen.queryByRole("button", { name: "태그 0 필터 해제" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "태그 1 11" }));
    expect(screen.queryByRole("button", { name: "태그 1 필터 해제" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "태그 0 고정" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "태그 0 고정 해제" })).toHaveAttribute("aria-pressed", "true"));
    expect(within(tags).queryByText("태그 0")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "태그 0 고정 해제" }));
    expect(await within(tags).findByText("태그 0")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "태그 0 12" }));
    await userEvent.click(screen.getByRole("button", { name: "태그 0 필터 해제" }));
    expect(screen.queryByRole("button", { name: "태그 0 필터 해제" })).not.toBeInTheDocument();
  });
  it("shows the accepted empty line", async () => {
    const gateway = gatewayFixture(); gateway.getMangaFrequentIndex.mockResolvedValue({ bookmarkCount: 0, tagLimit: 8, artistLimit: 5, tags: [], artists: [] });mount(gateway);
    expect(await screen.findByText("북마크한 작품이 생기면 자주 찾는 태그와 작가가 여기에 모입니다.")).toBeVisible();
    expect(screen.queryByText("자주 찾는 태그")).not.toBeInTheDocument();
  });
  it("selects local folders, reviews checkboxes, purges only selected folders and refreshes", async () => {
    const gateway = gatewayFixture();const onPurge = vi.fn(async () => {}); const onFolder = vi.fn();mount(gateway, { local: true, onPurge, onFolder });
    await userEvent.click(await screen.findByRole("button", { name: "작가 A 3" }));expect(onFolder).toHaveBeenCalledWith("작가 A");
    expect(screen.getByText("없어진 폴더 2개 · 디스크에서 사라짐")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "목록 보기" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getAllByRole("checkbox")[1]!);
    await userEvent.click(within(dialog).getByRole("button", { name: "백업하고 1개 지우기" }));
    await waitFor(() => expect(gateway.purgeVanishedMangaFolders).toHaveBeenCalledWith(["gone"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onPurge).toHaveBeenCalledOnce();expect(screen.getByText("없어진 폴더 1개 · 디스크에서 사라짐")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("백업 완료");
  });
  it("reports committed cleanup accurately when the following grid refresh fails", async () => {
    const gateway = gatewayFixture();
    mount(gateway, { local: true, onPurge: vi.fn().mockRejectedValue(new Error("refresh failed")) });
    await userEvent.click(await screen.findByRole("button", { name: "목록 보기" }));
    await userEvent.click(screen.getByRole("button", { name: "백업하고 2개 지우기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("백업 완료. 목록을 새로 불러오지 못했습니다");
  });
  it("keeps failed purge review open, supports cancel, and disables an empty selection", async () => {
    const gateway=gatewayFixture();gateway.purgeVanishedMangaFolders.mockRejectedValue(new Error("restored"));mount(gateway,{local:true});
    await userEvent.click(await screen.findByRole("button",{name:"목록 보기"}));
    await userEvent.click(screen.getByRole("button",{name:"백업하고 2개 지우기"}));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("정리하지 못했습니다"));
    for(const checkbox of screen.getAllByRole("checkbox")) await userEvent.click(checkbox);
    expect(screen.getByRole("button",{name:"백업하고 0개 지우기"})).toBeDisabled();
    await userEvent.click(screen.getByRole("button",{name:"취소"}));expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("preserves typed boolean search and escapes catalog identity values", () => {
    const query=mangaIndexQuery({kind:"artist",namespace:"artist",value:'a "b" \\ c',label:"name"});
    expect(query).toBe('artist:"a \\"b\\" \\\\ c"');
    expect(withMangaIndexQuery("alpha OR beta",query)).toBe(`(alpha OR beta) AND ${query}`);
    expect(withMangaIndexQuery("alpha OR beta","")).toBe("alpha OR beta");
  });
});
