import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { BackNavigationProvider } from "../shared/navigation/BackNavigation";
import { SearchSurface } from "./SearchSurface";
import { ViewToolbar } from "./ViewToolbar";
import { WorkspaceChromeProvider } from "./WorkspaceChrome";
import { WorkspaceNavigation } from "./WorkspaceNavigation";

afterEach(cleanup);
it("returns from collection detail to the last collection list when its rail button is clicked", async () => {
  const onNavigate = vi.fn();
  const props = { collectionType: "av" as const, width: 208, onWidthChange: vi.fn(), onNavigate,
    assetNavigation: null, reviewCount: 0, trashCount: 0 };
  const list = { kind: "collections" as const, typeFilter: "av" as const, showcase: true };
  const { rerender } = render(<WorkspaceNavigation {...props} view={list} />);
  rerender(<WorkspaceNavigation {...props} view={{ kind: "collection", collectionId: "av-1" }} />);
  await userEvent.click(screen.getByRole("button", { name: "컬렉션" }));
  expect(onNavigate).toHaveBeenCalledWith(list);
});

it("offers a collection list when detail was opened without a remembered list", async () => {
  const onNavigate = vi.fn();
  render(<WorkspaceNavigation view={{kind:"collection",collectionId:"missing"}} collectionType="av" width={208} onWidthChange={vi.fn()} onNavigate={onNavigate} assetNavigation={null} reviewCount={0} trashCount={0}/>);
  await userEvent.click(screen.getByRole("button", { name: "컬렉션" }));
  expect(onNavigate).toHaveBeenCalledWith({ kind: "collections", typeFilter: "av", showcase: false });
});

const baseProps = { collectionType: "game" as const, width: 208, onWidthChange: vi.fn(), assetNavigation: null, reviewCount: 0, trashCount: 0 };
const assetsView = { kind: "classification" as const, classificationId: null };

it("keeps 에셋, 컬렉션, 망가, 메모 and 전송 in the rail, 비밀 while its USB is attached, then 찾기 and 더보기", async () => {
  const onNavigate = vi.fn();
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={onNavigate} privateVaultAvailable />);
  const rail = screen.getByRole("navigation", { name: "주요 영역" });
  expect(within(rail).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent))
    .toEqual(["에셋", "컬렉션", "망가", "메모", "전송", "비밀", "찾기", "더보기"]);
  expect(within(rail).getByRole("button", { name: "찾기" })).toHaveAttribute("aria-keyshortcuts", "Control+K Control+F");
  expect(screen.queryByRole("button", { name: "작가" })).not.toBeInTheDocument();
  await userEvent.click(within(rail).getByRole("button", { name: "메모" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "notes" });
  await userEvent.click(within(rail).getByRole("button", { name: "전송" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "exchange" });
  await userEvent.click(within(rail).getByRole("button", { name: "비밀" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "private_vault" });
});

it("shows the 더보기 count only for 유사 검토, never for 미분류", () => {
  const { rerender } = render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} />);
  const more = screen.getByRole("button", { name: "더보기" });
  expect(more.querySelector(".workspace-rail__count")).toBeNull();
  rerender(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} reviewCount={0} unsortedCount={5000} />);
  expect(screen.getByRole("button", { name: "더보기" }).querySelector(".workspace-rail__count")).toBeNull();
  rerender(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} reviewCount={12} unsortedCount={30} />);
  const counted = screen.getByRole("button", { name: "더보기 · 유사 검토 12개" });
  expect(counted.querySelector(".workspace-rail__count")).toHaveTextContent("12");
  expect(counted.querySelector(".workspace-rail__icon svg")).not.toBeNull();
});

it("marks 에셋 current in the 작가 quick view, 메모 on notes and 더보기 on its destinations", () => {
  const { rerender } = render(<WorkspaceNavigation {...baseProps} view={{ kind: "artists" }} onNavigate={vi.fn()} />);
  expect(screen.getByRole("button", { name: "에셋" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "더보기" })).not.toHaveAttribute("aria-current");
  rerender(<WorkspaceNavigation {...baseProps} view={{ kind: "notes" }} onNavigate={vi.fn()} />);
  expect(screen.getByRole("button", { name: "메모" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "더보기" })).not.toHaveAttribute("aria-current");
  expect(screen.getByRole("button", { name: "에셋" })).not.toHaveAttribute("aria-current");
  rerender(<WorkspaceNavigation {...baseProps} view={{ kind: "trash" }} onNavigate={vi.fn()} />);
  expect(screen.getByRole("button", { name: "더보기" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "메모" })).not.toHaveAttribute("aria-current");
});

