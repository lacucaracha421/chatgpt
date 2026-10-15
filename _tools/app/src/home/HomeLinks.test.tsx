import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotesStore, type Note } from "../notes/store";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { HomeLinks, type homeLinksApi } from "./HomeLinks";
import { newLinksNote, parseLinks, type KeptLink } from "./links";
vi.mock("../layout/ViewToolbar", () => ({ ViewToolbar: ({ title, leadingAction }: { title: string; leadingAction: React.ReactNode }) => <header>{leadingAction}{title}</header> }));
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); });
const row = (n: number, image = false): KeptLink => ({ url: `https://example.org/${n}`, title: `제목 ${n}`, savedAt: "2026-10-16T00:00:00Z", imageUrl: image ? `https://example.org/${n}.png` : null });
async function mount(links: KeptLink[] = [], options: { expanded?: boolean; privacy?: boolean; unlocked?: boolean; conflict?: boolean; body?: string } = {}) {
  let note: Note | undefined = links.length || options.body ? { ...newLinksNote(links), body: options.body ?? newLinksNote(links).body, conflict: !!options.conflict } : undefined;
  const request = vi.fn(async (operation: string, input?: unknown) => {
    if (operation === "save") { const draft = input as Note; note = { ...note, ...draft, localRevision: (note?.localRevision ?? 0) + 1, pending: false }; return note as never; }
    return { unlocked: options.unlocked ?? true, notes: note ? [note] : [], lastSyncedAt: null } as never;
  });
  const store = new NotesStore(request); await store.load();
  const api: typeof homeLinksApi = { preview: vi.fn(async () => ({ title: "미리보기", imageUrl: "https://example.org/preview.png" })), thumbnail: vi.fn(async () => "data:image/jpeg;base64,AA=="), importImages: vi.fn(async () => ({ imported: 1, message: null })), open: vi.fn(async () => {}), copy: vi.fn(async () => {}) };
  const onOpen = vi.fn(), onBack = vi.fn(), onOpenNotes = vi.fn();
  render(<PrivacyProvider privacyMode={!!options.privacy} setPrivacyMode={() => {}}><HomeLinks root="fixture" store={store} api={api} expanded={options.expanded} onOpen={onOpen} onBack={onBack} onOpenNotes={onOpenNotes} /></PrivacyProvider>);
  return { api, store, onOpen, onBack, request, onOpenNotes };
}
const paste = (url: string) => fireEvent.paste(screen.getByRole("textbox", { name: "URL 붙여넣기" }), { clipboardData: { getData: () => url } });
it("pastes a URL into one note, saves the preview, and dedupes without another fetch", async () => {
  const { api, store } = await mount();
  paste("https://example.org/1");
  await screen.findByText("미리보기");
  expect(store.snapshot().notes).toHaveLength(1);
  expect(parseLinks(store.snapshot().notes[0].body)[0]).toMatchObject({ title: "미리보기", imageUrl: "https://example.org/preview.png" });
  paste("https://example.org/1");
  await act(async () => { await store.flush(); });
  expect(parseLinks(store.snapshot().notes[0].body)).toHaveLength(1);
  expect(api.preview).toHaveBeenCalledTimes(1);
  expect(api.importImages).not.toHaveBeenCalled();
});
it("shows four recent rows and opens the full view from 전체", async () => {
  const { onOpen } = await mount([1, 2, 3, 4, 5].map(n => row(n)));
  expect(screen.getAllByRole("article")).toHaveLength(4);
  expect(screen.queryByText("제목 5")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "전체" })); expect(onOpen).toHaveBeenCalledOnce();
});
it("filters the grid, opens links and imports explicitly with the library root", async () => {
  const { api, store, onBack } = await mount([row(1, true), row(2)], { expanded: true });
  fireEvent.click(screen.getByRole("radio", { name: /이미지 있음/ }));
  expect(screen.queryByText("제목 2")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /제목 1.*example.org/ }));
  expect(api.open).toHaveBeenCalledWith("https://example.org/1");
  fireEvent.click(screen.getByRole("button", { name: "이미지를 에셋으로" }));
  await screen.findByText("기타에 1장 넣음");
  expect(api.importImages).toHaveBeenCalledWith("fixture", "https://example.org/1", "https://example.org/1.png");
  expect(parseLinks(store.snapshot().notes[0].body)[0].imported).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "홈" })); expect(onBack).toHaveBeenCalledOnce();
});
it("masks thumbnails in privacy mode without fetching them", async () => {
  const { api } = await mount([row(1, true)], { privacy: true });
  expect(screen.getByLabelText("이미지 숨김")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull(); expect(api.thumbnail).not.toHaveBeenCalled();
});
it("retains a bare URL when preview fails and accepts dropped web URLs", async () => {
  const { api, store } = await mount(); vi.mocked(api.preview).mockRejectedValueOnce(new Error("offline"));
  fireEvent.drop(screen.getByRole("textbox").closest(".home-tool__body")!, { dataTransfer: { getData: (type: string) => type === "text/uri-list" ? "# comment\nhttps://example.org/drop" : "" } });
  await waitFor(() => expect(api.preview).toHaveBeenCalled());
  expect(parseLinks(store.snapshot().notes[0].body)[0]).toMatchObject({ title: "example.org", url: "https://example.org/drop" });
});
it.each([{ unlocked: false }, { conflict: true }, { body: "손으로 쓴 메모 원문" }])("protects unavailable or damaged notes %j", async options => {
  const { api, request } = await mount([row(1)], options);
  expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
  paste("https://example.org/new");
  expect(api.preview).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(call => call[0] === "save")).toHaveLength(0);
});
it("delays busy text for 400ms and keeps the bare link visible", async () => {
  const { api } = await mount();
  vi.useFakeTimers();
  let finish!: (value: Awaited<ReturnType<typeof api.preview>>) => void;
  vi.mocked(api.preview).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  paste("https://example.org/slow");
  await act(async () => { await vi.advanceTimersByTimeAsync(399); });
  expect(screen.queryByText("링크 작업 중")).toBeNull();
  expect(screen.getByText("example.org")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText("링크 작업 중")).toBeTruthy();
  await act(async () => { finish({ title: "완료" }); await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByText("완료")).toBeTruthy();
  expect(screen.queryByText("링크 작업 중")).toBeNull();
});
it("copies and deletes through the per-link menu", async () => {
  const { api, store } = await mount([row(1)], { expanded: true });
  const trigger = screen.getByRole("button", { name: "제목 1 더보기" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "복사" }));
  expect(api.copy).toHaveBeenCalledWith("https://example.org/1");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "삭제" }));
  await waitFor(() => expect(screen.queryByText("제목 1")).toBeNull());
  expect(parseLinks(store.snapshot().notes[0].body)).toEqual([]);
});
