import { Button } from "../shared/ui/Button";
import type { useCharacterAutomation } from "./useCharacterAutomation";
export function CharacterAutomationStatus({ state }: { state: ReturnType<typeof useCharacterAutomation> }) {
  if (!state.progress && !state.message && !state.paused) return null;
  return <div className="character-actions series-automation" role="status">
    <span>{state.progress ? `${state.progress.runtimeFingerprint ? "이미지 후보 비교" : "캐릭터 분석 준비 중"} · ${state.progress.completed}/${state.progress.total}${state.progress.reused ? ` · 이전 결과 ${state.progress.reused}장 유지` : ""}` : state.paused ? "캐릭터 자동 분류 일시 정지" : state.message}</span>
    {state.progress ? <Button size="sm" onClick={state.paused ? state.resume : state.pause}>{state.paused ? "재개" : "현재 이미지 후 정지"}</Button> : state.paused ? <Button size="sm" onClick={state.resume}>재개</Button> : null}
    {!state.progress && !state.paused && <Button size="sm" onClick={state.dismiss}>닫기</Button>}
  </div>;
}
