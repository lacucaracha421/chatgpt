import type { useCharacterAutomation } from "./useCharacterAutomation";
import { Button } from "../shared/ui/Button";

export function CharacterAutomationStatus({ state }: { state: ReturnType<typeof useCharacterAutomation> }) {
  if (!state.progress && !state.message && !state.paused && state.queuePending === 0) return null;
  const queue = state.queuePending > 0 ? ` · 이미지 대기 ${state.queuePending}장` : "";
  const activity = state.progress ? [
    state.activeSeriesName,
    state.activeReconsideration ? "재평가 중" : "자동 분류",
    state.activeTargetName ? `${state.activeTargetName} 비교 ${state.activeTargetIndex}/${state.progress.total}` : `캐릭터 비교 ${state.progress.completed}/${state.progress.total}`,
  ].filter(Boolean).join(" · ") : null;
  return <div className="character-actions series-automation" role="status">
    <span>{activity ? `${activity}${queue}` : state.paused ? `캐릭터 자동 분류 일시 정지${queue}` : state.queuePending > 0 ? `캐릭터 자동 분류 준비${queue}` : state.message}</span>
    {state.progress ? <Button size="sm" onClick={state.paused ? state.resume : state.pause}>{state.paused ? "재개" : "현재 이미지 후 정지"}</Button> : state.paused ? <Button size="sm" onClick={state.resume}>재개</Button> : null}
    {!state.progress && !state.paused && <Button size="sm" onClick={state.dismiss}>닫기</Button>}
  </div>;
}
