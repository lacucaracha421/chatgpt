import type { QuietCharacterAutomationState } from "./useCharacterAutomation";
import { Button } from "../shared/ui/Button";

export function CharacterAutomationStatus({ state }: { state: QuietCharacterAutomationState }) {
  if (state.persistentError) {
    return <div className="character-actions series-automation" role="alert">
      <strong>캐릭터 분석 오류</strong>
      <small className="character-message">{state.persistentError}</small>
      <div className="character-actions">
        <Button size="sm" onClick={() => void state.setupRuntime()}>분석 환경 설정</Button>
        <Button size="sm" variant="ghost" onClick={state.dismissError}>닫기</Button>
      </div>
    </div>;
  }
  if (!state.historyRefreshActive) return null;

  return <div className="character-actions series-automation" role="status" aria-atomic="true">
    <span>{state.paused ? "과거 미분류 이미지 갱신 일시 정지" : "과거 미분류 이미지 갱신 중"}</span>
    <Button
      size="sm"
      onClick={state.paused ? state.resumeHistoryRefresh : state.pauseHistoryRefresh}
    >
      {state.paused ? "재개" : "일시 정지"}
    </Button>
  </div>;
}
