import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette";
import { artistEntries, noteTitleEntries, workEntries } from "./findData";
import { findGroups, matchedSpans, readRecent, rememberRecent, FIND_SCOPES } from "./findModel";
import { placeEntries, type NavigationEntry } from "./navigationEntries";
import type { CollectionSummary } from "../library/types";
import type { ArtistSummary } from "../artists/types";
import { PrivacyProvider } from "../privacy/PrivacyContext";

let testNumber = 0;
const nextKey = () => `find-test-${testNumber++}`;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const row = (id: string, group: NavigationEntry["group"], label = "별과 " + id): NavigationEntry => ({ id, group, label, icon: null, run: vi.fn() });
function data(onNavigate = vi.fn()) {
  return [
    ...workEntries(["game", "manga", "movie", "av"].map(type => ({ id: type, name: "별과 " + type, type, originalTitle: null, coverAssetId: "cover" } as CollectionSummary)), onNavigate),
    ...artistEntries([{ id: "artist:a", label: "별과 작가", keys: [], assetCount: 10, hidden: false, coverAssetIds: ["avatar"] } as unknown as ArtistSummary], onNavigate),
    ...noteTitleEntries([{ id: "n", title: "별과 메모", type: "secret", deleted: false }], onNavigate),
    ...placeEntries({ classifications: [{ id: "f", name: "별과 폴더", kind: "root", parentId: null, colorKey: null, iconKey: null }],
      albums: [{ id: "a", name: "별과 앨범", parentId: null, colorKey: null, iconKey: null }] }, "", { kind: "home" }, onNavigate),
    row("screen", "go"), row("command", "action"),
  ];
}

