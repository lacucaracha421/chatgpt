import type { useCharacterAutomation } from "./useCharacterAutomation";
import { Button } from "../shared/ui/Button";

export function CharacterAutomationStatus({ state }: { state: ReturnType<typeof useCharacterAutomation> }) {
  if (!state.progress && !state.message && !state.paused && state.queuePending === 0) return null;
  const parts = [
    state.queueAutomatic > 0 ? `자동 ${state.queueAutomatic}장` : null,
    state.queueLegacy > 0 ? `기존 작업 ${state.queueLegacy}장` : null,
    state.queueManual > 0 ? `직접 요청 ${state.queueManual}장` : null,
    state.queueReconsideration > 0 ? `재평가 ${state.queueReconsideration}장` : null,
  ].filter(Boolean);
  const queue = parts.length ? ` · 대기 ${parts.join(" · ")}` : "";
  const cause = state.activeCause === "manual_scan" ? "직접 분석" : state.activeCause === "reconsideration" ? "재평가" : state.activeCause === "legacy" ? "기존 작업" : "자동 분류";
  const activity = state.progress ? [
    state.activeSeriesName,
    cause,
    state.activeTargetName ? `현재 이미지 · ${state.activeTargetName} 비교 ${state.activeTargetIndex}/${state.progress.total}` : `현재 이미지 · 캐릭터 비교 ${state.progress.completed}/${state.progress.total}`,
  ].filter(Boolean).join(" · ") : null;
  return <div className="character-actions series-automation" role="status">
    <span>{activity ? `${activity}${queue}` : state.paused ? `캐릭터 분석 일시 정지${queue}` : state.queuePending > 0 ? `캐릭터 분석 준비${queue}` : state.message}</span>
    {state.progress ? <Button size="sm" onClick={state.paused ? state.resume : state.pause}>{state.paused ? "재개" : "현재 이미지 후 정지"}</Button> : state.paused ? <Button size="sm" onClick={state.resume}>재개</Button> : null}
    {!state.progress && !state.paused && state.queuePending === 0 && <Button size="sm" onClick={state.dismiss}>닫기</Button>}
  </div>;
}
