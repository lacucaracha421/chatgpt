import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { commandErrorMessage } from "../library/errorMessage";

export type IncrementalStatus = {
  running: boolean;
  workActive: boolean;
  paused: boolean;
  completed: number;
  confirmed: number;
  historyRefreshActive: boolean;
  persistentError: string | null;
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

/** Quiet status/control only. Native mutations and the native owner discover all work. */
export function useCharacterAutomation(
  onChanged: (membershipChanged: boolean) => void,
  api = defaultApi,
): QuietCharacterAutomationState {
  const [revision, setRevision] = useState(0);
  const [persistentError, setPersistentError] = useState<string | null>(null);
  const [historyRefreshActive, setHistoryRefreshActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const latest = useRef(onChanged);
  latest.current = onChanged;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let completed: number | null = null;
    let confirmed: number | null = null;
    let interval = 5000;
    let polling = false;
    let noticedError = "";

    const publishError = (error: string | null) => {
      const next = error ?? "";
      if (next === noticedError) return;
      noticedError = next;
      setPersistentError(error);
    };

    async function poll() {
      if (!active || polling) return;
      polling = true;
      clearTimeout(timer);
      try {
        const status = await api.status();
        if (!active) return;
        setPaused(status.paused);
        setHistoryRefreshActive(status.historyRefreshActive);
        interval = status.workActive && !status.paused ? 1000 : 5000;
        if (completed !== null && completed !== status.completed) {
          latest.current(confirmed !== status.confirmed);
          setRevision((current) => current + 1);
        }
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
        timer = setTimeout(
          () => void poll(),
          document.visibilityState === "hidden" ? 15000 : interval,
        );
      }
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
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
    dismissError: () => setPersistentError(null),
    pauseHistoryRefresh: () => control(true),
    resumeHistoryRefresh: () => control(false),
    setupRuntime,
  };
}
