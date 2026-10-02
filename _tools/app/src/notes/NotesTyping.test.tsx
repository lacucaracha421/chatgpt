import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotesWorkspace } from "./NotesView";
import { NotesStore, type Note, type NotesRequest } from "./store";

const note: Note = { id: "a", title: "First", body: "", pinned: false, deleted: false, createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", localRevision: 1, pending: false, conflict: false };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup() {
  vi.useFakeTimers();
  let notes = [note, { ...note, id: "b", title: "Second" }];
  const request = vi.fn(async (operation: string, input: any) => {
    if (operation === "save") {
      const saved = { ...notes.find(n => n.id === input.id)!, ...input, localRevision: input.expectedRevision + 1, pending: true };
      notes = notes.map(n => n.id === saved.id ? saved : n);
      return saved;
    }
    if (operation === "sync") notes = notes.map(n => ({ ...n, pending: false }));
    return { unlocked: true, notes, lastSyncedAt: null };
  });
  const store = new NotesStore(request as NotesRequest);
  await store.load();
  const commits: Array<{ body: string; saving: boolean; revision: number }> = [];
  const view = render(<Profiler id="notes" onRender={() => {
    const snapshot = store.snapshot();
    commits.push({ body: snapshot.notes.find(n => n.id === "a")!.body, saving: snapshot.saving, revision: snapshot.notes.find(n => n.id === "a")!.localRevision });
  }}><NotesWorkspace store={store} initialNoteId="a" /></Profiler>);
  await act(async () => {});
  request.mockClear(); commits.length = 0;
  const type = async (body: string) => { await act(async () => { fireEvent.change(screen.getByRole("textbox", { name: "메모 본문" }), { target: { value: body } }); }); };
  const saves = () => request.mock.calls.filter(([operation]) => operation === "save");
  return { store, view, request, commits, type, saves };
}

it("coalesces a ten-character burst with one input commit per key after the leading save", async () => {
  const { type, commits, saves, store } = await setup();
  for (let i = 1; i <= 10; i++) {
    const before = commits.length;
    await type("가".repeat(i));
    expect(commits.length - before).toBe(i === 1 ? 2 : 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  }
  expect(saves()).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(saves()).toHaveLength(2);
  expect(saves()[1][1]).toMatchObject({ body: "가".repeat(10), expectedRevision: 2 });
  expect(store.snapshot().saving).toBe(false);
  // Ten input commits, two durable save acknowledgements and the editing-status timeout.
  expect(commits).toHaveLength(13);
});

it.each(["editor blur", "window blur", "hidden", "switch", "unmount"])("flushes trailing typing on %s before the debounce expires", async (exit) => {
  const { type, saves, store, view } = await setup();
  await type("first"); await type("latest");
  expect(saves()).toHaveLength(1);
  expect(store.snapshot().saving).toBe(true);
  await act(async () => {
    if (exit === "editor blur") fireEvent.blur(screen.getByRole("textbox", { name: "메모 본문" }));
    if (exit === "window blur") fireEvent.blur(window);
    if (exit === "hidden") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      fireEvent(document, new Event("visibilitychange"));
    }
    if (exit === "switch") fireEvent.click(screen.getByRole("button", { name: "메모 닫기" }));
    if (exit === "unmount") view.unmount();
  });
  expect(saves()).toHaveLength(2);
  expect(saves()[1][1]).toMatchObject({ id: "a", body: "latest" });
  expect(store.snapshot().saving).toBe(false);
  if (exit === "switch") {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Second/ })); });
    expect(screen.getByRole("textbox", { name: "메모 제목" })).toHaveValue("Second");
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(saves()).toHaveLength(2);
});

it("leaves composition input untouched and saves only accepted text on composition end", async () => {
  const { type, saves } = await setup();
  await type("before"); await type("accepted");
  const area = screen.getByRole("textbox", { name: "메모 본문" });
  fireEvent.compositionStart(area);
  fireEvent.change(area, { target: { value: "acceptedㅎ" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(saves()[1][1]).toMatchObject({ body: "accepted" });
  expect(area).toHaveValue("acceptedㅎ");
  fireEvent.change(area, { target: { value: "accepted한" } });
  await act(async () => { fireEvent.compositionEnd(area); });
  expect(saves()[2][1]).toMatchObject({ body: "accepted한" });
});
