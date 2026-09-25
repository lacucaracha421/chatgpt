import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RecoveryKeyReveal } from "./NotesView";
import { copySecret, CLIPBOARD_CLEAR_MS } from "./SecretNote";
import { noteLimitProblem, normalizeLabel } from "./model";
import { NotesStore, PIN_REQUIRED_TEXT, SECRET_LOCKED_TEXT, type Note, type NotesRequest } from "./store";

vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,AA" } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const T = "2026-09-20T00:00:00Z";
const note = (change: Partial<Note> = {}): Note => ({ id: "n", title: "장보기", body: "우유", pinned: false, deleted: false, createdAt: T, updatedAt: T, localRevision: 3, pending: false, conflict: false, ...change });
const saves = (request: ReturnType<typeof vi.fn>) => request.mock.calls.filter((c) => c[0] === "save").map((c) => c[1] as Record<string, unknown>);

it("typing during a save that the backend rebased keeps both the typing and the merged fields", async () => {
  vi.useFakeTimers();
  let finish!: (n: Note) => void;
  const request = vi.fn(async (op: string, input?: any) => {
    if (op === "state") return { unlocked: true, notes: [note()], lastSyncedAt: null };
    if (op === "save" && input.expectedRevision === 3) return await new Promise<Note>((r) => (finish = r));
    if (op === "save") return note({ ...input, localRevision: input.expectedRevision + 1, pending: true });
    return null;
  });
  const store = new NotesStore(request as unknown as NotesRequest);
  await store.load();
  store.edit({ ...note(), body: "우유\n빵" });
  await vi.advanceTimersByTimeAsync(0);
  store.edit({ ...store.snapshot().notes[0]!, body: "우유\n빵\n달걀" });
  // The pull renamed the note while the first save was queued; the backend merged it (revision 3 -> 5).
  finish(note({ title: "주말 장보기", body: "우유\n빵", localRevision: 5, pending: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(saves(request)[1]).toMatchObject({ expectedRevision: 5, title: "주말 장보기", body: "우유\n빵\n달걀" });
  expect(store.snapshot().notes[0]).toMatchObject({ title: "주말 장보기", body: "우유\n빵\n달걀", localRevision: 6 });
  expect(store.snapshot().error).toBeNull();
});

it("a stale draft kept as a copy moves the queued typing to that copy", async () => {
  vi.useFakeTimers();
  let finish!: (n: Note) => void;
  const request = vi.fn(async (op: string, input?: any) => {
    if (op === "state") return { unlocked: true, notes: [note()], lastSyncedAt: null };
    if (op === "save" && input.id === "n") return await new Promise<Note>((r) => (finish = r));
    if (op === "save") return note({ ...input, localRevision: input.expectedRevision + 1, pending: true, conflictCopy: true });
    return null;
  });
  const store = new NotesStore(request as unknown as NotesRequest);
  await store.load();
  store.edit({ ...note(), body: "이 PC" });
  await vi.advanceTimersByTimeAsync(0);
  store.edit({ ...store.snapshot().notes[0]!, body: "이 PC 더" });
  finish(note({ body: "다른 기기", localRevision: 4, copiedTo: "copy" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(saves(request)[1]).toMatchObject({ id: "copy", expectedRevision: 1, body: "이 PC 더" });
  expect(store.snapshot().moved).toEqual({ from: "n", to: "copy" });
  expect(store.snapshot().notes.find((n) => n.id === "n")!.body).toBe("다른 기기");
});

it("a secret save refused for a closed PIN session waits for the PIN and keeps the draft", async () => {
  vi.useFakeTimers();
  let open = false;
  const secret = note({ type: "secret", fields: [{ id: "f", label: "pw", value: "a", order: "V" }], memo: "", redacted: false });
  const request = vi.fn(async (op: string, input?: any) => {
    if (op === "state" || op === "secretUnlock") { if (op === "secretUnlock") open = true; return { unlocked: true, notes: [secret], lastSyncedAt: null }; }
    if (op === "save") { if (!open) throw SECRET_LOCKED_TEXT; return { ...secret, ...input, localRevision: 4 }; }
    if (op === "secretTouch") return { unlocked: open };
    return null;
  });
  const store = new NotesStore(request as unknown as NotesRequest);
  await store.load();
  store.edit({ ...secret, fields: [{ id: "f", label: "pw", value: "new" }] as Note["fields"] });
  await vi.advanceTimersByTimeAsync(0);
  expect(store.snapshot()).toMatchObject({ secretLocked: true, error: null, saving: true });
  // Locking or an expired session never hides a draft that is still queued.
  await store.touchSecrets();
  await store.lockSecrets();
  expect(store.snapshot().notes[0]!.fields![0]!.value).toBe("new");
  // A metadata edit from a redacted copy keeps the queued revealed draft.
  store.edit({ ...secret, redacted: true, fields: undefined, pinned: true });
  expect(store.snapshot().notes[0]).toMatchObject({ pinned: true, redacted: false });
  expect(store.snapshot().notes[0]!.fields![0]!.value).toBe("new");
  expect(await store.openSecrets("secretUnlock", { pin: "2468" })).toBeNull();
  expect(await store.flush()).toBe(true);
  expect(saves(request)[saves(request).length - 1]).toMatchObject({ pinned: true, fields: [expect.objectContaining({ value: "new" })] });
  expect({ secretLocked: store.snapshot().secretLocked, saving: store.snapshot().saving, error: store.snapshot().error }).toEqual({ secretLocked: false, saving: false, error: null });
  // With nothing queued, an expired backend session redacts the secret in memory.
  open = false;
  await store.touchSecrets();
  expect(store.snapshot().notes[0]).toMatchObject({ redacted: true, fields: undefined });
});

it("showing the recovery key asks for the secret-note PIN once a PIN exists", async () => {
  let unlocked = false;
  const request = vi.fn(async (op: string) => {
    if (op === "recoveryKey") { if (!unlocked) throw PIN_REQUIRED_TEXT; return { key: "c".repeat(64) }; }
    if (op === "secretUnlock") { unlocked = true; return { unlocked: true, notes: [], lastSyncedAt: null }; }
    return null;
  });
  render(<RecoveryKeyReveal store={new NotesStore(request as unknown as NotesRequest)} />);
  await userEvent.click(screen.getByRole("button", { name: "복구키 보기" }));
  await userEvent.type(await screen.findByLabelText("암호 메모 PIN"), "2468");
  await userEvent.click(screen.getByRole("button", { name: "확인 후 복구키 보기" }));
  expect(await screen.findByRole("textbox", { name: "복구키" })).toHaveValue("c".repeat(64));
});

it("clears a copied secret from the clipboard after 30 s only if it is still there", async () => {
  vi.useFakeTimers();
  let clip = "";
  vi.stubGlobal("navigator", { clipboard: { writeText: async (v: string) => { clip = v; }, readText: async () => clip } });
  await copySecret("hunter2");
  expect(clip).toBe("hunter2");
  await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
  expect(clip).toBe("");
  await copySecret("hunter2");
  clip = "something else";
  await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
  expect(clip).toBe("something else");
});

it("checks whole-note limits before queueing and slices labels by code point", () => {
  expect(noteLimitProblem({ title: "t", body: "b" })).toBeNull();
  expect(noteLimitProblem({ title: "가".repeat(201), body: "" })).toMatch(/200자/);
  expect(noteLimitProblem({ title: "😀".repeat(200), body: "" })).toBeNull();
  expect(noteLimitProblem({ title: "", body: "가".repeat(50_000) })).toMatch(/128 KiB/);
  expect(noteLimitProblem({ title: "", body: "", type: "checklist", items: Array.from({ length: 501 }, (_, i) => ({ id: `${i}`, text: "x", checked: false, order: "V" })) })).toMatch(/500개/);
  expect(noteLimitProblem({ title: "", body: "", type: "secret", memo: "a".repeat(100 * 1024), fields: Array.from({ length: 200 }, (_, i) => ({ id: `${i}`, label: "l", value: "v".repeat(1000), order: "V" })) })).toMatch(/KiB/);
  expect(Array.from(normalizeLabel("😀".repeat(45)))).toHaveLength(40);
});
