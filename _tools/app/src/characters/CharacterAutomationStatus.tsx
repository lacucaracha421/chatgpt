import type { QuietCharacterAutomationState } from "./useCharacterAutomation";
import { Button } from "../shared/ui/Button";

export function CharacterAutomationStatus({ state }: { state: QuietCharacterAutomationState }) {
  const work = state.activeWork;
  const refreshes = state.historyRefreshes ?? [];
  const fresh = Boolean(work && (work.freshRemaining > 0 || (work.active && work.cause !== "reconsideration")));
  const errorPanel = state.persistentError ? <div className="character-actions series-automation" role="alert">
      <strong>캐릭터 분석 오류</strong>
      <small className="character-message">{state.persistentError}</small>
      <div className="character-actions">
        <Button size="sm" onClick={() => void state.setupRuntime()}>분석 환경 설정</Button>
        <Button size="sm" variant="ghost" onClick={state.dismissError}>닫기</Button>
      </div>
    </div> : null;
  if (!state.historyRefreshActive && !refreshes.length && !fresh) return errorPanel;

  return <>{errorPanel}<div className="character-actions series-automation" role="status" aria-atomic="true">
    {work?.active && <p>현재 작업 · {[work.seriesName, work.targetName].filter(Boolean).join(" / ") || "이미지 준비 중"}{work.targetName ? " 비교 중" : ""}</p>}
    {fresh && <p>{work?.cause === "manual_scan" ? "수동 분석" : "새 이미지 분석"} · {work!.freshRemaining.toLocaleString()}개 남음</p>}
    {state.historyRefreshActive && <span>{state.paused ? "과거 미분류 이미지 갱신 일시 정지" : "과거 미분류 이미지 갱신 중"}</span>}
    {refreshes.map(refresh => <div className="character-refresh-progress" key={refresh.targetId}>
      <strong>{refresh.seriesName} / {refresh.targetName}</strong>
      <p>{refresh.total === null
        ? `대상 확인 중 · ${refresh.processed.toLocaleString()}개 처리 · 확인된 대기 ${refresh.remaining.toLocaleString()}개`
        : `${refresh.processed.toLocaleString()} / ${refresh.total.toLocaleString()}개 처리 · ${refresh.remaining.toLocaleString()}개 남음`}
        {refresh.failed > 0 && ` · 실패 ${refresh.failed.toLocaleString()}개`}
        {refresh.state === "failed" && " · 갱신 중단 · 캐릭터에서 다시 갱신해 주세요"}
      </p>
    </div>)}
    {state.historyRefreshActive && <Button
      size="sm"
      onClick={state.paused ? state.resumeHistoryRefresh : state.pauseHistoryRefresh}
    >
      {state.paused ? "재개" : "일시 정지"}
    </Button>}
  </div></>;
}