it("keeps status out of the rail and shows no search placeholder where search is unsupported", () => {
  render(<WorkspaceNavigation {...baseProps} view={{ kind: "statistics" }} onNavigate={vi.fn()} reviewCount={4} />);
  const rail = screen.getByRole("navigation", { name: "주요 영역" });
  expect(within(rail).queryByRole("button", { name: /동기화 문제/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "검색 미지원" })).not.toBeInTheDocument();
  expect(document.querySelector(".workspace-index__head")).toHaveTextContent("더보기");
});

it("reaches every former rail and 관리 destination from 더보기 with focus return", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  const onQueuesRequested = vi.fn();
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={onNavigate} reviewCount={2} trashCount={3}
    unsortedCount={0} onQueuesRequested={onQueuesRequested} privateVaultAvailable />);

  const trigger = screen.getByRole("button", { name: "더보기 · 유사 검토 2개" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(onQueuesRequested).toHaveBeenCalled();
  const panel = screen.getByRole("dialog", { name: "더보기" });
  expect(panel).not.toHaveTextContent("진행 중인 작업");
  const queues = within(panel).getByRole("navigation", { name: "확인할 것" });
  expect(within(queues).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["유사 검토 2개"]);
  const destinations = within(panel).getByRole("navigation", { name: "이동" });
  expect(within(destinations).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent))
    .toEqual(["미분류", "작가", "통계", "휴지통 3개", "설정"]);

  const expected: [string, unknown][] = [["미분류", { kind: "unsorted" }],
    ["작가", { kind: "artists" }], ["통계", { kind: "statistics" }], ["휴지통 3개", { kind: "trash" }], ["설정", { kind: "settings" }], ["유사 검토 2개", { kind: "similarity_review" }]];
  for (const [name, view] of expected) {
    if (!screen.queryByRole("dialog", { name: "더보기" })) await user.click(trigger);
    await user.click(within(screen.getByRole("dialog", { name: "더보기" })).getByRole("button", { name }));
    expect(onNavigate).toHaveBeenLastCalledWith(view);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  }
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("opens the 찾기 palette with Ctrl+K, filters by name and navigates with Enter", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={onNavigate} reviewCount={5} trashCount={1} />);
  const focusBefore = screen.getByRole("button", { name: "에셋" });
  focusBefore.focus();

  await user.keyboard("{Control>}k{/Control}");
  const palette = screen.getByRole("dialog", { name: "찾기" });
  const field = within(palette).getByRole("combobox", { name: "이동할 곳 또는 명령 이름" });
  expect(field).toHaveFocus();
  const groups = within(palette).getAllByRole("group").map((group) => group.getAttribute("aria-labelledby") && document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent);
  expect(groups[0]).toBe("확인할 것");
  expect(within(palette).getAllByRole("option")[0]).toHaveAccessibleName("유사 검토 5개");
  expect(within(palette).queryByRole("option", { name: /설정 · 클라우드/ })).not.toBeInTheDocument();
  expect(within(palette).getByRole("option", { name: "메모" })).toBeInTheDocument();

  await user.type(field, "휴지");
  expect(within(palette).getAllByRole("option").map((option) => option.getAttribute("aria-label") ?? option.textContent)).toEqual(["휴지통 1개"]);
  await user.clear(field);
  await user.type(field, "설정");
  expect(within(palette).getAllByRole("option").map((option) => option.textContent)).toEqual(["설정", "설정 · 일반", "설정 · 라이브러리", "설정 · 클라우드", "설정 · 온라인 카탈로그", "설정 · 연결", "설정 · 데이터 관리", "설정 · 정보·도움말", "설정 · 고급"]);
  await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
  expect(within(palette).getByRole("option", { name: "설정 · 클라우드" })).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Enter}");
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "settings", section: "cloud" });
  expect(screen.queryByRole("dialog", { name: "찾기" })).not.toBeInTheDocument();
  expect(focusBefore).toHaveFocus();
});

