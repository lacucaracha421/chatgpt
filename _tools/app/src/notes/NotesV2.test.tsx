import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceChromeProvider, ChromeTarget } from "../layout/WorkspaceChrome";
import { NotesWorkspace, SECRET_IDLE_MS } from "./NotesView";
import { NotesStore, type Note, type NotesRequest } from "./store";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

const T = "2026-09-20T00:00:00Z";
const base = (id: string, change: Partial<Note> = {}): Note => ({ id, title: id, body: "", pinned: false, deleted: false, createdAt: T, updatedAt: T, localRevision: 1, pending: false, conflict: false, ...change });

/** In-memory stand-in for the Rust notes backend: saves merge the draft over the stored note. */
function backend(initial: Note[], options: { keyringLocked?: boolean; secret?: { fields: Note["fields"]; memo: string } } = {}) {
  let notes = initial;
  let keyringLocked = options.keyringLocked ?? false;
  let secretOpen = false;
  const calls: { op: string; input: any }[] = [];
  const view = (n: Note) => (n.type === "secret" && !secretOpen ? { ...n, fields: undefined, memo: undefined, labels: undefined, body: "", redacted: true } : { ...n, redacted: false });
  const state = () => ({ unlocked: !keyringLocked, keyringLocked, notes: keyringLocked ? [] : notes.map(view), lastSyncedAt: null });
  const request = (async (op: string, input: any) => {
    calls.push({ op, input });
    if (op === "save") {
      const { expectedRevision, ...draft } = input;
      const old = notes.find((n) => n.id === draft.id) ?? base(draft.id, { title: "", localRevision: 0 });
      const saved: Note = { ...old, ...draft, localRevision: expectedRevision + 1, pending: true };
      if (saved.type === "checklist") saved.body = "(fallback)";
      notes = [saved, ...notes.filter((n) => n.id !== saved.id)];
      return view(saved);
    }
    if (op === "unlockKeyring") keyringLocked = false;
    if (op === "secretStatus") return { pinSet: true, unlocked: secretOpen };
    if (op === "secretUnlock") { if (input.pin !== "2468") throw "PIN이 맞지 않습니다."; secretOpen = true; }
    if (op === "secretLock") { secretOpen = false; return null; }
    return state();
  }) as NotesRequest;
  return { request, calls, saves: () => calls.filter((c) => c.op === "save").map((c) => c.input) };
}
function surface(store: NotesStore) {
  return render(<WorkspaceChromeProvider scope="notes"><ChromeTarget name="navigation" /><ChromeTarget name="actions" /><ChromeTarget name="search" /><NotesWorkspace store={store} /></WorkspaceChromeProvider>);
}
const last = <T,>(list: T[]) => list[list.length - 1];
const settle = (store: NotesStore) => waitFor(() => expect(store.snapshot().saving).toBe(false));

it("renders text notes as Markdown and ticking a task rewrites that line", async () => {
  const fake = backend([base("할 일", { body: "# 오늘\n- [ ] 우유\n- [ ] 빵" })]);
  const store = new NotesStore(fake.request); surface(store);
  await userEvent.click(await screen.findByRole("button", { name: /할 일/ }));
  expect(screen.getByRole("heading", { name: "오늘" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "메모 본문" })).not.toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("checkbox")[1]!);
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ body: "# 오늘\n- [ ] 우유\n- [x] 빵", type: "text" });
  // No visible 보기/편집 toggle: clicking the text edits it; Esc or leaving it shows Markdown again.
  expect(screen.queryByRole("button", { name: "편집" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "마크다운 도움말" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("heading", { name: "오늘" }));
  const source = screen.getByRole("textbox", { name: "메모 본문" });
  await waitFor(() => expect(source).toHaveFocus());
  expect(source).toHaveValue("# 오늘\n- [ ] 우유\n- [x] 빵");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "메모 본문" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("heading", { name: "오늘" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "메모 본문" })).toHaveFocus());
  await userEvent.click(screen.getByRole("textbox", { name: "메모 제목" }));
  expect(screen.queryByRole("textbox", { name: "메모 본문" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "오늘" })).toBeInTheDocument();
});

