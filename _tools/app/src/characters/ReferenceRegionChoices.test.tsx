import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { ReferenceRegionChoices, AUTOMATIC_CHARACTER_REFERENCE_COUNT, usableReferenceCount, automaticReferenceCount, useReferenceRegionInspection } from "./ReferenceRegionChoices";
import type { ReferenceInspection, ReferenceRegions } from "./api";

afterEach(cleanup);

const multi = [[10, 20, 110, 220], [200, 40, 380, 520]] as [number, number, number, number][];

const inspection = (assetId: string, state: string, boxes: [number, number, number, number][] = [[10, 20, 110, 220]], automaticIndex: number | null = state === "automatic" ? 0 : null): ReferenceInspection =>
  ({ assetId, contentHash: `hash-${assetId}`, baselineFingerprint: "baseline", width: 400, height: 600, boxes,
    selectedIndex: null, suggestedIndex: null, automaticIndex, state });

const box = (assetId: string, bounds: [number, number, number, number]) => ({ contentHash: `hash-${assetId}`, baselineFingerprint: "baseline", bounds });

/** Renders the section and exposes the draft it owns. */
function Harness({ initial = {}, assetIds, respond }: {
  initial?: ReferenceRegions; assetIds: string[];
  respond: (ids: string[], regions: ReferenceRegions) => Promise<ReferenceInspection[]>;
}) {
  const [draft, setDraft] = useState<ReferenceRegions>(initial);
  return <>
    <ReferenceRegionChoices seriesId="series" targetId="hina" assetIds={assetIds} draftRegions={draft} privacyMode={false} busy={false}
      api={(_series, _target, ids, regions) => respond(ids, regions ?? {})} onChange={setDraft} />
    <output aria-label="초안">{JSON.stringify(draft)}</output>
  </>;
}

const draft = () => JSON.parse(screen.getByLabelText("초안").textContent ?? "{}") as ReferenceRegions;
const boxButtons = () => screen.queryAllByRole("button", { name: /인물 영역 \d+ 선택/ });
const six = ["a", "b", "c", "d", "e", "f"];

it("distinguishes saved choices, unsaved choices, automatic crops and unresolved or stale references", async () => {
  const manual = box("a", multi[1]);
  const unsaved = box("b", multi[0]);
  const stale = box("e", multi[0]);
  const rows = [
    { ...inspection("a", "selected", multi), selectedIndex: 1 },
    { ...inspection("b", "selected", multi), selectedIndex: 0 },
    inspection("c", "automatic", multi, 1),
    inspection("d", "needs_region", multi),
    inspection("e", "stale_region", multi),
  ];
  const onChange = vi.fn();
  render(<ReferenceRegionChoices seriesId="series" targetId="lara" assetIds={["a", "b", "c", "d", "e"]}
    draftRegions={{ a: manual, b: unsaved, e: stale }} savedRegions={{ a: manual, e: stale }}
    privacyMode={false} busy={false} api={vi.fn()} inspection={{ inspections: rows, error: null }} onChange={onChange} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "인물 영역 조정" }));
  expect(within(screen.getByRole("region", { name: "인물 영역 목록" })).getAllByRole("group")
    .map(card => card.getAttribute("aria-label")?.split(" · ")[0]))
    .toEqual(["레퍼런스 1", "레퍼런스 2", "레퍼런스 3", "레퍼런스 4", "레퍼런스 5"]);
  const savedCard = screen.getByRole("group", { name: "레퍼런스 1 · 직접 지정 · 저장됨" });
  expect(within(savedCard).getByText("직접 지정 · 저장됨")).toBeVisible();
  expect(savedCard.querySelector("rect")).toHaveAttribute("x", "200");
  expect(savedCard.querySelector("rect")).toHaveAttribute("width", "180");
  expect(screen.getByRole("group", { name: "레퍼런스 2 · 직접 지정 · 저장 전" })).toBeVisible();
  expect(screen.getByRole("group", { name: "레퍼런스 3 · 자동 확인" })).toBeVisible();
  const unresolved = screen.getByRole("group", { name: "레퍼런스 4 · 인물 확인 필요 · 미사용" });
  expect(unresolved.querySelector("rect")).toBeNull();
  expect(within(unresolved).getByText("인물 선택")).toBeVisible();
  const staleCard = screen.getByRole("group", { name: "레퍼런스 5 · 직접 지정 · 재확인 필요" });
  expect(staleCard.querySelector("rect")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();

  await user.click(within(savedCard).getByRole("button"));
  expect(screen.getByRole("button", { name: "인물 영역 1 선택" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "인물 영역 2 선택" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("직접 지정한 인물")).toBeVisible();
});

it("marks an automatic crop as automatic rather than a manual confirmation", async () => {
  const rows = [inspection("a", "automatic", multi, 1)];
  const onChange = vi.fn();
  render(<ReferenceRegionChoices seriesId="series" targetId="lara" assetIds={["a"]} draftRegions={{}}
    privacyMode={false} busy={false} api={vi.fn()} inspection={{ inspections: rows, error: null }} onChange={onChange} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "인물 영역 조정" }));
  await user.click(screen.getByRole("button", { name: "레퍼런스 1 인물 영역 변경" }));
  expect(screen.getByRole("button", { name: "인물 영역 2 선택" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("자동 선택된 인물")).toBeVisible();
  expect(screen.queryByText("직접 지정한 인물")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "인물 영역 2 선택" }));
  expect(onChange).toHaveBeenCalledWith({ a: box("a", multi[1]) });
});