it("never offers asset text search in the palette", async () => {
  const user = userEvent.setup();
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "찾기" }));
  await user.type(screen.getByRole("combobox"), "sunset");
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(screen.getByText("일치하는 이름이 없습니다.")).toBeVisible();
  expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "이동할 곳이나 명령 이름");
  expect(screen.getByText("이 화면은 검색이 없어 이름으로 이동만 합니다")).toBeInTheDocument();
});

it("closes the palette with Escape and returns focus to the rail button", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={onNavigate} privateVaultAvailable />);
  const trigger = screen.getByRole("button", { name: "찾기" });
  await user.click(trigger);
  await user.type(screen.getByRole("combobox"), "비밀");
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["비밀"]);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "찾기" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(onNavigate).not.toHaveBeenCalled();
});

it("ignores Ctrl+K while typing in a text field", async () => {
  const user = userEvent.setup();
  render(<><input aria-label="다른 입력" /><WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} /></>);
  await user.click(screen.getByRole("textbox", { name: "다른 입력" }));
  await user.keyboard("{Control>}k{/Control}");
  expect(screen.queryByRole("dialog", { name: "찾기" })).not.toBeInTheDocument();
  await user.keyboard("{Meta>}k{/Meta}");
  expect(screen.queryByRole("dialog", { name: "찾기" })).not.toBeInTheDocument();
});

it("does not open the palette over a modal dialog but does over a non-modal panel", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<><div role="dialog" aria-label="표지 감상" /><WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} /></>);
  await user.keyboard("{Control>}k{/Control}");
  expect(screen.queryByRole("dialog", { name: "찾기" })).not.toBeInTheDocument();
  rerender(<><div role="dialog" aria-modal="true" aria-label="FAULT" /><WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} /></>);
  await user.keyboard("{Control>}k{/Control}");
  expect(screen.queryByRole("dialog", { name: "찾기" })).not.toBeInTheDocument();
  rerender(<><div role="dialog" aria-modal="false" aria-label="상태" /><WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} /></>);
  await user.keyboard("{Control>}k{/Control}");
  expect(screen.getByRole("dialog", { name: "찾기" })).toBeInTheDocument();
});

it("keeps the highlighted entry when a queue count arrives and moves it between groups", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} unsortedCount={null} />);
  await user.click(screen.getByRole("button", { name: "찾기" }));
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(screen.getByRole("option", { name: "메모" })).toHaveAttribute("aria-selected", "true");
  rerender(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} unsortedCount={30} />);
  expect(screen.getAllByRole("option")[0]).toHaveAccessibleName("미분류 30개");
  expect(screen.getByRole("option", { name: "메모" })).toHaveAttribute("aria-selected", "true");
});

it("ignores Enter and Escape that confirm an IME composition", async () => {
  const onNavigate = vi.fn();
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={onNavigate} />);
  await userEvent.click(screen.getByRole("button", { name: "찾기" }));
  const field = screen.getByRole("combobox");
  fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(field, { key: "Escape", keyCode: 229 });
  expect(onNavigate).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "찾기" })).toBeInTheDocument();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onNavigate).toHaveBeenCalledTimes(1);
});

it("returns focus to the 찾기 button when the opener is gone", async () => {
  const user = userEvent.setup();
  const tree = (temporary: boolean) => <>{temporary && <button type="button">임시</button>}<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} /></>;
  const { rerender } = render(tree(true));
  screen.getByRole("button", { name: "임시" }).focus();
  await user.keyboard("{Control>}k{/Control}");
  expect(screen.getByRole("dialog", { name: "찾기" })).toBeInTheDocument();
  rerender(tree(false));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "찾기" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "찾기" })).toHaveFocus();
});

it("does not reopen or stack the palette with Ctrl+F while it is open", async () => {
  const user = userEvent.setup();
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} />);
  await user.keyboard("{Control>}k{/Control}");
  const field = screen.getByRole("combobox");
  await user.type(field, "휴지");
  await user.keyboard("{Control>}f{/Control}");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(field).toHaveValue("휴지");
});

