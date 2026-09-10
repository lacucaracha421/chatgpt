import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterSeriesSuggestions } from "./CharacterSeriesSuggestions";
import type { CharacterSuggestionApi } from "./hubApi";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function api(overrides: Partial<CharacterSuggestionApi> = {}): CharacterSuggestionApi {
  return {
    suggestions: vi.fn().mockResolvedValue({ items: [], unscannedCount: 12, pendingCount: 0 }),
    queueDiscovery: vi.fn().mockResolvedValue(12),
    dismissSuggestion: vi.fn().mockResolvedValue(undefined),
    acceptSuggestion: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

it("does not start discovery just by opening the suggestion dialog", async () => {
  const fake = api();
  render(<CharacterSeriesSuggestions rootId="root" rootName="만화" privacyMode={false} onClose={vi.fn()} onMoved={vi.fn()} api={fake} />);
  expect(await screen.findByRole("button", { name: "남은 12장 분석" })).toBeInTheDocument();
  expect(fake.queueDiscovery).not.toHaveBeenCalled();
});
it("queues discovery only after the user asks for it", async () => {
  const fake = api();
  const user = userEvent.setup();
  render(<CharacterSeriesSuggestions rootId="root" rootName="만화" privacyMode={false} onClose={vi.fn()} onMoved={vi.fn()} api={fake} />);
  await user.click(await screen.findByRole("button", { name: "남은 12장 분석" }));
  await waitFor(() => expect(fake.queueDiscovery).toHaveBeenCalledWith("root"));
  expect(await screen.findByText(/12장 분석을 예약했습니다/)).toBeInTheDocument();
});

it("moves the work classification without requiring character approval", async () => {
  const fake = api({ suggestions: vi.fn().mockResolvedValue({ items: [{
    asset: { id: "image", title: null, originalName: "image.webp", byteSize: 10, width: 100, height: 100,
      collectedAt: "2026-09-10T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null,
      creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null,
      media: { kind: "image" } },
    seriesId: "band", seriesName: "걸밴크", targetId: "rupa", targetName: "루파", targetCount: 1, matchedReferences: 3,
  }], unscannedCount: 0, pendingCount: 0 }) });
  const onMoved = vi.fn();
  const user = userEvent.setup();
  render(<CharacterSeriesSuggestions rootId="root" rootName="만화" privacyMode={false} onClose={vi.fn()} onMoved={onMoved} api={fake} />);
  await user.click(await screen.findByRole("button", { name: "걸밴크로 이동" }));
  await waitFor(() => expect(fake.acceptSuggestion).toHaveBeenCalledWith("root", "image", "band"));
  expect(onMoved).toHaveBeenCalledTimes(1);
});
