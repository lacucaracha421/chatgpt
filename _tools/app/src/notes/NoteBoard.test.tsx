import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceChromeProvider, ChromeTarget } from "../layout/WorkspaceChrome";
import { BackNavigationProvider } from "../shared/navigation/BackNavigation";
import { NotesWorkspace } from "./NotesView";
import { boardColumns, placeCards, previewLines } from "./NoteBoard";
import { NotesStore, type Note, type NotesRequest } from "./store";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(cleanup);

const T = "2026-09-20T00:00:00Z";
const base = (id: string, change: Partial<Note> = {}): Note => ({ id, title: id, body: "", pinned: false, deleted: false, createdAt: T, updatedAt: T, localRevision: 1, pending: false, conflict: false, ...change });
const request = (notes: Note[]) => (async (op: string) => (op === "save" ? null : { unlocked: true, notes, lastSyncedAt: null })) as NotesRequest;
function surface(notes: Note[]) {
  const store = new NotesStore(request(notes));
  render(<BackNavigationProvider><WorkspaceChromeProvider scope="notes"><ChromeTarget name="navigation" /><ChromeTarget name="actions" /><ChromeTarget name="search" /><NotesWorkspace store={store} /></WorkspaceChromeProvider></BackNavigationProvider>);
  return store;
}

it("fits as many ~240px columns as the width allows and places cards row by row into the shortest column", () => {
  expect(boardColumns(0)).toEqual({ columns: 0, cardWidth: 0 });
  expect(boardColumns(200).columns).toBe(1);
  expect(boardColumns(1300)).toEqual({ columns: 5, cardWidth: (1300 - 4 * 12) / 5 });
  // Wider panes add empty room instead of stretching cards past 300px.
  expect(boardColumns(1236)).toEqual({ columns: 4, cardWidth: 300 });
  expect(boardColumns(718)).toEqual({ columns: 2, cardWidth: 300 });
  const { positions, height } = placeCards([100, 300, 120, 50, 80], 3, 200);
  // The first row keeps list order left to right; the next card goes under the shortest column.
  expect(positions.slice(0, 3).map((p) => p.left)).toEqual([0, 212, 424]);
  expect(positions[3]).toEqual({ left: 0, top: 112 });
  expect(positions[4]).toEqual({ left: 424, top: 132 });
  expect(height).toBe(300);
});

it("shows only the title of a hidden note on its card", async () => {
  surface([base("api", { title: "API", body: "sk-secret-value", concealed: true })]);
  const card = await screen.findByRole("button", { name: /API/ });
  expect(card).toHaveTextContent("숨긴 메모 · 열어서 보기");
  expect(card).not.toHaveTextContent("sk-secret-value");
});

it("keeps plain lines and literal formatting while removing heading/task markers in previews", () => {
  expect(previewLines("# 오늘\n\n\n- [ ] 우유\n**빵**\n```\ncode\n```")).toBe("오늘\n\n\n우유\n**빵**\n```\ncode\n```");
});

it("shows pinned notes first with a pin mark, and checklist, secret, label and sync-pending states on the cards", async () => {
  surface([
    base("pin", { title: "다음에 볼 작품", pinned: true, body: "7권 읽기", color: "amber", labels: ["보기"] }),
    base("shop", { title: "장보기", type: "checklist", pending: true, items: [
      { id: "a", text: "우유", checked: false, order: "1" }, { id: "b", text: "두부", checked: true, order: "2" },
      { id: "c", text: "대파", checked: false, order: "3" },
    ] }),
    base("long", { title: "긴 목록", type: "checklist", items: Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, text: `물건 ${i}`, checked: false, order: `3${i}` })) }),
    base("safe", { title: "서버 계정", type: "secret", redacted: true, body: "" }),
  ]);
  const board = await screen.findByLabelText("메모 목록");
  expect(within(board).getAllByRole("heading").map((h) => h.textContent)).toEqual(["고정됨", "최근"]);
  expect(within(board).getAllByRole("button").map((b) => b.querySelector(".notes-card__title-text")!.textContent)).toEqual(["다음에 볼 작품", "장보기", "긴 목록", "서버 계정"]);
  const pinned = within(board).getByRole("button", { name: /다음에 볼 작품/ });
  expect(within(pinned).getByLabelText("고정됨")).toBeInTheDocument();
  expect(pinned).toHaveTextContent("보기");
  expect(pinned.style.getPropertyValue("--note-tint")).not.toBe("");
  const shop = within(board).getByRole("button", { name: /장보기/ });
  expect(shop).toHaveTextContent("1/3");
  // Open items first, completed ones last and struck through.
  expect([...shop.querySelectorAll(".notes-card__check-text")].map((e) => e.textContent)).toEqual(["우유", "대파", "두부"]);
  expect(within(shop).getByText("두부").closest(".notes-card__check")).toHaveClass("is-done");
  expect(within(within(board).getByRole("button", { name: /긴 목록/ })).getByText("외 2개")).toBeInTheDocument();
  expect(within(shop).getByRole("img", { name: "동기화 대기" })).toBeInTheDocument();
  const safe = within(board).getByRole("button", { name: /서버 계정/ });
  expect(safe).toHaveTextContent("암호 메모 · PIN으로 잠김");
  expect(safe.querySelectorAll(".notes-card__secret-row")).toHaveLength(2);
});

it("replaces the board with a full editor, and closes it with the button or Esc back to the card", async () => {
  surface([base("a", { title: "첫 메모", body: "하나" }), base("b", { title: "둘째 메모", body: "둘" })]);
  const card = await screen.findByRole("button", { name: /첫 메모/ });
  await userEvent.click(card);
  expect(screen.getByRole("textbox", { name: "메모 제목" })).toHaveValue("첫 메모");
  expect(screen.queryByLabelText("메모 목록")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "메모 닫기" }));
  expect(screen.queryByRole("textbox", { name: "메모 제목" })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: /첫 메모/ })).toHaveFocus());
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("textbox", { name: "메모 제목" })).toHaveValue("첫 메모");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "메모 제목" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /둘째 메모/ }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "메모 본문" })).toHaveFocus());
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "메모 제목" })).not.toBeInTheDocument();
});
