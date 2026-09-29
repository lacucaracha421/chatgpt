import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { commandErrorMessage } from "../library/errorMessage";

/** Machine-local stage 3 choice: series classified by S36, and characters left out of it. */
export type S36PublicationSettings = { series: string[]; excludedTargets: string[]; scoringEnabled: boolean };

/** Evidence for switching one character to S36: reviewed automatic candidates and examples. */
export type S36Readiness = { targetId: string; reviewed: number; wrong: number; examples: number; status: "ready" | "collecting" | "hold" | "keep" };
export const READY_REVIEWED = 30, READY_EXAMPLES = 50;

export interface S36PublicationApi {
  get(): Promise<S36PublicationSettings>;
  set(series: string[], excludedTargets: string[]): Promise<S36PublicationSettings>;
  clear(seriesId: string): Promise<number>;
  readiness(seriesId: string): Promise<S36Readiness[]>;
}

export const s36PublicationApi: S36PublicationApi = {
  get: () => invoke("character_s36_publication"),
  set: (series, excludedTargets) => invoke("set_character_s36_publication", { series, excludedTargets }),
  clear: seriesId => invoke("clear_character_s36_automatic", { seriesId }),
  readiness: seriesId => invoke("character_s36_readiness", { seriesId }),
};

const EVENT = "lakomics-s36-publication";

export async function enableS36Scoring() {
  await invoke("set_character_shadow_enabled", { enabled: true });
  window.dispatchEvent(new Event(EVENT));
}