it("stays completely quiet when six usable references leave nothing to ask", async () => {
  const api = vi.fn(async () => six.map(id => inspection(id, "single")));
  render(<Harness assetIds={six} respond={api} />);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  // Nothing required, nothing chosen, no inferred common person: no section at all.
  expect(screen.queryByRole("region", { name: "인물 영역 확인" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /인물 영역 \d+ 선택/ })).not.toBeInTheDocument();
  expect(draft()).toEqual({});
});

it("does not render the correction list by default even when unresolved references exist alongside six usable ones", async () => {
  const api = vi.fn(async () => [...six.map(id => inspection(id, "single")), inspection("g", "needs_region", multi)]);
  render(<Harness assetIds={[...six, "g"]} respond={api} />);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  // Enough usable references: neither the shortfall workflow nor the reference list shows.
  expect(screen.queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /인물 영역 \d+ 선택/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "인물 영역 목록" })).not.toBeInTheDocument();
  expect(screen.queryByText(/골라 주세요/)).not.toBeInTheDocument();
  // Correction stays reachable, but only as an explicit action.
  expect(screen.getByRole("button", { name: "인물 영역 조정" })).toBeInTheDocument();
});

it("offers the shortfall workflow quietly and opens the chooser only on click", async () => {
  const api = vi.fn(async () => [inspection("a", "single"), inspection("b", "needs_region", multi)]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b"]} respond={api} />);
  expect(await screen.findByRole("button", { name: "필요한 인물만 확인" })).toBeInTheDocument();
  expect(boxButtons()).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "필요한 인물만 확인" }));
  expect(await screen.findByRole("button", { name: "인물 영역 1 선택" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "닫기" }));
  expect(boxButtons()).toHaveLength(0);
});

it("closes the required workflow by itself when reinspection reaches six usable references", async () => {
  // Start with five usable plus two unresolved. Resolving the sixth reference lifts the
  // usable count to the threshold, which ends the required workflow.
  const api = vi.fn(async (_ids: string[], regions: ReferenceRegions) => [
    ...["a", "b", "c", "d", "e"].map(id => inspection(id, "single")),
    regions.f ? inspection("f", "selected") : inspection("f", "needs_region", multi),
    inspection("h", "needs_region", multi),
  ]);
  const user = userEvent.setup();
  render(<Harness assetIds={[...six, "h"]} respond={api} />);
  const prompt = await screen.findByRole("button", { name: "필요한 인물만 확인" });
  await user.click(prompt);
  expect(screen.getByText("1/2")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "인물 영역 1 선택" }));
  // Six usable references are reached, so the required workflow ends and the chooser closes.
  await waitFor(() => expect(draft()).toEqual({ f: box("f", [10, 20, 110, 220]) }));
  await waitFor(() => expect(boxButtons()).toHaveLength(0));
  expect(screen.queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
  // The remaining unresolved reference is still correctable, but only on request.
  await user.click(await screen.findByRole("button", { name: "인물 영역 조정" }));
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 7 인물 영역 변경" }));
  expect(await screen.findByRole("button", { name: "인물 영역 1 선택" })).toBeInTheDocument();
});

