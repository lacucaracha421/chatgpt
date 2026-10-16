import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { BackNavigationProvider } from "../shared/navigation/BackNavigation";
import type { CharacterTarget } from "./api";
import { ConfirmList } from "./ConfirmList";
import { ConfirmOverview } from "./ConfirmOverview";
import type { ConfirmScope } from "./confirmClient";
import { confirmSourceFor, shadowItem } from "./confirmTestKit";
import { suggestionApi, type Suggestion } from "./suggestions/client";
import type { TaggerDecisionApi } from "./taggerReviewClient";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("keeps the suggestion section intact while returning from a completed review", async () => {
  const list = vi.spyOn(suggestionApi, "list").mockResolvedValue([]);
  vi.spyOn(suggestionApi, "ignored").mockResolvedValue([]);
  const sources = confirmSourceFor({ candidates: [shadowItem("c1", "hina", "히나")] });
  const targets = [{ id: "hina", displayName: "히나", seriesClassificationId: "series", references: [] }] as unknown as CharacterTarget[];
  const decisions: TaggerDecisionApi = {
    decide: vi.fn().mockResolvedValue(1), decideBatch: vi.fn().mockResolvedValue(1),
    move: vi.fn().mockResolvedValue(1), classifications: vi.fn().mockResolvedValue(["series"]),
  };
  // Home keeps the overview mounted and increments its read version when the dialog closes.
  function ReviewScreen() {
    const [version, setVersion] = useState(0);
    const [scope, setScope] = useState<ConfirmScope | null>(null);
    return <BackNavigationProvider>
      <ConfirmOverview targets={targets} seriesName={() => "시리즈"} version={version} restricted={false} privacyMode={false}
        sources={sources} onBack={() => undefined} onOpen={setScope} />
      {scope && <ConfirmList scope={scope} targets={targets} classifications={[]} sources={sources} decisions={decisions}
        onClose={() => { setScope(null); setVersion(value => value + 1); }} />}
    </BackNavigationProvider>;
  }
  render(<ReviewScreen />);
  const empty = await screen.findByText("조건에 맞는 새 캐릭터 제안이 없습니다.");
  const section = screen.getByRole("region", { name: "새 캐릭터 제안" });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "전체 확인" }));
  await screen.findByLabelText("확인 정보");
  let finish!: (rows: Suggestion[]) => void;
  list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await user.click(screen.getByRole("button", { name: /^맞음/ }));
  await user.click(screen.getByRole("button", { name: "확인 닫기" }));
  expect(screen.queryByRole("dialog", { name: "확인" })).toBeNull();
  expect(decisions.decide).toHaveBeenCalled();
  expect(list).toHaveBeenCalledTimes(2);
  vi.useFakeTimers();
  await act(async () => { vi.advanceTimersByTime(1200); });
  expect(screen.getByRole("region", { name: "새 캐릭터 제안" })).toBe(section);
  expect(empty).toBeInTheDocument();
  expect(within(section).queryByRole("status")).toBeNull();
  await act(async () => finish([]));
  expect(empty).toBeInTheDocument();
  expect(within(section).queryByRole("status")).toBeNull();
});