export function S36ScoringWarning({ disabled, onChanged }: { disabled?: boolean; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function enable() {
    if (busy) return;
    setBusy(true); setError(null);
    try { await enableS36Scoring(); onChanged?.(); }
    catch (cause) { setError(commandErrorMessage(cause, "S36 채점을 켜지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <>
    <small className="s36-series__warning" role="status">S36 채점이 꺼져 있어 자동 분류가 멈춰 있습니다 <Button size="sm" variant="quiet" disabled={disabled || busy} onClick={() => void enable()}>켜기</Button></small>
    {error && <small className="s36-series__message" role="alert">{error}</small>}
  </>;
}

/** One shared view of the settings; every change notifies the other controls. */
export function useS36Publication(api: S36PublicationApi) {
  const [settings, setSettings] = useState<S36PublicationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => void api.get().then(value => { if (alive) { setSettings(value); setError(null); } })
      .catch(e => { if (alive) setError(commandErrorMessage(e, "S36 설정을 불러오지 못했습니다.")); });
    load();
    window.addEventListener(EVENT, load);
    return () => { alive = false; window.removeEventListener(EVENT, load); };
  }, [api]);
  const save = useCallback(async (series: string[], excluded: string[]) => {
    setError(null);
    try {
      setSettings(await api.set(series, excluded));
      window.dispatchEvent(new Event(EVENT));
    } catch (e) {
      setError(commandErrorMessage(e, "S36 설정을 저장하지 못했습니다."));
    }
  }, [api]);
  return { settings, error, save };
}

/** Shared character-level S36 exclusion state for the editor and overflow menu. */
export function useS36CharacterExclusion(seriesId: string, targetId: string | null, api: S36PublicationApi = s36PublicationApi) {
  const publication = useS36Publication(api);
  const enabled = Boolean(publication.settings?.series.includes(seriesId));
  const excluded = Boolean(targetId && publication.settings?.excludedTargets.includes(targetId));
  const toggle = useCallback(() => {
    if (!publication.settings || !targetId || !enabled) return;
    const next = excluded
      ? publication.settings.excludedTargets.filter(id => id !== targetId)
      : [...publication.settings.excludedTargets, targetId];
    void publication.save(publication.settings.series, next);
  }, [enabled, excluded, publication, targetId]);
  return { ...publication, enabled, excluded, toggle };
}

/** Series header control: which model classifies this series automatically. */
export function S36SeriesControl({ seriesId, seriesName, disabled, onChanged, readiness, api = s36PublicationApi }: { seriesId: string; seriesName: string; disabled?: boolean; onChanged?: () => void; readiness?: Map<string, S36Readiness>; api?: S36PublicationApi }) {
  const { settings, error, save } = useS36Publication(api);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Without the runtime settings (e.g. runtime not set up) the control stays out of the way.
  if (!settings) return error ? <small className="s36-series__error">{error}</small> : null;
  const s36 = settings.series.includes(seriesId);
  // Characters S36 does not classify here: the whole series if it uses B36, else the excluded ones.
  const waiting = [...(readiness?.values() ?? [])].filter(r => !s36 || settings.excludedTargets.includes(r.targetId));
  const readyCount = waiting.filter(r => r.status === "ready").length;
  const choose = (next: boolean) => {
    if (next === s36) return;
    const series = next ? [...settings.series, seriesId] : settings.series.filter(id => id !== seriesId);
    void save(series, settings.excludedTargets).then(onChanged);
  };
  async function clear() {
    setClearing(true); setMessage(null);
    try {
      const count = await api.clear(seriesId);
      setMessage(count ? `S36이 넣은 자동 분류 ${count.toLocaleString()}건을 해제했습니다.` : "해제할 S36 자동 분류가 없습니다.");
      onChanged?.();
    } catch (e) {
      setMessage(commandErrorMessage(e, "S36 자동 분류를 해제하지 못했습니다."));
    } finally {
      setClearing(false); setConfirming(false);
    }
  }
  return <div className="s36-series">
    <fieldset className="s36-series__choice" role="radiogroup" aria-label="자동 분류 방식">
      <span className="s36-series__label">자동 분류</span>
      {([["기존", false], ["S36", true]] as const).map(([label, value]) => <label key={label}>
        <input type="radio" name={`s36-series-${seriesId}`} checked={s36 === value} disabled={disabled} onChange={() => choose(value)} />
        <span>{label}</span>
      </label>)}
    </fieldset>
    {s36 && <Button size="sm" variant="ghost" disabled={disabled || clearing} onClick={() => setConfirming(true)}>S36 자동 분류 해제</Button>}
    {readyCount > 0 && <small className="s36-series__ready" role="status">{s36 ? `제외한 캐릭터 중 ${readyCount}명은 S36을 켜도 됩니다` : `S36 켜도 되는 캐릭터 ${readyCount}명`}</small>}
    {s36 && !settings.scoringEnabled && <S36ScoringWarning disabled={disabled} onChanged={onChanged} />}
    {(message || error) && <small className="s36-series__message" role="status">{message || error}</small>}
    {confirming && <Dialog open title="S36 자동 분류 해제" onClose={() => { if (!clearing) setConfirming(false); }}>
      <p>{seriesName}에서 S36이 자동으로 넣고 아직 아무도 확인하지 않은 분류를 모두 해제합니다. 직접 판단한 것과 기존 분류기가 넣은 것은 그대로 둡니다.</p>
      <div className="dialog-actions">
        <Button variant="ghost" disabled={clearing} onClick={() => setConfirming(false)}>취소</Button>
        <Button variant="primary" disabled={clearing} onClick={() => void clear()}>{clearing ? "해제하는 중…" : "해제"}</Button>
      </div>
    </Dialog>}
  </div>;
}

/** Character control, meaningful only in an S36 series: leave this character to manual work. */
export function S36CharacterExclusion({ seriesId, targetId, disabled, api = s36PublicationApi }: { seriesId: string; targetId: string; disabled?: boolean; api?: S36PublicationApi }) {
  const { error, enabled, excluded, toggle } = useS36CharacterExclusion(seriesId, targetId, api);
  if (!enabled) return null;
  return <label className="s36-exclusion">
    <input type="checkbox" checked={excluded} disabled={disabled} aria-description="이 캐릭터는 S36 자동 분류 대신 직접 확인과 추천만 사용합니다" onChange={toggle} />
    <span>S36 제외{error && <small role="status">{error}</small>}</span>
  </label>;
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

/** Short card line for a character that S36 does not classify yet. */
export function readinessLabel(r: S36Readiness): string {
  switch (r.status) {
    case "ready": return `S36 켜도 됨 · 확인 ${r.reviewed} · 틀림 ${r.wrong}`;
    case "hold": return `S36 보류 · 확인 ${r.reviewed} · 틀림 ${r.wrong}`;
    case "keep": return `S36 부적합 · 확인 ${r.reviewed} · 틀림 ${r.wrong}`;
    default: return `S36 준비 중 · 확인 ${Math.min(r.reviewed, READY_REVIEWED)}/${READY_REVIEWED} · 예시 ${Math.min(r.examples, READY_EXAMPLES)}/${READY_EXAMPLES}`;
  }
}