it("creates a checklist, adds items with Enter, checks one into the 완료 group and reorders with Alt+Arrow", async () => {
  const fake = backend([]);
  const store = new NotesStore(fake.request); surface(store);
  await userEvent.click(await screen.findByRole("button", { name: "새 메모" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "체크리스트" }));
  await userEvent.click(screen.getByRole("button", { name: "항목 추가" }));
  await userEvent.keyboard("우유{Enter}빵{Enter}달걀");
  await settle(store);
  const items = () => store.snapshot().notes[0]!.items!;
  expect(items().map((i) => i.text).sort()).toEqual(["달걀", "빵", "우유"]);
  const open = within(screen.getByRole("list", { name: "할 일" }));
  expect(open.getAllByRole("textbox").map((i) => (i as HTMLInputElement).value)).toEqual(["우유", "빵", "달걀"]);
  // Alt+Up moves 달걀 above 빵 by rewriting only its order key.
  const before = new Map(items().map((i) => [i.text, i.order]));
  fireEvent.keyDown(open.getAllByRole("textbox")[2]!, { key: "ArrowUp", altKey: true });
  await settle(store);
  expect(open.getAllByRole("textbox").map((i) => (i as HTMLInputElement).value)).toEqual(["우유", "달걀", "빵"]);
  expect(items().find((i) => i.text === "빵")!.order).toBe(before.get("빵"));
  await userEvent.click(screen.getByRole("checkbox", { name: "우유 완료" }));
  await settle(store);
  const done = screen.getByRole("list", { name: "완료한 항목" });
  expect(within(done).getByRole("textbox")).toHaveValue("우유");
  await userEvent.click(screen.getByRole("button", { name: "완료 1" }));
  expect(screen.queryByRole("list", { name: "완료한 항목" })).not.toBeInTheDocument();
  expect(last(fake.saves())).toMatchObject({ type: "checklist", items: expect.arrayContaining([expect.objectContaining({ text: "우유", checked: true })]) });
  expect(last(fake.saves())).not.toHaveProperty("body");
});

it("colours, labels, label filter, search and archive", async () => {
  const fake = backend([
    base("회의", { body: "안건 정리", labels: ["업무"], updatedAt: "2026-09-21T00:00:00Z" }),
    base("여행", { body: "여권" }),
    base("계정", { type: "secret", fields: [{ id: "f", label: "비밀번호", value: "여권번호", order: "V" }], memo: "" }),
  ]);
  const store = new NotesStore(fake.request); surface(store);
  await userEvent.click(await screen.findByRole("button", { name: /여행/ }));
  await userEvent.click(screen.getByRole("button", { name: "메모 색상" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: /파랑/ }));
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ color: "blue" });
  await userEvent.click(screen.getByRole("button", { name: "＋ 라벨" }));
  await userEvent.keyboard("  개인  {Enter}");
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ labels: ["개인"] });
  // Side label list filters the list.
  const labels = within(screen.getByLabelText("라벨", { selector: ".notes-label-index" }));
  await userEvent.click(labels.getByRole("button", { name: /업무/ }));
  const list = within(screen.getByLabelText("메모 목록"));
  expect(list.getAllByRole("button").map((b) => b.textContent)).toEqual([expect.stringContaining("회의")]);
  // Search: secret notes match by title only (their values stay hidden).
  await userEvent.click(screen.getByRole("button", { name: /모든 메모/ }));
  expect(list.getAllByRole("button")).toHaveLength(3);
  expect(list.getByRole("button", { name: /계정/ })).toHaveTextContent("암호 메모");
  // Archive leaves the main list and shows up under 보관함.
  await userEvent.click(list.getByRole("button", { name: /회의/ }));
  // Archive lives in the ⋯ menu next to 휴지통.
  expect(screen.queryByRole("button", { name: "보관" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "메모 더보기" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "보관함으로 보내기" }));
  await settle(store);
  expect(list.queryByRole("button", { name: /회의/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "보관함" }));
  expect(list.getByRole("button", { name: /회의/ })).toBeInTheDocument();
});

it("search matches checklist items and labels but only titles of secret notes", async () => {
  const { noteMatches } = await import("./NotesView");
  const secret = base("은행", { type: "secret", body: "비밀번호: 1234", redacted: false, fields: [{ id: "f", label: "비밀번호", value: "1234", order: "V" }] });
  expect(noteMatches(secret, "은행")).toBe(true);
  expect(noteMatches(secret, "1234")).toBe(false);
  expect(noteMatches(base("장보기", { type: "checklist", items: [{ id: "a", text: "우유", checked: false, order: "V" }] }), "우유")).toBe(true);
  expect(noteMatches(base("x", { labels: ["업무"] }), "업무")).toBe(true);
  // Korean-aware: 초성, a syllable still being composed, case/space-insensitive.
  expect(noteMatches(base("서리 메모"), "ㅅㄹ")).toBe(true);
  expect(noteMatches(base("가락국수"), "갈")).toBe(true);
  expect(noteMatches(base("Blue Archive"), "bluearchive")).toBe(true);
  expect(noteMatches(secret, "ㅇㅎ")).toBe(true);
});