function SearchableView({ initial = "", onApply }: { initial?: string; onApply?: (query: string) => void }) {
  const [query, setQuery] = useState(initial);
  return <ViewToolbar title="컬렉션" chrome={{ search: { scope: "게임 컬렉션", label: "제목 검색", query, onApply: (next) => { onApply?.(next); setQuery(next); } } }} />;
}

function renderWithView(view: ReactNode) {
  return render(<BackNavigationProvider><WorkspaceChromeProvider scope="test">
    <WorkspaceNavigation {...baseProps} view={{ kind: "collections", typeFilter: "game", showcase: false }} onNavigate={vi.fn()} />
    {view}
  </WorkspaceChromeProvider></BackNavigationProvider>);
}

it("puts the view's search first while typing and applies it with Enter", async () => {
  const user = userEvent.setup();
  const onApply = vi.fn();
  renderWithView(<SearchableView onApply={onApply} />);
  expect(screen.queryByRole("button", { name: "제목 검색" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "찾기" }));
  const field = screen.getByRole("combobox", { name: "게임 컬렉션 검색어 또는 이동할 곳 이름" });
  expect(field).toHaveAttribute("placeholder", "검색하거나 이동할 곳 이름");
  expect(screen.queryByRole("option", { name: /에서 검색/ })).not.toBeInTheDocument();
  await user.type(field, "설정");
  const options = screen.getAllByRole("option");
  expect(options[0]).toHaveTextContent("‘설정’ — 게임 컬렉션에서 검색");
  expect(options[0]).toHaveAttribute("aria-selected", "true");
  expect(options[1]).toHaveTextContent("설정");
  await user.keyboard("{Enter}");
  expect(onApply).toHaveBeenLastCalledWith("설정");
  expect(screen.queryByRole("dialog", { name: "찾기" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "찾기" })).toHaveFocus();
  // The active query stays visible with its own clear button.
  expect(screen.getByRole("button", { name: "검색 해제" })).toBeInTheDocument();
});

it("opens the palette with Ctrl+F, also from a text field, and offers 검색 해제 for an active query", async () => {
  const user = userEvent.setup();
  const onApply = vi.fn();
  renderWithView(<><input aria-label="다른 입력" /><SearchableView initial="nier" onApply={onApply} /></>);
  await user.click(screen.getByRole("textbox", { name: "다른 입력" }));
  await user.keyboard("{Control>}f{/Control}");
  const palette = screen.getByRole("dialog", { name: "찾기" });
  const first = within(palette).getAllByRole("option")[0];
  expect(first).toHaveTextContent("검색 해제");
  expect(first).toHaveTextContent("‘nier’");
  await user.keyboard("{Enter}");
  expect(onApply).toHaveBeenLastCalledWith("");
  expect(screen.queryByRole("button", { name: "검색 해제" })).not.toBeInTheDocument();
});

it("opens a view's own search editor from the palette with the typed draft", async () => {
  const user = userEvent.setup();
  function SurfaceView() {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState("");
    return <ViewToolbar title="망가" chrome={{ searchSurface: {
      scope: "온라인 카탈로그", label: "온라인 만화 검색", query: "", onApply: vi.fn(),
      open: (text) => { setDraft(text); setOpen(true); },
      content: <SearchSurface label="온라인 만화 검색" scope="온라인 카탈로그" active={false} open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}>
        <input autoFocus aria-label="온라인 검색어" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </SearchSurface>,
    } }} />;
  }
  render(<BackNavigationProvider><WorkspaceChromeProvider scope="test">
    <WorkspaceNavigation {...baseProps} view={{ kind: "manga" }} onNavigate={vi.fn()} />
    <SurfaceView />
  </WorkspaceChromeProvider></BackNavigationProvider>);
  // The online catalog keeps its own trigger in the index head.
  expect(screen.getByRole("button", { name: "온라인 만화 검색" })).toBeInTheDocument();
  await user.keyboard("{Control>}f{/Control}");
  expect(screen.getAllByRole("option")[0]).toHaveTextContent("온라인 카탈로그 검색 열기");
  await user.type(screen.getByRole("combobox"), "태그");
  expect(screen.getAllByRole("option")[0]).toHaveTextContent("온라인 카탈로그 검색 열기");
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("dialog", { name: "온라인 카탈로그에서 검색" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "찾기" })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "온라인 검색어" })).toHaveFocus());
  expect(screen.getByRole("textbox", { name: "온라인 검색어" })).toHaveValue("태그");
});

