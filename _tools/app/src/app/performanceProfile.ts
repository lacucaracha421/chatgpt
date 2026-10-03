import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export type MachinePerformance = "laptop" | "main";
type Status = { selected: MachinePerformance; active: MachinePerformance; budgets: { liveBookFps: number; inboxSuccessSeconds: number } };
type State = Status & { ready: boolean; error: string | null };
let state: State = { selected: "laptop", active: "laptop", budgets: { liveBookFps: 30, inboxSuccessSeconds: 3600 }, ready: false, error: null };
const subscribers = new Set<() => void>();
let loading: Promise<void> | null = null;
function publish(next: State) { state = next; subscribers.forEach(listener => listener()); }
export function getPerformanceProfile() { return state; }
export function loadPerformanceProfile() {
  if (!("__TAURI_INTERNALS__" in window)) return Promise.resolve();
  loading ??= invoke<Status>("performance_profile").then(
    result => { publish({ ...result, ready: true, error: null }); },
    () => { loading = null; publish({ ...state, error: "이 컴퓨터의 성능 설정을 불러오지 못했습니다." }); },
  );
  return loading;
}
export function usePerformanceProfile() {
  const value = useSyncExternalStore(listener => { subscribers.add(listener); return () => { subscribers.delete(listener); }; }, getPerformanceProfile);
  useEffect(() => { void loadPerformanceProfile(); }, []);
  return value;
}
export async function updatePerformanceProfile(profile: MachinePerformance) {
  try {
    const result = await invoke<Status>("performance_profile", { profile });
    publish({ ...result, ready: true, error: null });
  } catch { publish({ ...state, error: "이 컴퓨터의 성능 설정을 저장하지 못했습니다." }); }
}
