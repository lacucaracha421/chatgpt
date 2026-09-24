import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BackNavigationProvider } from "../shared/navigation/BackNavigation";
import { Menu } from "../shared/ui/Menu";
import { Select } from "../shared/ui/Select";
import { ChromeSettingsDock, ChromeTarget, WorkspaceChromeProvider } from "./WorkspaceChrome";
import { ViewToolbar } from "./ViewToolbar";
import { useWorkspaceChrome } from "./WorkspaceChromeContext";

let mounts = 0;
function Gallery() {
  useEffect(() => { mounts += 1; }, []);
  const [selected, setSelected] = useState(true);
  return <div data-testid="gallery"><label><input type="checkbox" checked={selected} onChange={(event) => setSelected(event.target.checked)} />선택한 자산</label></div>;
}
function SearchProbe() {
  const chrome = useWorkspaceChrome();
  return <><output data-testid="search-info">{JSON.stringify(chrome?.meta?.search ?? null)}</output>
    <button onClick={() => chrome?.applySearch("라쿠")}>라쿠 적용</button></>;
}
function Harness({ probe = false }: { probe?: boolean }) {
  const [scope, setScope] = useState("첫 화면");
  const [sort, setSort] = useState("newest");
  const [query, setQuery] = useState("");
  const [outside, setOutside] = useState(0);
  return <BackNavigationProvider><WorkspaceChromeProvider scope={scope}>
    <aside className="workspace-index"><ChromeTarget name="navigation" /><ChromeTarget name="actions" /><ChromeTarget name="search" /><ChromeSettingsDock /></aside>
    <ViewToolbar title={scope} chrome={{ summary: sort, search: { scope, label: "제목 검색", query, onApply: setQuery }, settings: <>
      <Select label="정렬" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">최신순</option><option value="oldest">오래된순</option></Select>
      <Menu label="하위 메뉴" trigger={<>옵션</>} items={[{ id: "oldest", label: "오래된순 적용", onSelect: () => setSort("oldest") }]} />
    </> }} />
    <Gallery />
    {probe && <SearchProbe />}
    <button onClick={() => setOutside((value) => value + 1)}>바깥 동작 {outside}</button>
    <button onClick={() => setScope((value) => value === "첫 화면" ? "다른 화면" : "첫 화면")}>범위 이동</button>
  </WorkspaceChromeProvider></BackNavigationProvider>;
}
afterEach(() => { cleanup(); mounts = 0; });
describe("Chrome 03b workspace", () => {
  it("opens without remounting the gallery and preserves controlled settings and selection", async () => {
    const user = userEvent.setup(); render(<Harness />);
    const gallery = screen.getByTestId("gallery"); gallery.scrollTop = 123;
    expect(screen.queryByRole("dialog", { name: "보기 설정" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "보기 설정" }));
    const panel = await screen.findByRole("dialog", { name: "보기 설정" });
    expect(panel).toHaveAttribute("aria-modal", "false");
    await user.selectOptions(within(panel).getByLabelText("정렬"), "oldest");
    expect(within(panel).getByLabelText("정렬")).toHaveValue("oldest");
    expect(screen.getByTestId("gallery")).toBe(gallery);
    expect(gallery.scrollTop).toBe(123); expect(mounts).toBe(1);
    await user.click(screen.getByRole("button", { name: "보기 설정 닫기" }));
    expect(screen.getByRole("button", { name: "보기 설정" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "보기 설정" }));
    expect(await screen.findByLabelText("정렬")).toHaveValue("oldest");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "보기 설정" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "선택한 자산" })).toBeChecked();
  });
  it("dismisses on outside interaction without swallowing the requested action", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole("button", { name: "보기 설정" }));
    await screen.findByLabelText("정렬");
    await user.click(screen.getByRole("button", { name: "바깥 동작 0" }));
    expect(screen.getByRole("button", { name: "바깥 동작 1" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "보기 설정" })).not.toBeInTheDocument();
  });
  it("keeps nested menu interaction inside the panel and consumes Escape one layer at a time", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole("button", { name: "보기 설정" }));
    await user.click(await screen.findByRole("button", { name: "하위 메뉴" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "보기 설정" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "하위 메뉴" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "하위 메뉴" }));
    await user.click(await screen.findByRole("menuitem", { name: "오래된순 적용" }));
    expect(screen.getByRole("dialog", { name: "보기 설정" })).toBeInTheDocument();
    expect(screen.getByLabelText("정렬")).toHaveValue("oldest");
    expect(screen.getByRole("checkbox", { name: "선택한 자산" })).toBeChecked();
  });
  it("does not reopen a stale panel after navigating away and returning", async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole("button", { name: "보기 설정" }));
    await user.click(screen.getByRole("button", { name: "범위 이동" }));
    await user.click(screen.getByRole("button", { name: "범위 이동" }));
    expect(screen.queryByRole("dialog", { name: "보기 설정" })).not.toBeInTheDocument();
  });
  it("exposes a plain search to the palette through the chrome handle, without its own trigger", async () => {
    const user = userEvent.setup(); render(<Harness probe />);
    expect(screen.queryByRole("button", { name: "제목 검색" })).not.toBeInTheDocument();
    expect(screen.getByTestId("search-info")).toHaveTextContent('{"kind":"query","scope":"첫 화면","label":"제목 검색","query":""}');
    await user.click(screen.getByRole("button", { name: "라쿠 적용" }));
    expect(screen.getByTestId("search-info")).toHaveTextContent('"query":"라쿠"');
    expect(screen.getByRole("button", { name: "검색 해제" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "검색 해제" }));
    expect(screen.queryByRole("button", { name: "검색 해제" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "범위 이동" }));
    expect(screen.getByTestId("search-info")).toHaveTextContent('"scope":"다른 화면"');
  });

});