describe("device name search", () => {
  it("groups every kind in order, filters scopes, and matches Korean initials", () => {
    const entries = data();
    expect(findGroups(entries, "ㅂㄱ", "전체", []).map(group => group.group)).toEqual(["work", "artist", "note", "place", "go", "action"]);
    for (const [scope, group] of [["작품", "work"], ["작가", "artist"], ["메모", "note"], ["폴더", "place"], ["화면", "go"], ["명령", "action"]] as const) {
      expect(findGroups(entries, "별과", scope, []).map(result => result.group)).toEqual([group]);
    }
    expect(matchedSpans("은하 별과 바다", "ㅂㄱ").filter(span => span.matched).map(span => span.text)).toEqual(["별과"]);
  });
  it("projects titles only, including protected notes, excluding deleted and internal month notes", () => {
    const notes = [
      { id: "text", title: "ordinary", body: "body-only", deleted: false },
      { id: "secret", title: "protected", fields: [{ value: "password" }], type: "secret", deleted: false },
      { id: "concealed", title: "hidden title", body: "hidden body", concealed: true, deleted: false },
      { id: "deleted", title: "deleted", deleted: true },
      { id: "month", title: "month", type: "ledger-month", deleted: false },
    ];
    const entries = noteTitleEntries(notes, vi.fn());
    expect(entries.map(entry => entry.id)).toEqual(["note-text", "note-secret", "note-concealed"]);
    for (const query of ["body-only", "password", "hidden body"]) expect(findGroups(entries, query, "전체", [])).toEqual([]);
    expect(JSON.stringify(entries)).not.toMatch(/body-only|password|hidden body/);
  });
  it("cycles all scopes with Tab, backwards with Shift+Tab, retaining input focus", async () => {
    const user = userEvent.setup();
    render(<CommandPalette open onClose={vi.fn()} entries={data()} recentKey={nextKey()} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "별과");
    for (const scope of [...FIND_SCOPES.slice(1), FIND_SCOPES[0]]) {
      await user.tab();
      expect(screen.getByRole("button", { name: scope })).toHaveAttribute("aria-pressed", "true");
      expect(input).toHaveFocus();
    }
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "명령" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });
  it("keeps the current screen search first in every scope and applies its draft", async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    render(<CommandPalette open onClose={vi.fn()} entries={data()} recentKey={nextKey()} search={{ info: { kind: "query", scope: "망가", label: "검색", query: "" }, apply, open: vi.fn() }} />);
    await user.type(screen.getByRole("combobox"), "별과");
    await user.tab();
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("망가에서 ‘별과’ 검색");
    await user.keyboard("{Enter}");
    expect(apply).toHaveBeenCalledWith("별과");
  });
  it.each([
    ["work-game", { kind: "collection", collectionId: "game" }],
    ["work-manga", { kind: "collection", collectionId: "manga" }],
    ["work-movie", { kind: "collection", collectionId: "movie" }],
    ["work-av", { kind: "collection", collectionId: "av" }],
    ["artist-artist:a", { kind: "creator", creatorKey: "artist:a" }],
    ["note-n", { kind: "notes", noteId: "n" }],
    ["place-folder-f", { kind: "classification", classificationId: "f" }],
    ["place-album-a", { kind: "album", albumId: "a" }],
  ])("opens %s with Enter and records a recent ID", async (id, destination) => {
    const user = userEvent.setup();
    const navigate = vi.fn(); const close = vi.fn(); const key = nextKey();
    const entries = data(navigate).filter(entry => entry.id === id);
    render(<CommandPalette open onClose={close} entries={entries} recentKey={key} />);
    await user.type(screen.getByRole("combobox"), "ㅂㄱ");
    await user.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith(destination);
    expect(close).toHaveBeenCalledOnce();
    expect(readRecent(key)).toEqual([id]);
  });
  it("runs commands, preserves Escape and ignores composing keys", async () => {
    const user = userEvent.setup(); const command = row("cmd", "action"); const close = vi.fn();
    render(<CommandPalette open onClose={close} entries={[command]} recentKey={nextKey()} />);
    await user.type(screen.getByRole("combobox"), "별과");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", keyCode: 229 });
    expect(command.run).not.toHaveBeenCalled();
    await user.keyboard("{Enter}"); expect(command.run).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}"); expect(close).toHaveBeenCalledTimes(2);
  });
  it("shows five per group and expands by keyboard without closing", async () => {
    const user = userEvent.setup(); const close = vi.fn();
    render(<CommandPalette open onClose={close} entries={Array.from({ length: 8 }, (_, at) => row(String(at), "work"))} recentKey={nextKey()} />);
    await user.type(screen.getByRole("combobox"), "별과");
    expect(within(screen.getByRole("group", { name: "작품" })).getAllByRole("option")).toHaveLength(6);
    await user.keyboard("{Control>}{End}{/Control}{Enter}");
    expect(screen.getAllByRole("option")).toHaveLength(9);
    expect(close).not.toHaveBeenCalled();
  });
  it("shows only queues and resolved recent items when empty; removes missing IDs and deduplicates", async () => {
    const key = nextKey();
    for (const id of ["deleted", "a", "b", "c", "d", "e", "a"]) rememberRecent(key, id);
    expect(readRecent(key)).toEqual(["a", "e", "d", "c", "b"]);
    render(<CommandPalette open onClose={vi.fn()} entries={[row("q", "queue", "유사 검토"), ...["a", "b", "c", "d", "e"].map(id => row(id, "work")), row("screen", "go")]} recentKey={key} />);
    expect(screen.getAllByRole("option")).toHaveLength(6);
    expect(screen.getByRole("group", { name: "최근 연 것" })).toBeVisible();
    expect(screen.queryByText("별과 screen")).not.toBeInTheDocument();
    expect(findGroups(data(), "", "전체", ["missing"])).toEqual([]);
  });
  it("retains an in-memory recent list when localStorage cannot be written", () => {
    const key = nextKey();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    rememberRecent(key, "work-one"); rememberRecent(key, "note-two");
    expect(readRecent(key)).toEqual(["note-two", "work-one"]);
    expect(readRecent(nextKey())).toEqual([]);
  });
  it("shows a truthful empty state and keeps thumbnails out of privacy mode", async () => {
    const user = userEvent.setup();
    const tree = (privacy: boolean) => <PrivacyProvider privacyMode={privacy} setPrivacyMode={vi.fn()}><CommandPalette open onClose={vi.fn()} entries={data()} recentKey="privacy-test" /></PrivacyProvider>;
    const { rerender } = render(tree(false));
    expect(screen.getByText("확인할 것과 최근 연 항목이 없습니다.")).toBeVisible();
    await user.type(screen.getByRole("combobox"), "별과");
    expect(document.querySelector(".command-palette img")).not.toBeNull();
    rerender(tree(true));
    expect(document.querySelector(".command-palette img")).toBeNull();
    await user.clear(screen.getByRole("combobox")); await user.type(screen.getByRole("combobox"), "없는이름");
    expect(screen.getByText("일치하는 이름이 없습니다.")).toBeVisible();
  });
});
