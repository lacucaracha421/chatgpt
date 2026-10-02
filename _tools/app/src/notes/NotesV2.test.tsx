import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceChromeProvider, ChromeTarget } from "../layout/WorkspaceChrome";
import { NotesWorkspace, SECRET_IDLE_MS } from "./NotesView";
import { caretOffsetAtPoint } from "./model";
import { NotesStore, type Note, type NotesRequest } from "./store";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

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

it("opens mixed notes as plain rows without Markdown, then rewrites only the toggled task after switching mode", async () => {
  const fake = backend([base("할 일", { body: "# 오늘\n- [ ] 우유\n- [ ] 빵\n\n설명" })]);
  const store = new NotesStore(fake.request); surface(store);
  await userEvent.click(await screen.findByRole("button", { name: /할 일/ }));
  expect(screen.getByRole("heading", { name: "오늘" })).toBeInTheDocument();
  expect(screen.getAllByRole("textbox", { name: "메모 본문" }).map(area=>(area as HTMLTextAreaElement).value)).toEqual(["우유","빵","","설명"]);
  expect(fake.saves()).toHaveLength(0);
  expect(screen.queryByRole("button", {name:"마크다운 도움말"})).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio",{name:"할 일"}));
  await userEvent.click(screen.getAllByRole("button",{name:"완료"})[1]!);
  await settle(store);
  expect(last(fake.saves())).toMatchObject({body:"# 오늘\n- [ ] 우유\n- [x] 빵\n- [ ] 설명",type:"text"});
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", {name:"메모 본문"})).not.toBeInTheDocument();
});

it("edits one section without touching its neighbors and resets section chips on reopen", async () => {
  const fake=backend([base("sections",{body:"# 첫째\n첫 본문\n## 둘째\n둘째 본문\n## 셋째\n셋째 본문"})]);
  const store=new NotesStore(fake.request);surface(store);
  await userEvent.click(await screen.findByRole("button",{name:/sections/}));
  const areas=screen.getAllByRole("textbox",{name:"메모 본문"});
  fireEvent.change(areas[0]!,{target:{value:"첫 변경"}});await settle(store);
  expect(last(fake.saves())).toMatchObject({body:"# 첫째\n첫 변경\n## 둘째\n둘째 본문\n## 셋째\n셋째 본문"});
  await userEvent.click(screen.getByRole("button",{name:"둘째"}));
  expect(screen.getAllByRole("textbox",{name:"메모 본문"})).toHaveLength(1);
  expect(screen.getByRole("textbox",{name:"메모 본문"})).toHaveValue("둘째 본문");
  await userEvent.click(screen.getByRole("button",{name:"메모 닫기"}));
  await userEvent.click(await screen.findByRole("button",{name:/sections/}));
  expect(screen.getAllByRole("textbox",{name:"메모 본문"})).toHaveLength(3);
  expect(localStorage.getItem("lakomics.notes.sectionFolds.v1")).toBeNull();
});

it("filters kinds in the top chips and scopes and labels in the 보기 menu", async () => {
  const fake = backend([
    base("memo", { title: "메모", body: "일반", labels: ["업무"] }),
    base("todo", { title: "체크", type: "checklist", items: [] }),
    base("budget", { title: "가계부", type: "ledger", pinned: true, income: null, recurring: [], planned: [] }),
    base("secret", { title: "암호", type: "secret", fields: [], memo: "" }),
    base("archived", { title: "보관", body: "오래된 메모", archived: true }),
  ]);
  const store = new NotesStore(fake.request); surface(store);
  const list = () => within(screen.getByLabelText("메모 목록"));
  expect(await screen.findByRole("radio", { name: "가계부" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "암호" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "메모" }));
  expect(list().getByRole("button", { name: /체크/ })).toBeInTheDocument();
  expect(list().getByRole("button", { name: /메모 일반/ })).toBeInTheDocument();
  expect(list().queryByRole("button", {name:/가계부/})).not.toBeInTheDocument();
  expect(screen.queryByRole("radio",{name:"체크리스트"})).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "전체" }));
  await userEvent.click(screen.getByRole("button", { name: /보기/ }));
  expect(await screen.findByRole("menuitem", { name: /보관함/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("menuitem", { name: /보관함/ }));
  expect(list().getByRole("button", { name: /보관/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /보기/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: /모든 메모/ }));
  await userEvent.click(screen.getByRole("button", { name: /보기/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: "업무" }));
  expect(list().getByRole("button", { name: /메모/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /라벨: 업무/ }));
  await userEvent.click(screen.getByRole("menuitem", { name: "라벨 해제" }));
});

