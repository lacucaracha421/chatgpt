import { Button } from "../shared/ui/Button";
import type { useCharacterAutomation } from "./useCharacterAutomation";
export function CharacterAutomationStatus({ state }: { state: ReturnType<typeof useCharacterAutomation> }) {
  if (!state.progress && !state.message && !state.paused) return null;
  return <div className="character-actions series-automation" role="status">
    <span>{state.progress ? `${state.progress.runtimeFingerprint ? "캐릭터 비교" : "캐릭터 분석 준비 중"} · ${state.progress.completed}/${state.progress.total}${state.progress.reused ? ` · 이전 결과 ${state.progress.reused}장 유지` : ""}` : state.paused ? "캐릭터 자동 분류 일시 정지" : state.message}</span>
    {state.progress ? <Button size="sm" onClick={state.pause}>일시 정지</Button> : <Button size="sm" onClick={state.resume}>{state.paused ? "재개" : "다시 분석"}</Button>}
    {!state.progress && !state.paused && <Button size="sm" onClick={state.dismiss}>닫기</Button>}
  </div>;
}
