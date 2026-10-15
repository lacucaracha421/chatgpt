import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClassificationEntry } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { SeriesPicker } from "./SeriesPicker";
import "./RegistrationScope.css";

export type RegistrationMode = "manual" | "settings" | "folder" | "promotion" | "suggestion";
export type RegistrationPreview = { imageCount: number; otherSeries: boolean };
export type RegistrationScopeRequest = { seriesId: string; mode: RegistrationMode; referenceIds?: string[] };
export const registrationPreview = (request: RegistrationScopeRequest): Promise<RegistrationPreview> => invoke("character_registration_preview", { request });

/** Keeps the preview beside the action, with confirmation only for costly scopes. */
export function RegistrationScope({ request, entries, onSeriesSelected, children, loadPreview = registrationPreview, onPendingChange }: {
  request: RegistrationScopeRequest; entries: ClassificationEntry[];
  onSeriesSelected?: (entry: ClassificationEntry) => void;
  children: (guard: (save: () => void | Promise<void>) => void, pending: boolean) => React.ReactNode;
  loadPreview?: typeof registrationPreview;
  onPendingChange?: (pending: boolean) => void;
}) {
  const key = JSON.stringify(request);
  const [result, setResult] = useState<{ key: string; preview: RegistrationPreview; seriesName?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RegistrationPreview | null>(null);
  const [picking, setPicking] = useState(false);
  const work = useRef<(() => void | Promise<void>) | null>(null);
  const acting = useRef(false);
  const [checking, setChecking] = useState(false);
  const [retry, setRetry] = useState(0);
  const latestKey = useRef(key);
  latestKey.current = key;
  useEffect(() => { onPendingChange?.(checking); }, [checking, onPendingChange]);
  const series = entries.find(entry => entry.id === request.seriesId);
  const current = result?.preview;
  const loading = request.mode === "suggestion" && !!series && !series.isContainer && result?.key !== key;
  useEffect(() => {
    let live = true;
    setError(null); setConfirm(null); work.current = null;
    if (!series || series.isContainer || request.mode !== "suggestion") return;
    void loadPreview(request).then(preview => { if (live) setResult({ key, preview, seriesName: series.name }); }, reason => { if (live) setError(commandErrorMessage(reason, "등록 범위를 확인하지 못했습니다.")); });
    return () => { live = false; };
  }, [key, series?.isContainer, loadPreview, retry]);
  async function guard(save: () => void | Promise<void>) {
    if (acting.current) return;
    work.current = save;
    if (series?.isContainer) { setPicking(true); return; }
    acting.current = true; setChecking(true); setError(null);
    try {
      // Read again on submit: arrivals since opening must not bypass confirmation.
      const preview = await loadPreview(request);
      if (latestKey.current !== key) return;
      setResult({ key, preview, seriesName: series?.name });
      if (preview.imageCount > 0 && (preview.otherSeries || preview.imageCount >= 1000)) setConfirm(preview);
      else await save();
    } catch (reason) { setError(commandErrorMessage(reason, "등록 범위를 확인하지 못했습니다.")); }
    finally { acting.current = false; setChecking(false); }
  }
  async function accept() {
    if (acting.current) return;
    acting.current = true; setChecking(true);
    try { await work.current?.(); setConfirm(null); }
    catch (reason) { setError(commandErrorMessage(reason, "등록하지 못했습니다.")); }
    finally { acting.current = false; setChecking(false); }
  }
  const count = confirm?.imageCount.toLocaleString("ko-KR");
  return <>
    {current && current.imageCount > 0 && <p className="registration-scope__line">{result?.seriesName} 폴더 이미지 {current.imageCount.toLocaleString("ko-KR")}장을 다시 확인합니다</p>}
    {error && <p role="alert">{error} <Button size="sm" disabled={checking} onClick={() => setRetry(value => value + 1)}>다시 시도</Button></p>}
    {children(save => void guard(save), checking || loading)}
    {confirm && <Dialog open title="캐릭터 등록" onClose={() => { if (!checking) setConfirm(null); }}>
      <div className="registration-scope__hero"><strong>{count}<small>장</small></strong><span><b>{series?.name}</b> 폴더와 하위 폴더 이미지를 다시 확인합니다</span></div>
      <div className={`registration-scope__notice${confirm.otherSeries ? " registration-scope__notice--warning" : ""}`}>
        {confirm.otherSeries ? <><b>다른 시리즈가 범위에 들어 있습니다</b><p>하위 시리즈를 고르면 확인할 범위를 줄일 수 있습니다.</p></> : <><b>많은 이미지를 다시 확인합니다</b><p>작업 패널에서 멈출 수 있습니다.</p></>}
      </div>
      <div className="ui-dialog__actions"><Button variant="ghost" disabled={checking} onClick={() => setConfirm(null)}>취소</Button>
        {confirm.otherSeries ? <><Button variant="secondary" disabled={checking} onClick={() => void accept()}>그대로 등록</Button><Button variant="primary" disabled={checking || !onSeriesSelected} onClick={() => setPicking(true)}>하위 시리즈 고르기</Button></> : <Button variant="primary" disabled={checking} onClick={() => void accept()}><BusyLabel busy={checking} idle={`${count}장 확인하고 등록`}>등록 중…</BusyLabel></Button>}
      </div>
    </Dialog>}
    {picking && series && onSeriesSelected && <SeriesPicker parent={series} entries={entries} onClose={() => setPicking(false)} onSelected={entry => { setPicking(false); setConfirm(null); onSeriesSelected(entry); }} />}
  </>;
}
