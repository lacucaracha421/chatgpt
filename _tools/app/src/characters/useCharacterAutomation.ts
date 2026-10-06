import { workloadPollDelay, getWorkloadProfile } from "../app/workloadProfile";
import { isWindowFocused, subscribeWindowFocus, windowPollDelay } from "../app/windowFocus";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { commandErrorMessage } from "../library/errorMessage";

export type CharacterActiveWork = {
  active: boolean;
  seriesName: string | null;
  targetName: string | null;
  cause: string | null;
  freshRemaining: number;
};
export type CharacterRefreshProgress = {
  targetId: string;
  targetName: string;
  seriesName: string;
  state: "pending" | "running" | "failed" | "completed";
  total: number | null;
  processed: number;
  remaining: number;
  failed: number;
};

export type IncrementalStatus = {
  running: boolean;
  workActive: boolean;
  paused: boolean;
  completed: number;
  confirmed: number;
  historyRefreshActive: boolean;
  persistentError: string | null;
  activeWork?: CharacterActiveWork;
  historyRefreshes?: CharacterRefreshProgress[];
  /** Moves only when a character definition (targets, references, series, groups, folder exclusions) changes. */
  definitionRevision?: number;
  /** Automatic analysis results per series id since launch. */
  seriesRevisions?: Record<string, number>;
};

/** What one status poll found changed by the native owner. */
export type AutomaticCharacterChange = {
  /** New confirmed character memberships. */
  membershipChanged: boolean;
  /** Character definitions changed: the hub re-reads. */
  definitionsChanged: boolean;
  /** Series whose members or review state changed; null when the native status cannot tell. */
  series: string[] | null;
};

export type AutomaticCharacterApi = {
  status(): Promise<IncrementalStatus>;
  pause(paused: boolean): Promise<void>;
  setup?(): Promise<boolean | void>;
};

export type QuietCharacterAutomationState = {
  revision: number;
  persistentError: string | null;
  historyRefreshActive: boolean;
  paused: boolean;
  activeWork?: CharacterActiveWork | null;
  historyRefreshes?: CharacterRefreshProgress[];
  dismissError(): void;
  pauseHistoryRefresh(): void;
  resumeHistoryRefresh(): void;
  setupRuntime(): Promise<void>;
};

const defaultApi: AutomaticCharacterApi = {
  status: () => invoke("character_incremental_status"),
  pause: (paused) => invoke("pause_character_reference_refresh", { paused }),
  setup: () => invoke("setup_character_runtime"),
};

/** Flat records (primitive fields only) with the same fields and values. */
function sameRecord<T extends object>(left: T | null, right: T | null) {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length && keys.every(key => Object.is(left[key], right[key]));
}

function sameRefreshes(left: CharacterRefreshProgress[], right: CharacterRefreshProgress[]) {
  return left.length === right.length && left.every((item, index) => sameRecord(item, right[index]));
}

/** Quiet status/control only. Native mutations and the native owner discover all work. */
export function useCharacterAutomation(
  onChanged: (change: AutomaticCharacterChange) => void,
  api = defaultApi,
): QuietCharacterAutomationState {
  const [revision, setRevision] = useState(0);
  const [persistentError, setPersistentError] = useState<string | null>(null);
  const [historyRefreshActive, setHistoryRefreshActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [activeWork, setActiveWork] = useState<CharacterActiveWork | null>(null);
  const [historyRefreshes, setHistoryRefreshes] = useState<CharacterRefreshProgress[]>([]);
  const latest = useRef(onChanged);
  latest.current = onChanged;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let completed: number | null = null;
    let confirmed: number | null = null;
    let definitions: number | undefined;
    let seriesSeen: Record<string, number> = {};
    let interval = 5000;
    let polling = false;
    let noticedError = "";
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), windowPollDelay(
        workloadPollDelay(document.visibilityState === "hidden" ? 15000 : interval),
      ));
    };

    const publishError = (error: string | null) => {
      const next = error ?? "";
      if (next === noticedError) return;
      noticedError = next;
      setPersistentError(error);
    };

    async function poll() {
      if (!active || polling) return;
      if (getWorkloadProfile().hidden) { timer = setTimeout(() => void poll(), 60_000); return; }
      polling = true;
      clearTimeout(timer);
      try {
        const status = await api.status();
        if (!active) return;
        setPaused(status.paused);
        setHistoryRefreshActive(status.historyRefreshActive);
        // Each status read is a fresh IPC object: keep the current value when nothing changed,
        // so the 5 s idle poll does not re-render the whole workspace.
        const nextActiveWork = status.activeWork ?? null;
        setActiveWork(current => sameRecord(current, nextActiveWork) ? current : nextActiveWork);
        const nextRefreshes = status.historyRefreshes ?? [];
        setHistoryRefreshes(current => sameRefreshes(current, nextRefreshes) ? current : nextRefreshes);
        interval = status.workActive ? 1000 : 5000;
        // Per-image progress refreshes only the analysed series (their galleries and counts); the
        // character definitions re-read only when the native definition revision moves.
        const nextSeries = status.seriesRevisions;
        const changedSeries = nextSeries
          ? Object.keys(nextSeries).filter(id => nextSeries[id] !== (seriesSeen[id] ?? 0))
          : null;
        const definitionsChanged = completed !== null && definitions !== status.definitionRevision;
        if (completed !== null && (completed !== status.completed || definitionsChanged || (changedSeries?.length ?? 0) > 0)) {
          latest.current({
            membershipChanged: confirmed !== status.confirmed,
            // An older native status without the revision: every result may have changed anything.
            definitionsChanged: definitionsChanged || status.definitionRevision === undefined,
            series: changedSeries,
          });
          if (completed !== status.completed) setRevision((current) => current + 1);
        }
        definitions = status.definitionRevision;
        seriesSeen = nextSeries ?? {};
        publishError(
          status.persistentError
          ?? (!status.running ? "캐릭터 분석 환경 설정이 필요합니다." : null),
        );
        completed = status.completed;
        confirmed = status.confirmed;
      } catch (error) {
        if (active) {
          publishError(commandErrorMessage(error, "자동 분류 상태를 불러오지 못했습니다."));
        }
      } finally {
        polling = false;
      }
      if (active) {
        schedule();
      }
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    const unsubscribeFocus = subscribeWindowFocus(() => {
      if (isWindowFocused()) void poll();
      else schedule();
    });
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribeFocus();
      document.removeEventListener("visibilitychange", onVisible);
    }; // Navigation never cancels native work.
  }, [api]);

  const control = (value: boolean) => {
    void api.pause(value)
      .then(() => setPaused(value))
      .catch((error) => {
        setPersistentError(commandErrorMessage(error, "과거 이미지 갱신 상태 변경 실패"));
      });
  };

  const setupRuntime = async () => {
    try {
      if (!api.setup) throw new Error("분석 환경 설정을 사용할 수 없습니다.");
      const configured = await api.setup();
      if (configured === false) return;
      setPersistentError(null);
    } catch (error) {
      setPersistentError(commandErrorMessage(error, "분석 환경 설정 실패"));
    }
  };

  return {
    revision,
    persistentError,
    historyRefreshActive,
    paused,
    activeWork,
    historyRefreshes,
    dismissError: () => setPersistentError(null),
    pauseHistoryRefresh: () => control(true),
    resumeHistoryRefresh: () => control(false),
    setupRuntime,
  };
}