it("keeps the required workflow open while the count is still short", async () => {
  const api = vi.fn(async (_ids: string[], regions: ReferenceRegions) => [
    inspection("a", "single"),
    regions.b ? inspection("b", "selected") : inspection("b", "needs_region", multi),
    inspection("c", "needs_region", multi),
  ]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b", "c"]} respond={api} />);
  await user.click(await screen.findByRole("button", { name: "필요한 인물만 확인" }));
  await user.click(await screen.findByRole("button", { name: "인물 영역 1 선택" }));
  // Two usable references are still short, so the workflow continues on the next reference.
  await waitFor(() => expect(boxButtons()).toHaveLength(2));
  expect(screen.getByText("1/1")).toBeInTheDocument();
});

it("advances through every unresolved reference instead of alternating two", async () => {
  const ids = ["a", "b", "c", "d"];
  const api = vi.fn(async () => ids.map(id => inspection(id, "needs_region", multi)));
  const user = userEvent.setup();
  render(<Harness assetIds={ids} respond={api} />);
  await user.click(await screen.findByRole("button", { name: "필요한 인물만 확인" }));
  const current = () => screen.getByText(/^\d+\/\d+$/).textContent;
  const seen: (string | null)[] = [];
  for (let step = 0; step < 4; step += 1) {
    seen.push(current());
    await user.click(screen.getByRole("button", { name: "다음 이미지" }));
  }
  expect(new Set(seen).size).toBe(4);
  expect(current()).toBe(seen[0]);
});

it("reopens a stale saved binding for re-choice instead of replacing it silently", async () => {
  // The stored binding no longer matches the image and detector, so the native side reports
  // it stale. The user must re-choose; the region is never swapped behind their back.
  const api = vi.fn(async () => [inspection("a", "stale_region", multi), inspection("b", "single")]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b"]} initial={{ a: box("a", [10, 20, 110, 220]) }} respond={api} />);
  // A stale binding is unresolved even though the draft still holds an entry.
  const prompt = await screen.findByRole("button", { name: "필요한 인물만 확인" });
  expect(draft()).toEqual({ a: box("a", [10, 20, 110, 220]) });
  await user.click(prompt);
  await user.click(await screen.findByRole("button", { name: "인물 영역 2 선택" }));
  // Only the explicit choice replaces the stale binding.
  expect(draft()).toEqual({ a: box("a", [200, 40, 380, 520]) });
});

it("keeps a stale binding correctable when the image offers a single box", async () => {
  // The detector found one person, but the stored binding is still out of date, so the
  // user can re-confirm it through optional correction.
  const api = vi.fn(async () => [inspection("a", "stale_region", [[10, 20, 110, 220]]), inspection("b", "single")]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b"]} initial={{ a: box("a", [10, 20, 110, 220]) }} respond={api} />);
  await user.click(await screen.findByRole("button", { name: "인물 영역 조정" }));
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 1 인물 영역 변경" }));
  await user.click(await screen.findByRole("button", { name: "인물 영역 1 선택" }));
  expect(draft()).toEqual({ a: box("a", [10, 20, 110, 220]) });
});

it("keeps undetected images unchoosable even when an old manual binding remains", async () => {
  const api = vi.fn(async () => [inspection("a", "stale_region", []), inspection("b", "no_region", [])]);
  render(<Harness assetIds={["a", "b"]} initial={{ a: box("a", [10, 20, 110, 220]) }} respond={api} />);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  // No invented crop and nothing to ask: an undetected image is simply unused.
  expect(screen.queryByRole("button", { name: "인물 영역 조정" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /인물 영역 \d+ 선택/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "인물 영역 목록" })).not.toBeInTheDocument();
});

it("offers an optional adjustment while the shortfall workflow is still required", async () => {
  const api = vi.fn(async () => [
    ...["a", "b", "c", "d"].map(id => inspection(id, "single")),
    inspection("e", "needs_region", multi),
    inspection("f", "automatic", multi, 1),
  ]);
  render(<Harness assetIds={["a", "b", "c", "d", "e", "f"]} respond={api} />);
  // Both actions are reachable: the required shortfall prompt and the optional adjustment,
  // because the inferred crop on reference six is not part of the required queue.
  expect(await screen.findByRole("button", { name: "필요한 인물만 확인" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "인물 영역 조정" })).toBeInTheDocument();
});

it("returns to the optional list after a correction instead of advancing the required queue", async () => {
  // Five usable references with two unresolved and one adjustable inferred crop, so the
  // required queue is non-empty at the moment the user corrects the inferred reference.
  const api = vi.fn(async () => [
    ...["a", "b", "c", "d"].map(id => inspection(id, "single")),
    inspection("e", "needs_region", multi),
    inspection("f", "needs_region", multi),
    inspection("g", "automatic", multi, 1),
  ]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b", "c", "d", "e", "f", "g"]} respond={api} />);
  expect(await screen.findByRole("button", { name: "필요한 인물만 확인" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "인물 영역 조정" }));
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 7 인물 영역 변경" }));
  await user.click(await screen.findByRole("button", { name: "인물 영역 1 선택" }));
  expect(draft()).toEqual({ g: box("g", [10, 20, 110, 220]) });
  // The correction returns to the list even though the required queue still has entries.
  // Advancing the queue would instead have opened the chooser on the next unresolved image.
  expect(await screen.findByRole("region", { name: "인물 영역 목록" })).toBeInTheDocument();
  expect(boxButtons()).toHaveLength(0);
});

it("lets a chosen region be replaced through correction without offering to remove it", async () => {
  const api = vi.fn(async () => [inspection("a", "needs_region", multi), inspection("b", "single")]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b"]} initial={{ a: box("a", [10, 20, 110, 220]) }} respond={api} />);
  // The correction list appears only inside the correction workflow.
  await user.click(await screen.findByRole("button", { name: "인물 영역 조정" }));
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  expect(within(summary).queryByRole("button", { name: /해제/ })).not.toBeInTheDocument();
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 1 인물 영역 변경" }));
  await user.click(await screen.findByRole("button", { name: "인물 영역 2 선택" }));
  expect(draft()).toEqual({ a: box("a", [200, 40, 380, 520]) });
});

it("keeps an inferred common-person crop correctable without prompting", async () => {
  const api = vi.fn(async () => [...six.map(id => inspection(id, "single")), inspection("g", "automatic", multi, 1)]);
  const user = userEvent.setup();
  render(<Harness assetIds={[...six, "g"]} respond={api} />);
  expect(await screen.findByRole("button", { name: "인물 영역 조정" })).toBeInTheDocument();
  expect(screen.queryByText(/공통 인물이 확인된/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "인물 영역 조정" }));
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 7 인물 영역 변경" }));
  // The inferred crop is box 2, so correcting it to box 1 shows a real position, not 0/N.
  expect(screen.getByText("7/7")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "인물 영역 1 선택" }));
  expect(draft()).toEqual({ g: box("g", [10, 20, 110, 220]) });
});

it("offers a suggestion only when it differs from the crop already in effect", async () => {
  const suggested = { ...inspection("a", "needs_region", multi), suggestedIndex: 1 };
  const api = vi.fn(async () => [suggested, inspection("b", "needs_region", multi)]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a", "b"]} respond={api} />);
  await user.click(await screen.findByRole("button", { name: "필요한 인물만 확인" }));
  expect(screen.getByRole("button", { name: "추천 영역 사용" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "다음 이미지" }));
  expect(screen.queryByRole("button", { name: "추천 영역 사용" })).not.toBeInTheDocument();
});

it("hides the suggestion when it repeats the crop already in effect", async () => {
  const same = { ...inspection("a", "automatic", multi, 1), suggestedIndex: 1 };
  const api = vi.fn(async () => [same]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a"]} respond={api} />);
  await user.click(await screen.findByRole("button", { name: "인물 영역 조정" }));
  const summary = await screen.findByRole("region", { name: "인물 영역 목록" });
  await user.click(within(summary).getByRole("button", { name: "레퍼런스 1 인물 영역 변경" }));
  expect(screen.queryByRole("button", { name: "추천 영역 사용" })).not.toBeInTheDocument();
});

it("keeps the crop preview finite when the box fills the image", async () => {
  const api = vi.fn(async () => [inspection("a", "needs_region", [[0, 0, 400, 600], [10, 10, 40, 60]])]);
  const user = userEvent.setup();
  render(<Harness assetIds={["a"]} respond={api} />);
  await user.click(await screen.findByRole("button", { name: "필요한 인물만 확인" }));
  const frames = screen.getAllByRole("button", { name: /인물 영역 \d+ 선택/ });
  expect(frames).toHaveLength(2);
  for (const frame of frames) {
    const style = frame.getAttribute("style") ?? "";
    expect(style).not.toMatch(/NaN|Infinity/);
    expect(style).toContain("background-image");
    expect(frame).toHaveClass("character-region-frame");
  }
  // A crop filling its dimension has no overflow to offset, so the position is exactly 0%
  // and the whole thumbnail fits the frame without over-scaling.
  const style = frames[0]!.getAttribute("style") ?? "";
  expect(style).toContain("background-position: 0% 0%");
  expect(style).toContain("background-size: 100% 100%");
});

it("never calls the backend for an empty reference list", async () => {
  const api = vi.fn(async () => []);
  const { container } = render(<Harness assetIds={[]} respond={api} />);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(api).not.toHaveBeenCalled();
  expect(container.querySelector(".character-reference-regions")).toBeNull();
});

it("shows no stale correction list after a failed inspection", async () => {
  let fail = false;
  const api = vi.fn(async () => {
    if (fail) throw new Error("boom");
    return [inspection("a", "needs_region", multi), inspection("b", "single")];
  });
  const { rerender } = render(<Harness assetIds={["a", "b"]} respond={api} />);
  // First pass succeeds and offers the shortfall workflow.
  expect(await screen.findByRole("button", { name: "필요한 인물만 확인" })).toBeInTheDocument();
  fail = true;
  rerender(<Harness assetIds={["a", "b", "c"]} respond={api} />);
  // The failure surfaces as an error and the previous list is not presented as current.
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "인물 영역 목록" })).not.toBeInTheDocument();
  expect(boxButtons()).toHaveLength(0);
});

it("counts usability from the inspection states, not from stored regions", () => {
  const rows = [inspection("a", "single"), inspection("b", "selected"), inspection("c", "automatic"),
    inspection("d", "needs_region"), inspection("e", "no_region"), inspection("f", "stale_region")];
  expect(usableReferenceCount(rows)).toBe(3);
  expect(automaticReferenceCount(rows)).toBe(1);
  expect(usableReferenceCount(rows)).toBeLessThan(AUTOMATIC_CHARACTER_REFERENCE_COUNT);
});

it("does not repaint from an inspection that arrives after the reference list changed", async () => {
  const resolvers: ((rows: ReferenceInspection[]) => void)[] = [];
  const api = vi.fn((_series: string, _target: string | null, _ids: string[], _regions?: ReferenceRegions) =>
    new Promise<ReferenceInspection[]>(resolve => { resolvers.push(resolve); }));
  const view = (assetIds: string[]) => <ReferenceRegionChoices seriesId="series" targetId="hina" assetIds={assetIds} draftRegions={{}}
    privacyMode={false} busy={false} api={api} onChange={() => {}} />;
  const { rerender } = render(view(["a", "b"]));
  rerender(view(["c"]));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  resolvers[0]!([inspection("a", "needs_region", multi), inspection("b", "needs_region", multi)]);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
  resolvers[1]!([inspection("c", "needs_region", [[1, 1, 9, 9]])]);
  expect(await screen.findByRole("button", { name: "필요한 인물만 확인" })).toBeInTheDocument();
});

it("does not reuse another character's inspection when references have the same IDs", async () => {
  const resolvers: ((rows: ReferenceInspection[]) => void)[] = [];
  const api = vi.fn(() => new Promise<ReferenceInspection[]>(resolve => { resolvers.push(resolve); }));
  const { result, rerender } = renderHook(({ targetId, revision }) => useReferenceRegionInspection({
    seriesId: "series", targetId, revision, assetIds: ["shared"], draftRegions: {}, api,
  }), { initialProps: { targetId: "first", revision: "1" } });
  rerender({ targetId: "second", revision: "1" });
  expect(result.current.inspections).toBeNull();
  await act(async () => { resolvers[1]!([inspection("shared", "single")]); });
  await act(async () => { resolvers[0]!([inspection("shared", "needs_region", multi)]); });
  expect(result.current.inspections?.[0]?.state).toBe("single");
  rerender({ targetId: "second", revision: "1" });
  expect(api).toHaveBeenCalledTimes(2);
  rerender({ targetId: "second", revision: "2" });
  expect(result.current.inspections).toBeNull();
  expect(api).toHaveBeenCalledTimes(3);
});

it("does not settle state from a response that arrives after unmount", async () => {
  let resolve: (rows: ReferenceInspection[]) => void = () => {};
  const api = vi.fn(() => new Promise<ReferenceInspection[]>(next => { resolve = next; }));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { unmount } = render(<Harness assetIds={["a", "b"]} respond={(_ids, _regions) => api()} />);
  unmount();
  resolve([inspection("a", "needs_region")]);
  await new Promise(next => setTimeout(next, 20));
  expect(errors).not.toHaveBeenCalled();
});