it("finds folders, albums and characters by name with their path and opens them", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  const places = {
    classifications: [
      { id: "game", kind: "root" as const, name: "게임", parentId: null, iconKey: null, colorKey: null },
      { id: "zzz", kind: "tag" as const, name: "젠레스", parentId: "game", iconKey: null, colorKey: null },
      { id: "zzz-art", kind: "tag" as const, name: "젠레스 팬아트", parentId: "zzz", iconKey: null, colorKey: null },
    ],
    albums: [{ id: "album", name: "젠레스 표지", parentId: null, iconKey: null, colorKey: null }],
    characters: [{ id: "ellen", displayName: "엘렌", seriesClassificationId: "zzz" }],
  };
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={onNavigate} places={places} />);
  await user.click(screen.getByRole("button", { name: "찾기" }));
  const palette = screen.getByRole("dialog", { name: "찾기" });
  expect(within(palette).queryByRole("option", { name: /젠레스/ })).not.toBeInTheDocument();
  const field = within(palette).getByRole("combobox");
  await user.type(field, "젠레스");
  expect(within(palette).getAllByRole("option").map((option) => option.getAttribute("aria-label"))).toEqual([
    "젠레스 · 게임", "젠레스 표지 · 앨범", "젠레스 팬아트 · 게임 › 젠레스",
  ]);
  await user.keyboard("{Enter}");
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "classification", classificationId: "zzz" });
  await user.click(screen.getByRole("button", { name: "찾기" }));
  await user.type(screen.getByRole("combobox"), "엘렌");
  await user.click(screen.getByRole("option", { name: "엘렌 · 게임 › 젠레스" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "classification", classificationId: "zzz", characterId: "ellen" });
});

it("shows a grouped character's group in its palette path", async () => {
  const user = userEvent.setup();
  const onNavigate = vi.fn();
  const places = {
    classifications: [
      { id: "game", kind: "root" as const, name: "게임", parentId: null, iconKey: null, colorKey: null },
      { id: "zzz", kind: "tag" as const, name: "젠레스", parentId: "game", iconKey: null, colorKey: null },
    ],
    albums: [],
    characters: [{ id: "miyabi", displayName: "미야비", seriesClassificationId: "zzz" }],
    characterGroups: [{ id: "aod", name: "AOD", seriesId: "zzz", targetIds: ["miyabi"] }],
  };
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={onNavigate} places={places} />);
  await user.click(screen.getByRole("button", { name: "찾기" }));
  await user.type(screen.getByRole("combobox"), "미야비");
  await user.click(screen.getByRole("option", { name: "미야비 · 게임 › 젠레스 › AOD" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "classification", classificationId: "zzz", characterId: "miyabi" });
});

it("lists at most eight name matches, above other destinations", async () => {
  const user = userEvent.setup();
  const classifications = Array.from({ length: 12 }, (_, index) => ({ id: `f${index}`, kind: "root" as const, name: `설정 폴더 ${index}`, parentId: null, iconKey: null, colorKey: null }));
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} places={{ classifications, albums: [] }} />);
  await user.click(screen.getByRole("button", { name: "찾기" }));
  await user.type(screen.getByRole("combobox"), "설정");
  const options = screen.getAllByRole("option");
  expect(options.slice(0, 8).every((option) => option.textContent?.startsWith("설정 폴더"))).toBe(true);
  expect(options[8]).toHaveTextContent(/^설정$/);
});

it("hides 비밀 from the rail while no vault USB is attached", () => {
  render(<WorkspaceNavigation {...baseProps} view={assetsView} onNavigate={vi.fn()} />);
  const rail = screen.getByRole("navigation", { name: "주요 영역" });
  expect(within(rail).queryByRole("button", { name: "비밀" })).not.toBeInTheDocument();
  expect(within(rail).getByRole("button", { name: "전송" })).toBeInTheDocument();
});