it("opens with the caret at the last row end and preserves point-to-caret helper coverage", async () => {
  const fake=backend([base("note",{body:"첫 줄\n\n아래 줄의 본문"})]);
  const store=new NotesStore(fake.request);surface(store);
  const original=(document as Document & {caretPositionFromPoint?:unknown}).caretPositionFromPoint;
  Object.defineProperty(document,"caretPositionFromPoint",{configurable:true,value:()=>{
    const mirror=[...document.body.children].find(element=>(element as HTMLElement).style.position==="fixed"&&(element as HTMLElement).style.visibility==="hidden");
    return mirror?.firstChild?{offsetNode:mirror.firstChild,offset:3}:null;
  }});
  try{
    await userEvent.click(await screen.findByRole("button",{name:/note/}));
    const area=screen.getAllByRole("textbox",{name:"메모 본문"})[2] as HTMLTextAreaElement;
    expect(area).toHaveFocus();expect(area.selectionStart).toBe(area.value.length);
    expect(caretOffsetAtPoint(area,120,200)).toBe(3);
  }finally{Object.defineProperty(document,"caretPositionFromPoint",{configurable:true,value:original});}
});

it('undoes a section drag separately from typing, restores exact body order and redoes the move', async () => {
  const original = 'top\r\n## A\r\na\r\n## B\r\nb';
  const fake = backend([base('note', { title: 'Reorder', body: original })]);
  surface(new NotesStore(fake.request));
  await userEvent.click(await screen.findByRole('button', { name: /Reorder/ }));
  const area = screen.getAllByRole('textbox', { name: '메모 본문' })[1]!;
  fireEvent.change(area, { target: { value: 'edited' } });
  const sections = [...document.querySelectorAll<HTMLElement>('[data-memo-section]')];
  sections.forEach((section, index) => vi.spyOn(section, 'getBoundingClientRect').mockReturnValue({ top: index * 120, height: 100 } as DOMRect));
  const head = sections[0]!.querySelector('.memo-section-head')!;
  const mouse = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10 };
  fireEvent.pointerDown(head, mouse); fireEvent.pointerMove(window, { ...mouse, clientY: 170 }); fireEvent.pointerUp(window, { ...mouse, clientY: 170 });
  const titles = () => [...document.querySelectorAll('.memo-section-head h2')].map(head => head.textContent);
  expect(titles()).toEqual(['B', 'A']);
  await userEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(titles()).toEqual(['A', 'B']);
  expect(screen.getAllByRole('textbox', { name: '메모 본문' }).map(field => (field as HTMLTextAreaElement).value)).toEqual(['top', 'edited', 'b']);
  await userEvent.click(screen.getByRole('button', { name: '되돌리기' }));
  expect(screen.getAllByRole('textbox', { name: '메모 본문' }).map(field => (field as HTMLTextAreaElement).value)).toEqual(['top', 'a', 'b']);
  fireEvent.keyDown(area, { key: 'z', ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(area, { key: 'z', ctrlKey: true, shiftKey: true });
  expect(titles()).toEqual(['B', 'A']);
});

it("undoes and redoes title and body edits per open note", async () => {
  const fake = backend([base("note", { title: "원래 제목", body: "원래 본문" }), base("other", { body: "다른 본문" })]);
  const store = new NotesStore(fake.request); surface(store);
  await userEvent.click(await screen.findByRole("button", { name: /원래 제목/ }));
  const title = screen.getByRole("textbox", { name: "메모 제목" });
  fireEvent.change(title, { target: { value: "새 제목" } });
  const body = await screen.findByRole("textbox", { name: "메모 본문" });
  fireEvent.change(body, { target: { value: "새 본문" } });
  expect(screen.getByRole("button", { name: "되돌리기" })).toBeEnabled();
  fireEvent.keyDown(body, { key: "z", ctrlKey: true });
  expect(body).toHaveValue("원래 본문");
  fireEvent.keyDown(body, { key: "z", ctrlKey: true, shiftKey: true });
  expect(body).toHaveValue("새 본문");
  await userEvent.click(title);
  fireEvent.change(title, { target: { value: "두 번째 제목" } });
  await userEvent.click(screen.getByRole("button", { name: "되돌리기" }));
  expect(title).toHaveValue("새 제목");
  await userEvent.click(screen.getByRole("button", { name: "메모 닫기" }));
  await userEvent.click(screen.getByRole("button", { name: /다른/ }));
  expect(screen.getByRole("button", { name: "되돌리기" })).toBeDisabled();
});

it("creates text memos in todo mode, adds with Enter and folds completed rows", async () => {
  const fake=backend([]);const store=new NotesStore(fake.request);surface(store);
  await userEvent.click(await screen.findByRole("button",{name:"새 메모"}));
  expect(screen.queryByRole("menuitem",{name:"체크리스트"})).not.toBeInTheDocument();
  await userEvent.click(await screen.findByRole("menuitem",{name:"메모"}));
  await userEvent.click(screen.getByRole("radio",{name:"할 일"}));
  await userEvent.click(screen.getByRole("textbox",{name:"메모 본문"}));
  await userEvent.keyboard("우유{Enter}빵{Enter}달걀");await settle(store);
  expect(last(fake.saves())).toMatchObject({type:"text",body:"- [ ] 우유\n- [ ] 빵\n- [ ] 달걀"});
  await userEvent.click(screen.getAllByRole("button",{name:"완료"})[0]!);await settle(store);
  expect(screen.getAllByRole("textbox",{name:"메모 본문"}).map(area=>(area as HTMLTextAreaElement).value)).toEqual(["빵","달걀"]);
  await userEvent.click(screen.getByRole("button",{name:/완료 1/}));
  expect(screen.getAllByRole("textbox",{name:"메모 본문"}).map(area=>(area as HTMLTextAreaElement).value)).toEqual(["빵","달걀","우유"]);
  expect(last(fake.saves())).toMatchObject({type:"text",body:"- [x] 우유\n- [ ] 빵\n- [ ] 달걀"});
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
  await userEvent.click(screen.getByRole("button", { name: "메모 닫기" }));
  // The view menu filters by label.
  await userEvent.click(screen.getByRole("button", { name: /보기/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "업무" }));
  const list = () => within(screen.getByLabelText("메모 목록"));
  expect(list().getAllByRole("button").map((b) => b.textContent)).toEqual([expect.stringContaining("회의")]);
  // Search: secret notes match by title only (their values stay hidden).
  await userEvent.click(screen.getByRole("button", { name: /보기/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "모든 메모" }));
  expect(list().getAllByRole("button")).toHaveLength(3);
  expect(list().getByRole("button", { name: /계정/ })).toHaveTextContent("암호 메모");
  // Archive leaves the main list and shows up under 보관함.
  await userEvent.click(list().getByRole("button", { name: /회의/ }));
  // Archive lives in the ⋯ menu next to 휴지통.
  expect(screen.queryByRole("button", { name: "보관" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "메모 더보기" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "보관함으로 보내기" }));
  await settle(store);
  await userEvent.click(screen.getByRole("button", { name: "메모 닫기" }));
  expect(list().queryByRole("button", { name: /회의/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /보기/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "보관함" }));
  expect(list().getByRole("button", { name: /회의/ })).toBeInTheDocument();
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

it("hides a note's content on the board from the 더보기 menu and shows it again", async () => {
  const fake = backend([base("API", { body: "sk-secret-value" })]);
  const store = new NotesStore(fake.request); surface(store);
  await userEvent.click(await screen.findByRole("button", { name: /API/ }));
  await userEvent.click(screen.getAllByRole("button", { name: "메모 더보기" })[0]!);
  await userEvent.click(await screen.findByRole("menuitem", { name: "목록에서 내용 숨기기" }));
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ id: "API", concealed: true });
  await userEvent.click(screen.getByRole("button", { name: "메모 닫기" }));
  await waitFor(() => expect(document.querySelector('[data-note-id="API"]')).toHaveTextContent("숨긴 메모 · 열어서 보기"));
  expect(document.querySelector('[data-note-id="API"]')).not.toHaveTextContent("sk-secret-value");
  await userEvent.click(screen.getByRole("button", { name: /API/ }));
  await userEvent.click(screen.getByRole("button", { name: "메모 더보기" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "목록에서 내용 보이기" }));
  await settle(store);
  expect(last(fake.saves())).toMatchObject({ id: "API", concealed: false });
});

it("switches memo modes with body undo and keeps colour and sync controls", async () => {
  const fake=backend([base("할 일",{body:"- [ ] 우유\n- [x] 빵\n달걀",color:"blue"})]);
  const store=new NotesStore(fake.request);surface(store);
  await userEvent.click(await screen.findByRole("button",{name:/할 일/}));
  const dot=screen.getByRole("button",{name:"메모 색상"}).querySelector(".notes-color-dot") as HTMLElement;expect(dot.style.background).not.toBe("");
  expect(screen.queryByRole("button",{name:"체크리스트로 바꾸기"})).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio",{name:"할 일"}));await settle(store);
  expect(last(fake.saves())).toMatchObject({type:"text",body:"- [ ] 우유\n- [x] 빵\n- [ ] 달걀"});
  await userEvent.click(screen.getByRole("radio",{name:"글"}));await settle(store);
  expect(last(fake.saves())).toMatchObject({type:"text",body:"우유\n빵\n달걀"});
  await userEvent.click(screen.getByRole("button",{name:"되돌리기"}));
  expect(store.snapshot().notes[0]!.body).toBe("- [ ] 우유\n- [x] 빵\n- [ ] 달걀");
  fireEvent.keyDown(screen.getAllByRole("textbox",{name:"메모 본문"})[0]!,{key:"y",ctrlKey:true});
  expect(store.snapshot().notes[0]!.body).toBe("우유\n빵\n달걀");
  expect(screen.getByRole("button",{name:"동기화"})).toBeInTheDocument();
});

it("opens a legacy checklist without writing and converts on its first edit",async()=>{
  const fake=backend([base("legacy",{type:"checklist",body:"fallback",items:[{id:"a",text:"open",checked:false,order:"A"},{id:"b",text:"done",checked:true,order:"B"}]})]);
  const store=new NotesStore(fake.request);surface(store);
  await userEvent.click(await screen.findByRole("button",{name:/legacy/}));
  expect(fake.saves()).toHaveLength(0);expect(screen.getByRole("radio",{name:"할 일"})).toHaveAttribute("aria-checked","true");
  fireEvent.change(screen.getByRole("textbox",{name:"메모 본문"}),{target:{value:"updated"}});await settle(store);
  expect(last(fake.saves())).toMatchObject({type:"text",body:"- [ ] updated\n- [x] done"});
  expect(last(fake.saves())).not.toHaveProperty("items");
  await userEvent.click(screen.getByRole("button",{name:"되돌리기"}));
  expect(store.snapshot().notes[0]!.body).toBe("- [ ] open\n- [x] done");
});
