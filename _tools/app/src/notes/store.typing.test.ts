import { afterEach, expect, it, vi } from "vitest";
import { NotesStore, type Note, type NotesRequest } from "./store";

const note: Note = { id: "a", title: "Draft", body: "", pinned: false, deleted: false, createdAt: "now", updatedAt: "now", localRevision: 1, pending: false, conflict: false };
afterEach(() => vi.useRealTimers());
async function setup() {
  vi.useFakeTimers();
  const request = vi.fn(async (operation: string, input: any) => operation === "save"
    ? { ...note, ...input, localRevision: input.expectedRevision + 1, pending: true }
    : { unlocked: true, notes: [note], lastSyncedAt: null });
  const store = new NotesStore(request as NotesRequest);
  await store.load();
  return { store, request, saves: () => request.mock.calls.filter(([op]) => op === "save") };
}

it("bounds unsaved continuous typing to two seconds", async () => {
  const { store, saves } = await setup();
  for (let i = 1; i <= 20; i++) {
    store.edit({ ...store.snapshot().notes[0], body: String(i) }, true);
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(saves()).toHaveLength(2);
  expect(saves()[1][1]).toMatchObject({ body: "20" });
});

it("flush waits for an in-flight leading save and rebases the latest queued typing", async () => {
  const { store, request, saves } = await setup();
  let complete!: (note: Note) => void;
  request.mockImplementationOnce(() => new Promise<Note>(resolve => { complete = resolve; }));
  store.edit({ ...note, body: "first" }, true);
  store.edit({ ...note, body: "latest" }, true);
  const flushed = store.flush();
  complete({ ...note, title: "Merged title", body: "first", localRevision: 2, pending: true });
  expect(await flushed).toBe(true);
  expect(saves()[1][1]).toMatchObject({ body: "latest", title: "Merged title", expectedRevision: 2 });
  await vi.advanceTimersByTimeAsync(2000);
  expect(saves()).toHaveLength(2);
});

it("keeps the trailing debounce when a slow leading save finishes during typing", async () => {
  const { store, request, saves } = await setup();
  let complete!: (note: Note) => void;
  request.mockImplementationOnce(() => new Promise<Note>(resolve => { complete = resolve; }));
  store.edit({ ...note, body: "first" }, true);
  await vi.advanceTimersByTimeAsync(100);
  store.edit({ ...note, body: "latest" }, true);
  complete({ ...note, body: "first", localRevision: 2, pending: true });
  await vi.advanceTimersByTimeAsync(100);
  expect(saves()).toHaveLength(1);
  expect(store.snapshot().notes[0].body).toBe("latest");
  expect(store.snapshot().saving).toBe(true);
  await vi.advanceTimersByTimeAsync(400);
  expect(saves()).toHaveLength(2);
  expect(saves()[1][1]).toMatchObject({ body: "latest", expectedRevision: 2 });
});

it("retains failed trailing saves for the close guard and retries them on flush", async () => {
  const { store, request } = await setup();
  store.edit({ ...note, body: "first" }, true);
  await vi.advanceTimersByTimeAsync(0);
  store.edit({ ...store.snapshot().notes[0], body: "latest" }, true);
  request.mockRejectedValueOnce("disk full");
  await vi.advanceTimersByTimeAsync(500);
  expect(store.snapshot()).toMatchObject({ saving: true, error: "disk full" });
  expect(store.snapshot().notes[0].body).toBe("latest");
  expect(await store.flush()).toBe(true);
  expect(store.snapshot().notes[0].body).toBe("latest");
});
