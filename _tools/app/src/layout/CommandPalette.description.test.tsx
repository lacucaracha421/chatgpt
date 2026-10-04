import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CommandPalette, type PaletteDescriptionSearch } from "./CommandPalette";
import { readRecent, findGroups } from "./findModel";
import type { NavigationEntry } from "./navigationEntries";
import type { DescriptionSearchResult, DescriptionSearchStatus } from "../library/types";
import { DESCRIPTION_SEARCH_LIMIT, type DescriptionSearchSource } from "../assets/descriptionSearch";

let testNumber = 0;
const nextKey = () => `description-find-test-${testNumber++}`;
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const status = (available = true): DescriptionSearchStatus => ({ available, indexed: 10, qwenIndexed: 10, precise: true, worker: "ready" });
const result = (...assetIds: string[]): DescriptionSearchResult => ({ route: "cosine", assetIds, precise: true });
const entries: NavigationEntry[] = [{ id: "place", group: "place", label: "눈 내리는 폴더", icon: null, run: vi.fn() }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup({ available = true, search = vi.fn(async (query: string) => result(`${query}-1`, `${query}-2`)) }: { available?: boolean; search?: ReturnType<typeof vi.fn> } = {}) {
  const open = vi.fn();
  const source = { status: vi.fn(async () => status(available)), prewarm: vi.fn(async () => undefined), search };
  const descriptionSearch: PaletteDescriptionSearch = { source: { ...source, search: search as unknown as DescriptionSearchSource["search"] }, open };
  const recentKey = nextKey();
  const view = render(<CommandPalette open onClose={vi.fn()} entries={entries} recentKey={recentKey} descriptionSearch={descriptionSearch} />);
  return { ...view, open, source, search, recentKey, input: screen.getByRole("combobox") };
}

/** Let the status read (and other settled promises) land. */
const ticks = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
const flush = () => act(ticks);
const pause = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); await ticks(); });
const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });
const thumbs = () => [...document.body.querySelectorAll<HTMLImageElement>(".command-palette__thumb img")].map(image => decodeURIComponent(image.src.split("/thumbnail/")[1] ?? ""));

