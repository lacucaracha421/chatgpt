import { BusyLabel } from "../shared/ui/BusyLabel";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { commandErrorMessage } from "../library/errorMessage";

/**
 * 학습 인식 (S36) needs its scoring to run. Which characters it places is no setting: the app decides per
 * character from its judgments, see `S36Readiness`.
 */
export type S36PublicationSettings = { scoringEnabled: boolean };

/**
 * One character's numbers for the rule, as the library counts them: it places this character with 학습 인식
 * (`learning`) once `reviewed` ≥ READY_REVIEWED and `examples` ≥ READY_EXAMPLES and `wrong` ≤ `allowed`
 * (5% of `reviewed`, at least one). `hold`: enough of both, but too many wrong, so 기본 인식 again; it
 * returns by itself once the numbers are within the allowance. Learned examples never show up here.
 */
export type S36Readiness = { targetId: string; reviewed: number; wrong: number; allowed: number; examples: number; status: "learning" | "collecting" | "hold" };
export const READY_REVIEWED = 30, READY_EXAMPLES = 50;

export interface S36PublicationApi {
  get(): Promise<S36PublicationSettings>;
  clear(seriesId: string): Promise<number>;
  readiness(seriesId: string): Promise<S36Readiness[]>;
}

export const s36PublicationApi: S36PublicationApi = {
  get: () => invoke("character_s36_publication"),
  clear: seriesId => invoke("clear_character_s36_automatic", { seriesId }),
  readiness: seriesId => invoke("character_s36_readiness", { seriesId }),
};

export async function enableS36Scoring() {
  await invoke("set_character_shadow_enabled", { enabled: true });
}

/** Undo the placements 학습 인식 made in one series that nobody has looked at since (설정 › 고급). */
export function S36ClearControl({ seriesId, seriesName, disabled, onChanged, api = s36PublicationApi }: { seriesId: string; seriesName: string; disabled?: boolean; onChanged?: () => void; api?: S36PublicationApi }) {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function clear() {
    setClearing(true); setMessage(null);
    try {
      const count = await api.clear(seriesId);
      setMessage(count ? `학습 인식이 넣은 것 ${count.toLocaleString()}건을 되돌렸습니다.` : "되돌릴 학습 인식 분류가 없습니다.");
      onChanged?.();
    } catch (e) {
      setMessage(commandErrorMessage(e, "학습 인식이 넣은 것을 되돌리지 못했습니다."));
    } finally {
      setClearing(false); setConfirming(false);
    }
  }
  return <div className="s36-series">
    <Button size="sm" variant="ghost" disabled={disabled || clearing} onClick={() => setConfirming(true)}>학습 인식이 넣은 것 되돌리기</Button>
    {message && <small className="s36-series__message" role="status">{message}</small>}
    {confirming && <Dialog open title="학습 인식이 넣은 것 되돌리기" onClose={() => { if (!clearing) setConfirming(false); }}>
      <p>{seriesName}에서 학습 인식이 자동으로 넣고 아직 아무도 확인하지 않은 분류를 모두 해제합니다. 직접 판단한 것과 기본 인식이 넣은 것은 그대로 둡니다.</p>
      <div className="dialog-actions">
        <Button variant="ghost" disabled={clearing} onClick={() => setConfirming(false)}>취소</Button>
        <Button variant="primary" disabled={clearing} onClick={() => void clear()}><BusyLabel busy={!!(clearing)} idle={"해제"}>해제하는 중…</BusyLabel></Button>
      </div>
    </Dialog>}
  </div>;
}

/** Readiness of every character in one series, refreshed when judgments change. */
export function useS36Readiness(seriesId: string, refreshKey: unknown, api: S36PublicationApi = s36PublicationApi) {
  const [readiness, setReadiness] = useState<Map<string, S36Readiness>>(new Map());
  useEffect(() => {
    let alive = true;
    void api.readiness(seriesId).then(rows => { if (alive) setReadiness(new Map(rows.map(row => [row.targetId, row]))); }).catch(() => { if (alive) setReadiness(new Map()); });
    return () => { alive = false; };
  }, [api, seriesId, refreshKey]);
  return readiness;
}

/** Short card line: which recognition places the character, and the numbers behind it. */
export function readinessLabel(r: S36Readiness): string {
  switch (r.status) {
    case "learning": return `학습 인식 · 확인 판단 ${r.reviewed} · 틀림 ${r.wrong} / 허용 ${r.allowed}`;
    case "hold": return `기본 인식 · 확인 판단 ${r.reviewed} · 틀림 ${r.wrong} / 허용 ${r.allowed}`;
    default: return `학습 인식 준비 · 확인 판단 ${Math.min(r.reviewed, READY_REVIEWED)}/${READY_REVIEWED} · 맞음 예시 ${Math.min(r.examples, READY_EXAMPLES)}/${READY_EXAMPLES}`;
  }
}
