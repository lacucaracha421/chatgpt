import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterRegistry, characterDraft } from "./CharacterRegistry";
import type { CharacterTarget } from "./api";

afterEach(cleanup);

it("edits both reference sources in one list without saving inactive images or losing active additions", async () => {
  const target: CharacterTarget = {
    id: "character", displayName: "Character", seriesClassificationId: "series", linkedClassificationId: null,
    enabled: true, manualOnly: false, revision: 1, ready: true, fingerprint: "fingerprint",
    references: [{ slot: 0, assetId: "base", assetHash: "a", status: "ready" }, { slot: 1, assetId: "trash", assetHash: "b", status: "ineligible" }],
    learnedReferences: [{ slot: 0, assetId: "added", assetHash: "c", status: "ready" }],
  };
  const saved = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState(() => characterDraft(target));
    return <CharacterRegistry target={target} draft={draft} onChange={setDraft} privacyMode={false} busy={false} error={null}
      onPick={() => {}} onSave={() => saved(draft.references)} onOpenReference={() => {}} />;
  }
  render(<Editor />);
  const user = userEvent.setup();
  await user.click(screen.getByText("레퍼런스", { selector: "summary span" }));
  const list = screen.getByRole("region", { name: "레퍼런스 목록" });
  expect(within(list).getAllByRole("img")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved).toHaveBeenLastCalledWith(["base", "added"]);
  await user.click(within(list).getByRole("button", { name: "레퍼런스 1 제거" }));
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved).toHaveBeenLastCalledWith(["added"]);
  await user.click(within(list).getByRole("button", { name: "레퍼런스 1 제거" }));
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved).toHaveBeenLastCalledWith([]);
});