describe("이미지 내용 palette group", () => {
  it("shows a first row in 전체 for two or more characters once the search is available, and starts the worker on open", async () => {
    const { input, source } = setup();
    await flush();
    expect(source.status).toHaveBeenCalledOnce();
    expect(source.prewarm).toHaveBeenCalledOnce();
    type(input, "눈");
    expect(screen.queryByRole("group", { name: "이미지 내용" })).toBeNull();
    type(input, "눈 내리는");
    const group = screen.getByRole("group", { name: "이미지 내용" });
    expect(within(screen.getByRole("listbox")).getAllByRole("group")[0]).toBe(group);
    expect(within(group).getByRole("option")).toHaveTextContent("‘눈 내리는’ 장면 찾기");
    expect(within(group).getByRole("option")).toHaveTextContent("Enter");
    fireEvent.click(screen.getByRole("button", { name: "작품" }));
    expect(screen.queryByRole("group", { name: "이미지 내용" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "전체" }));
    expect(screen.getByRole("group", { name: "이미지 내용" })).toBeInTheDocument();
  });

  it("stays hidden when the status says unavailable or the gateway has no search", async () => {
    const { input, source } = setup({ available: false });
    await flush();
    expect(source.prewarm).not.toHaveBeenCalled();
    type(input, "눈 내리는");
    expect(screen.queryByRole("group", { name: "이미지 내용" })).toBeNull();
    expect(screen.getByRole("option")).toHaveTextContent("눈 내리는 폴더");
    cleanup();
    render(<CommandPalette open onClose={vi.fn()} entries={entries} recentKey={nextKey()} descriptionSearch={null} />);
    type(screen.getByRole("combobox"), "눈 내리는");
    expect(screen.queryByRole("group", { name: "이미지 내용" })).toBeNull();
  });

  it("asks once after typing pauses and never while Hangul composition is active", async () => {
    vi.useFakeTimers();
    const { input, search } = setup();
    await flush();
    type(input, "눈 내");
    await pause(200);
    type(input, "눈 내리");
    await pause(200);
    fireEvent.compositionStart(input);
    type(input, "눈 내리느");
    await pause(1000);
    expect(search).not.toHaveBeenCalled();
    type(input, "눈 내리는");
    fireEvent.compositionEnd(input);
    await pause(399);
    expect(search).not.toHaveBeenCalled();
    await pause(1);
    expect(search).toHaveBeenCalledExactlyOnceWith("눈 내리는", DESCRIPTION_SEARCH_LIMIT);
  });

  it("keeps the previous strip painted while the next query loads, then swaps", async () => {
    vi.useFakeTimers();
    const next = deferred<DescriptionSearchResult>();
    const search = vi.fn().mockResolvedValueOnce(result("snow-1", "snow-2")).mockReturnValueOnce(next.promise);
    const { input } = setup({ search });
    await flush();
    type(input, "눈 내리는");
    await pause(400);
    expect(thumbs()).toEqual(["snow-1", "snow-2"]);
    type(input, "비 오는 거리");
    await pause(400);
    expect(search).toHaveBeenCalledTimes(2);
    expect(thumbs()).toEqual(["snow-1", "snow-2"]);
    await pause(1000);
    expect(screen.getByRole("group", { name: "이미지 내용" })).toHaveTextContent("장면을 찾는 중…");
    expect(thumbs()).toEqual(["snow-1", "snow-2"]);
    await act(async () => { next.resolve(result("rain-1")); await ticks(); });
    // Each slot loads the next thumbnail beside the current one and swaps once it has decoded.
    expect(thumbs()).toContain("rain-1");
    expect(thumbs()).not.toContain("snow-2");
  });

  it("runs one request at a time and ignores a stale answer", async () => {
    vi.useFakeTimers();
    const first = deferred<DescriptionSearchResult>();
    const second = deferred<DescriptionSearchResult>();
    const search = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { input } = setup({ search });
    await flush();
    type(input, "눈 내리는");
    await pause(400);
    type(input, "비 오는 거리");
    await pause(400);
    expect(search).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(result("snow-1")); await ticks(); });
    expect(thumbs()).toEqual([]);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith("비 오는 거리", DESCRIPTION_SEARCH_LIMIT);
    await act(async () => { second.resolve(result("rain-1")); await ticks(); });
    expect(thumbs()).toEqual(["rain-1"]);
  });

  it("shows a failure as one muted line in the strip area while the rest of the palette works", async () => {
    vi.useFakeTimers();
    const search = vi.fn().mockRejectedValue(new Error("모델이 없습니다"));
    const { input } = setup({ search });
    await flush();
    type(input, "눈 내리는");
    await pause(400);
    expect(screen.getByRole("group", { name: "이미지 내용" })).toHaveTextContent("내용 검색을 할 수 없습니다: 모델이 없습니다");
    expect(screen.getByRole("option", { name: /눈 내리는 폴더/ })).toBeInTheDocument();
  });

  it("shows a no match answer as one muted line in the strip area and never forces the search", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (): Promise<DescriptionSearchResult> => ({ route: "noMatch", assetIds: [], precise: false }));
    const { input } = setup({ search });
    await flush();
    type(input, "ㅁㄴㅇㄹ");
    await pause(400);
    const group = screen.getByRole("group", { name: "이미지 내용" });
    expect(group.querySelector(".command-palette__strip-status")).toHaveTextContent("일치하는 이미지가 없습니다.");
    expect(thumbs()).toEqual([]);
    expect(search).toHaveBeenCalledExactlyOnceWith("ㅁㄴㅇㄹ", DESCRIPTION_SEARCH_LIMIT);
  });

  it("opens the result state on Enter with the typed query and does not record it as recent", async () => {
    const { input, open, recentKey } = setup();
    await flush();
    type(input, "눈 내리는 겨울");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(open).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("눈 내리는 겨울");
    expect(readRecent(recentKey)).not.toContain("description-search");
  });

  it("orders the group before every other group and keeps it to 전체", () => {
    const row = (id: string, group: NavigationEntry["group"]): NavigationEntry => ({ id, group, label: "별과 " + id, icon: null, run: vi.fn() });
    const list = [row("go", "go"), row("search", "search"), row("content", "content"), row("work", "work")];
    expect(findGroups(list, "별과", "전체", []).map(group => group.group)).toEqual(["content", "search", "work", "go"]);
    expect(findGroups(list, "별과", "작품", []).map(group => group.group)).toEqual(["search", "work"]);
  });
});