it("secret notes: PIN unlock, masked values with 보기, lock on demand and after idle", async () => {
  const fake = backend([base("서버 계정", { type: "secret", fields: [{ id: "f", label: "비밀번호", value: "hunter2", order: "V" }], memo: "" })]);
  const store = new NotesStore(fake.request); surface(store);
  const item = await screen.findByRole("button", { name: /서버 계정/ });
  expect(within(item).getByLabelText("암호 메모")).toBeInTheDocument();
  expect(item).not.toHaveTextContent("hunter2");
  await userEvent.click(item);
  const pin = await screen.findByLabelText("PIN");
  await userEvent.type(pin, "1111");
  await userEvent.click(screen.getByRole("button", { name: "열기" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("PIN이 맞지 않습니다.");
  await userEvent.type(screen.getByLabelText("PIN"), "2468");
  await userEvent.click(screen.getByRole("button", { name: "열기" }));
  const value = await screen.findByLabelText("비밀번호 값");
  expect(value).toHaveAttribute("type", "password");
  expect(value).toHaveValue("hunter2");
  await userEvent.click(screen.getByRole("button", { name: "값 보기" }));
  expect(value).toHaveAttribute("type", "text");
  await userEvent.click(screen.getByRole("button", { name: "지금 잠그기" }));
  await waitFor(() => expect(store.snapshot().notes[0]!.redacted).toBe(true));
  expect(store.snapshot().notes[0]!.fields).toBeUndefined();
  expect(fake.calls.some((c) => c.op === "secretLock")).toBe(true);
  // Re-open, then stay idle: the note locks again by itself.
  await userEvent.type(await screen.findByLabelText("PIN"), "2468");
  await userEvent.click(screen.getByRole("button", { name: "열기" }));
  await screen.findByLabelText("비밀번호 값");
  vi.useFakeTimers();
  fireEvent.keyDown(window, { key: "Shift" }); // activity re-arms the idle timer
  await act(async () => { await vi.advanceTimersByTimeAsync(SECRET_IDLE_MS - 1000); });
  expect(store.snapshot().notes[0]!.redacted).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(store.snapshot().notes[0]!.redacted).toBe(true);
});

it("asks to unlock a locked keyring once when Notes opens", async () => {
  const fake = backend([base("메모")], { keyringLocked: true });
  const store = new NotesStore(fake.request); surface(store);
  expect(await within(await screen.findByLabelText("메모 목록")).findByRole("button", { name: /^메모/ })).toBeInTheDocument();
  expect(fake.calls.filter((c) => c.op === "unlockKeyring")).toHaveLength(1);
});

it("the convert button turns a text note into a checklist and back, and the colour button shows the colour", async () => {
  const fake = backend([base("할 일", { body: "- [ ] 우유\n- [x] 빵\n달걀", color: "blue" })]);
  const store = new NotesStore(fake.request); surface(store);
  await userEvent.click(await screen.findByRole("button", { name: /할 일/ }));
  const dot = screen.getByRole("button", { name: "메모 색상" }).querySelector(".notes-color-dot") as HTMLElement;
  expect(dot.style.background).not.toBe("");
  const toChecklist = screen.getByRole("button", { name: "체크리스트로 바꾸기" });
  expect(toChecklist).toHaveAttribute("title", expect.stringContaining("체크리스트로 바꾸기"));
  await userEvent.click(toChecklist);
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ type: "checklist", items: [
    expect.objectContaining({ text: "우유", checked: false }), expect.objectContaining({ text: "빵", checked: true }), expect.objectContaining({ text: "달걀", checked: false }),
  ] });
  expect(screen.getByRole("list", { name: "할 일" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "메모로 바꾸기" }));
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ type: "text", body: "- [ ] 우유\n- [ ] 달걀\n- [x] 빵" });
  // Sync is an icon button at the bottom; the old footer texts are gone.
  expect(screen.getByRole("button", { name: "동기화" })).toBeInTheDocument();
  expect(screen.queryByText(/자동 저장/)).not.toBeInTheDocument();
  expect(screen.queryByText(/암호화된 메모/)).not.toBeInTheDocument();
});
