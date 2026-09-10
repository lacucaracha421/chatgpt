import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ScanStatus } from "./api";
import { commandErrorMessage } from "../library/errorMessage";

export type IncrementalStatus = { running: boolean; paused: boolean; pending: number; pendingAutomatic: number; pendingLegacy: number; pendingManual: number; pendingReconsideration: number; completed: number; confirmed: number; activeAssetId: string | null; activeSeriesName: string | null; activeTargetName: string | null; activeTargetIndex: number; activeReconsideration: boolean; activeCause: string | null; total: number; compared: number; error: string | null };
export type AutomaticCharacterApi = { status(): Promise<IncrementalStatus>; pause(paused: boolean): Promise<void> };
const defaultApi: AutomaticCharacterApi = {
  status: () => invoke("character_incremental_status"),
  pause: paused => invoke("pause_character_incremental", { paused }),
};

/** Status/control only. Native mutations and the native owner discover all work. */
export function useCharacterAutomation(onChanged: (membershipChanged: boolean) => void, api = defaultApi) {
  const [progress, setProgress] = useState<ScanStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [queuePending, setQueuePending] = useState(0);
  const [queueAutomatic, setQueueAutomatic] = useState(0);
  const [queueLegacy, setQueueLegacy] = useState(0);
  const [queueManual, setQueueManual] = useState(0);
  const [queueReconsideration, setQueueReconsideration] = useState(0);
  const [activeCause, setActiveCause] = useState<string | null>(null);
  const [activeSeriesName, setActiveSeriesName] = useState<string | null>(null);
  const [activeTargetName, setActiveTargetName] = useState<string | null>(null);
  const [activeTargetIndex, setActiveTargetIndex] = useState(0);
  const [activeReconsideration, setActiveReconsideration] = useState(false);
  const [transient, setTransient] = useState(false);
  const latest = useRef(onChanged); latest.current = onChanged;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let completed: number | null = null;
    let confirmed: number | null = null;
    let interval = 5000;
    let polling = false;
    let notice = "";
    async function poll() {
      if (!active || polling) return;
      polling = true;
      clearTimeout(timer);
      try {
        const status = await api.status();
        if (!active) return;
        setPaused(status.paused);
        setQueuePending(status.pending);
        setQueueAutomatic(status.pendingAutomatic);
        setQueueLegacy(status.pendingLegacy);
        setQueueManual(status.pendingManual);
        setQueueReconsideration(status.pendingReconsideration);
        setActiveCause(status.activeCause);
        setActiveSeriesName(status.activeSeriesName);
        setActiveTargetName(status.activeTargetName);
        setActiveTargetIndex(status.activeTargetIndex);
        setActiveReconsideration(status.activeReconsideration);
        const nextProgress: ScanStatus | null = status.activeAssetId ? {
          id: status.activeAssetId, targetId: "", targetFingerprint: "", runtimeFingerprint: status.total ? "native" : null,
          state: "running", total: status.total, completed: status.compared, errors: 0, cacheHits: 0, extractions: 0, error: null,
        } : null;
        setProgress(previous => JSON.stringify(previous) === JSON.stringify(nextProgress) ? previous : nextProgress);
        interval = status.activeAssetId || (status.pending > 0 && !status.paused) ? 1000 : 5000;
        if (completed !== null && completed !== status.completed) latest.current(confirmed !== status.confirmed);
        const stamp = `${status.error ?? ""}:${status.completed}:${status.running}`;
        if (stamp !== notice) {
          notice = stamp;
          const finished = completed !== null && completed !== status.completed;
          setTransient(!status.error && status.running);
          setMessage(status.error ? commandErrorMessage(status.error, "캐릭터 분석 실패")
            : !status.running ? "캐릭터 자동 분류 · 분석 환경 설정 필요"
            : finished ? "캐릭터 분석 완료 · 결과는 분석·검토에서 확인" : null);
        }
        completed = status.completed;
        confirmed = status.confirmed;
      } catch (error) {
        if (active) { setTransient(false); setMessage(commandErrorMessage(error, "자동 분류 상태를 불러오지 못했습니다.")); }
      }
      finally { polling = false; }
      if (active) timer = setTimeout(() => void poll(), document.visibilityState === "hidden" ? 15000 : interval);
    }
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    void poll();
    return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); }; // Navigation never cancels native work.
  }, [api]);
  useEffect(() => {
    if (!message || !transient || progress || paused) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message, transient, progress, paused]);
  const control = (value: boolean) => {
    void api.pause(value).then(() => setPaused(value)).catch(error => {
      setTransient(false); setMessage(commandErrorMessage(error, "자동 분류 상태 변경 실패"));
    });
  };
  return { progress, message, paused, queuePending, queueAutomatic, queueLegacy, queueManual, queueReconsideration, activeCause, activeSeriesName, activeTargetName, activeTargetIndex, activeReconsideration, pause: () => control(true), resume: () => control(false), dismiss: () => setMessage(null) };
}
