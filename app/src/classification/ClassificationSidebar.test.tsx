import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { ClassificationEntry, LibraryGateway } from "../library/types";
import { buildClassificationTree } from "./buildTree";
import { ClassificationSidebar } from "./ClassificationSidebar";

const entries: ClassificationEntry[] = [
  { id: "root", kind: "root", name: "게임", parentId: null },
  { id: "work", kind: "work", name: "블루 아카이브", parentId: "root" },
  { id: "tag", kind: "tag", name: "아루", parentId: "work" },
];

function gateway(): LibraryGateway {
  return {
    openLibrary: vi.fn(),
    currentLibrary: vi.fn(),
    listClassifications: vi.fn(),
    createClassification: vi.fn().mockResolvedValue(entries[1]),
    renameClassification: vi.fn().mockResolvedValue(undefined),
    moveClassification: vi.fn().mockResolvedValue(undefined),
    deleteClassification: vi.fn().mockResolvedValue(undefined),
    listAssets: vi.fn(),
    setAssetFavorite: vi.fn(),
    setAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn(),
    ingestImage: vi.fn(),
  };
}

function renderSidebar(
  libraryGateway = gateway(),
  props: Partial<ComponentProps<typeof ClassificationSidebar>> = {},
) {
  const onSelect = vi.fn();
  const onChanged = vi.fn();

  function Fixture() {
    const [selectedId, setSelectedId] = useState(props.selectedId ?? null);
    return (
      <LibraryProvider gateway={libraryGateway}>
        <ClassificationSidebar
          entries={entries}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            onSelect(id);
          }}
          onChanged={onChanged}
          {...props}
        />
      </LibraryProvider>
    );
  }

  render(
    <Fixture />,
  );
  return { libraryGateway, onChanged, onSelect };
}

describe("buildClassificationTree", () => {
  it("orders roots and children alphabetically without losing their kinds", () => {
    const tree = buildClassificationTree([
      { id: "tag", kind: "tag", name: "아루", parentId: "work" },
      { id: "work", kind: "work", name: "블루 아카이브", parentId: "root" },
      { id: "root", kind: "root", name: "게임", parentId: null },
      { id: "root-2", kind: "root", name: "만화", parentId: null },
    ]);

    expect(tree.map((node) => node.entry.name)).toEqual(["게임", "만화"]);
    expect(tree[0].children[0].entry.kind).toBe("work");
    expect(tree[0].children[0].children[0].entry).toMatchObject({
      name: "아루",
      kind: "tag",
    });
  });

  it("returns disconnected entries as orphans instead of dropping them", () => {
    const tree = buildClassificationTree([
      { id: "root", kind: "root", name: "게임", parentId: null },
      { id: "lost", kind: "tag", name: "나", parentId: "missing" },
      { id: "lost-2", kind: "tag", name: "가", parentId: "missing" },
    ]);

    expect(tree).toHaveLength(1);
    expect(tree.orphans).toEqual([
      { id: "lost-2", kind: "tag", name: "가", parentId: "missing" },
      { id: "lost", kind: "tag", name: "나", parentId: "missing" },
    ]);
  });
});

describe("ClassificationSidebar", () => {
  beforeEach(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.setAttribute("open", "");
          this.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
              this.dispatchEvent(new Event("cancel", { cancelable: true }));
            }
          });
        },
      },
      close: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.removeAttribute("open");
        },
      },
    });
  });

  afterEach(cleanup);

  it("creates a work below the selected root", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    renderSidebar(fixtureGateway);

    await user.click(screen.getByRole("button", { name: "게임 선택" }));
    await user.click(screen.getByRole("button", { name: "하위 항목 추가" }));
    await user.type(screen.getByLabelText("이름"), "블루 아카이브 2");
    await user.click(screen.getByRole("button", { name: "추가" }));

    await waitFor(() =>
      expect(fixtureGateway.createClassification).toHaveBeenCalledWith({
        kind: "work",
        name: "블루 아카이브 2",
        parentId: "root",
      }),
    );
  });

  it("offers only tags when adding below a work", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "블루 아카이브 선택" }));
    await user.click(screen.getByRole("button", { name: "하위 항목 추가" }));

    expect(screen.getByText("태그")).toBeInTheDocument();
    expect(screen.queryByLabelText("종류")).not.toBeInTheDocument();
  });

  it("keeps Tab, Enter, and Escape dialog interactions accessible", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    renderSidebar(fixtureGateway);

    await user.click(screen.getByRole("button", { name: "최상위 분류 추가" }));
    const name = screen.getByLabelText("이름");
    expect(name).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "추가" })).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    await user.type(name, "영화");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(fixtureGateway.createClassification).toHaveBeenCalledWith({
        kind: "root",
        name: "영화",
        parentId: null,
      }),
    );

    const close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: close,
    });
    await user.click(screen.getByRole("button", { name: "최상위 분류 추가" }));
    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the gateway deletion error without hiding it", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    vi.mocked(fixtureGateway.deleteClassification).mockRejectedValue(
      new Error("하위 항목이나 자산이 연결된 분류 항목은 삭제할 수 없습니다"),
    );
    renderSidebar(fixtureGateway, { selectedId: "tag" });

    await user.click(screen.getByRole("button", { name: "삭제" }));
    await user.click(screen.getByRole("button", { name: "삭제 확인" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "하위 항목이나 자산이 연결된 분류 항목은 삭제할 수 없습니다",
    );
  });

  it("clears a deletion error after a successful retry", async () => {
    const user = userEvent.setup();
    const fixtureGateway = gateway();
    vi.mocked(fixtureGateway.deleteClassification)
      .mockRejectedValueOnce(new Error("삭제할 수 없습니다"))
      .mockResolvedValueOnce(undefined);
    renderSidebar(fixtureGateway, { selectedId: "tag" });

    await user.click(screen.getByRole("button", { name: "삭제" }));
    await user.click(screen.getByRole("button", { name: "삭제 확인" }));
    expect(await screen.findByRole("status")).toHaveTextContent("삭제할 수 없습니다");

    await user.click(screen.getByRole("button", { name: "삭제 확인" }));
    await waitFor(() =>
      expect(fixtureGateway.deleteClassification).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("warns when the tree contains orphaned entries", () => {
    renderSidebar(gateway(), {
      entries: [...entries, { id: "lost", kind: "tag", name: "고아", parentId: "missing" }],
    });

    expect(screen.getByRole("alert")).toHaveTextContent("고아 분류 항목");
  });
});
