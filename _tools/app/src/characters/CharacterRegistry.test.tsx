import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterRegistry, characterDraft } from "./CharacterRegistry";
import type { CharacterApi, CharacterTarget, ReferenceInspection } from "./api";

afterEach(cleanup);

it("keeps frequent actions above closed details and preserves edits when sections are folded", async () => {
  const target: CharacterTarget = {
    id: "character", displayName: "이로하", seriesClassificationId: "series", linkedClassificationId: null,
    enabled: true, manualOnly: false, revision: 1, ready: true, fingerprint: "fingerprint", thumbnailAssetId: "portrait",
    references: Array.from({ length: 5 }, (_, slot) => ({ slot, assetId: `ref-${slot}`, assetHash: `hash-${slot}`, status: "ready" })),
  };
  const inspect = vi.fn(async (): Promise<ReferenceInspection[]> => target.references.map((ref, index) => ({
    assetId: ref.assetId!, contentHash: ref.assetHash, baselineFingerprint: "baseline", width: 200, height: 300,
    boxes: index === 0 ? [[0, 0, 100, 300], [100, 0, 200, 300]] : [[0, 0, 200, 300]],
    state: index === 0 ? "needs_region" : "single", selectedIndex: index === 0 ? null : 0,
    automaticIndex: null, suggestedIndex: null,
  })));
  const saved = vi.fn(), pick = vi.fn(), recommend = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState(() => characterDraft(target));
    return <CharacterRegistry target={target} draft={draft} seriesId="series" api={{ inspectReferenceRegions: inspect }}
      privacyMode={false} busy={false} error={null} onChange={setDraft} onPick={pick}
      onRecommendReferences={recommend} onSave={() => saved(draft)} />;
  }
  render(<Editor />);
  const user = userEvent.setup();
  const confirm = await screen.findByRole("button", { name: "필요한 인물만 확인" });
  const references = screen.getByText("레퍼런스", { selector: "summary span" }).closest("details")!;
  for (const label of ["레퍼런스", "설명·대표 이미지", "분류 안내"]) {
    expect(screen.getByText(label, { selector: "summary span" }).closest("details")).not.toHaveAttribute("open");
  }
  for (const button of [confirm, screen.getByRole("button", { name: "저장" }), screen.getByRole("button", { name: "선택" }), screen.getByRole("button", { name: "추천으로 보강" })]) {
    expect(button).toBeVisible();
    expect(button.closest("details")).toBeNull();
    expect(button.compareDocumentPosition(references) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(screen.getByAltText("대표 이미지")).not.toBeVisible();
  await user.click(confirm);
  expect(screen.getByRole("button", { name: "인물 영역 1 선택" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "닫기" }));
  await user.click(screen.getByText("설명·대표 이미지"));
  await user.type(screen.getByLabelText("설명"), "설명 유지");
  await user.click(screen.getByText("설명·대표 이미지"));
  await user.click(screen.getByText("설명·대표 이미지"));
  expect(screen.getByLabelText("설명")).toHaveValue("설명 유지");
  expect(inspect).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ description: "설명 유지", thumbnail: "portrait" }));
  await user.click(screen.getByRole("button", { name: "선택" }));
  expect(pick).toHaveBeenCalledWith("references");
  await user.click(screen.getByRole("button", { name: "추천으로 보강" }));
  expect(recommend).toHaveBeenCalledTimes(1);
});

it("distinguishes a saved manual region from an unsaved replacement", async () => {
  const bounds: [number, number, number, number] = [0, 0, 100, 300];
  const region = { contentHash: "hash", baselineFingerprint: "baseline", bounds };
  const target: CharacterTarget = {
    id: "character", displayName: "라라", seriesClassificationId: "series", linkedClassificationId: null,
    enabled: true, manualOnly: false, revision: 1, ready: false, fingerprint: "fingerprint",
    references: [{ slot: 0, assetId: "ref", assetHash: "hash", status: "ready", region }],
  };
  const inspect = vi.fn<NonNullable<CharacterApi["inspectReferenceRegions"]>>(async (_series, _target, _ids, regions = {}) => [{
    assetId: "ref", contentHash: "hash", baselineFingerprint: "baseline", width: 200, height: 300,
    boxes: [bounds, [100, 0, 200, 300]], state: "selected",
    selectedIndex: regions.ref.bounds[0] === 0 ? 0 : 1, automaticIndex: null, suggestedIndex: null,
  }]);
  const saved = vi.fn();
  function Editor() {
    const [draft, setDraft] = useState(() => characterDraft(target));
    return <CharacterRegistry target={target} draft={draft} seriesId="series" api={{ inspectReferenceRegions: inspect }}
      privacyMode={false} busy={false} error={null} onChange={setDraft} onPick={() => {}} onSave={() => saved(draft)} />;
  }
  const user = userEvent.setup();
  render(<Editor />);
  await user.click(await screen.findByRole("button", { name: "인물 영역 조정" }));
  expect(screen.getByText("직접 지정 · 저장됨")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "레퍼런스 1 인물 영역 변경" }));
  await user.click(screen.getByRole("button", { name: "인물 영역 2 선택" }));
  expect(await screen.findByText("직접 지정 · 저장 전")).toBeVisible();
  expect(saved).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({
    referenceRegions: { ref: { ...region, bounds: [100, 0, 200, 300] } },
  }));
});

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
