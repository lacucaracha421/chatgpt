import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotesStore, type Note } from "../notes/store";
import { HomeQuickMemo } from "./HomeQuickMemo";
import { findQuickMemo, readQuickMemoId, writeQuickMemoId } from "./quickMemo";

const note = (id: string, fields: Partial<Note> = {}): Note => ({ id, title: "빠른 메모", body: "", pinned: false, deleted: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", localRevision: 1, pending: false, conflict: false, ...fields });

/** A notes backend in memory: what is saved is what the next state or sync returns. */
function backend(initial: Note[] = [], state: { unlocked?: boolean } = {}) {
  const server = new Map(initial.map(item => [item.id, item]));
  const saves: Array<Record<string, unknown>> = [];
  const request = vi.fn(async (operation: string, input?: unknown) => {
    if (operation === "save") {
      const draft = input as { id: string; expectedRevision: number; title: string; body: string };
      saves.push(draft);
      const stored = { ...note(draft.id), ...draft, localRevision: draft.expectedRevision + 1, pending: false, conflict: false } as Note;
      server.set(draft.id, stored);
      return stored as never;
    }
    return { unlocked: state.unlocked ?? true, notes: [...server.values()], lastSyncedAt: null } as never;
  });
  return { store: new NotesStore(request), server, saves, request };
}

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function mount(initial: Note[] = [], state: { unlocked?: boolean } = {}, props: Partial<Parameters<typeof HomeQuickMemo>[0]> = {}) {
  const fixture = backend(initial, state);
  await fixture.store.load();
  const onOpenNotes = vi.fn();
  render(<HomeQuickMemo store={fixture.store} root="lib" onOpenNotes={onOpenNotes} {...props} />);
  return { ...fixture, onOpenNotes, text: () => screen.getByRole("textbox", { name: "빠른 메모" }) as HTMLTextAreaElement };
}
const type = (field: HTMLTextAreaElement, value: string) => fireEvent.change(field, { target: { value } });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it("creates the note once, on the first text, and keeps saving into the same note", async () => {
  const { saves, text, server } = await mount();
  expect(saves).toHaveLength(0);
  type(text(), "금요일까지 반품");
  await wait(799);
  expect(saves).toHaveLength(0);
  await wait(1);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ title: "빠른 메모", body: "금요일까지 반품", expectedRevision: 0 });
  const id = saves[0]!.id as string;
  expect(readQuickMemoId("lib")).toBe(id);
  type(text(), "금요일까지 반품\n장보기");
  await wait(3000);
  expect(saves[saves.length - 1]).toMatchObject({ id, body: "금요일까지 반품\n장보기" });
  expect(new Set(saves.map(save => save.id))).toEqual(new Set([id]));
  expect(server.size).toBe(1);
  expect(text().value).toBe("금요일까지 반품\n장보기");
});

it("saves only after the typing pauses, once for a burst of keys", async () => {
  const { saves, text } = await mount([note("memo", { body: "처음" })]);
  expect(text().value).toBe("처음");
  type(text(), "처음 a");
  await wait(500);
  type(text(), "처음 ab");
  await wait(500);
  type(text(), "처음 abc");
  await wait(799);
  expect(saves).toHaveLength(0);
  await wait(1);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ id: "memo", body: "처음 abc", expectedRevision: 1 });
  // The typed text stays on screen through the save.
  expect(text().value).toBe("처음 abc");
});

it("saves at once when the field loses focus", async () => {
  const { saves, text } = await mount([note("memo")]);
  type(text(), "바로 저장");
  fireEvent.blur(text());
  await wait(0);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ id: "memo", body: "바로 저장" });
});

it("saves a pending draft when Home is left", async () => {
  const fixture = await mount([note("memo")]);
  type(fixture.text(), "떠나기 전");
  cleanup();
  await wait(0);
  expect(fixture.saves[0]).toMatchObject({ id: "memo", body: "떠나기 전" });
});

it("finds its note by the saved id, then by the title, and ignores a trashed one", () => {
  const notes = [note("other", { title: "다른 메모" }), note("late", { createdAt: "2026-10-05T00:00:00Z" }), note("early", { createdAt: "2026-10-02T00:00:00Z" }), note("gone", { deleted: true, createdAt: "2026-09-01T00:00:00Z" }), note("list", { type: "checklist", createdAt: "2026-08-01T00:00:00Z" })];
  expect(findQuickMemo(notes, "other")?.id).toBe("other");
  expect(findQuickMemo(notes, "missing")?.id).toBe("early");
  expect(findQuickMemo(notes, "gone")?.id).toBe("early");
  expect(findQuickMemo([note("x", { title: "다른" })], null)).toBeNull();
});

it("remembers the note it found by title and shows the same text as the 메모 tab", async () => {
  const { text } = await mount([note("tab-note", { body: "메모 탭의 글" })]);
  expect(text().value).toBe("메모 탭의 글");
  expect(readQuickMemoId("lib")).toBe("tab-note");
});

it("follows a change from another device while nothing is being typed, and keeps typed text", async () => {
  const { store, server, text } = await mount([note("memo", { body: "원래" })]);
  server.set("memo", note("memo", { body: "다른 기기에서", localRevision: 2 }));
  await act(async () => { await store.refresh(); });
  expect(text().value).toBe("다른 기기에서");
  type(text(), "내가 쓰는 중");
  server.set("memo", note("memo", { body: "또 다른 변경", localRevision: 3 }));
  await act(async () => { await store.refresh(); });
  expect(text().value).toBe("내가 쓰는 중");
});

it("shows an edit collision and resolves it the way the 메모 tab does", async () => {
  const { text, request } = await mount([note("memo", { body: "충돌", conflict: true })]);
  expect(text().value).toBe("충돌");
  expect(screen.getByRole("status")).toHaveTextContent("다른 기기 수정과 충돌했습니다.");
  fireEvent.click(screen.getByRole("button", { name: "내 내용 보관 후 서버 버전 불러오기" }));
  await wait(0);
  expect(request).toHaveBeenCalledWith("resolve", expect.objectContaining({ id: "memo", keepCopy: true }));
});

it("follows a kept copy when a stale draft could not merge", async () => {
  const { store, saves, text, request } = await mount([note("memo", { body: "원본" })]);
  request.mockImplementationOnce(async (_operation: string, input?: unknown) => ({ ...note("memo"), ...(input as object), copiedTo: "copy", localRevision: 2 }) as never);
  type(text(), "내 글");
  await wait(800);
  expect(store.snapshot().moved).toBeNull();
  type(text(), "내 글 계속");
  await wait(3000);
  expect(saves[saves.length - 1]).toMatchObject({ id: "copy", body: "내 글 계속" });
  expect(readQuickMemoId("lib")).toBe("copy");
});

it("asks to open the 메모 tab instead of taking text while the notes are locked", async () => {
  const { text, onOpenNotes } = await mount([], { unlocked: false });
  expect(text()).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "메모 열기" }));
  expect(onOpenNotes).toHaveBeenCalledOnce();
});

it("does not write a note for an empty field, and keeps an emptied note", async () => {
  const empty = await mount();
  type(empty.text(), "");
  fireEvent.blur(empty.text());
  await wait(0);
  expect(empty.saves).toHaveLength(0);
  cleanup();
  writeQuickMemoId("lib", "memo");
  const kept = await mount([note("memo", { body: "지울 글" })]);
  type(kept.text(), "");
  fireEvent.blur(kept.text());
  await wait(0);
  expect(kept.saves[0]).toMatchObject({ id: "memo", body: "" });
});
