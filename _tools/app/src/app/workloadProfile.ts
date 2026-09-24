import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type WorkloadSettings = { lightweight: boolean; autoEnterMinutes: number | null; closeToTray: boolean };
export type WorkloadProfile = WorkloadSettings & { restricted: boolean; hidden: boolean; trayAvailable: boolean; ready: boolean; error: string | null };
export const nativeWorkload = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
let profile: WorkloadProfile = { lightweight: false, autoEnterMinutes: null, closeToTray: true, restricted: nativeWorkload(), hidden: false, trayAvailable: false, ready: !nativeWorkload(), error: null };
const subscribers = new Set<() => void>();
let started = false;
function publish(next: WorkloadProfile) { profile = next; subscribers.forEach(fn => fn()); }
function accept(next: Omit<WorkloadProfile, "ready" | "error">) { publish({ ...next, ready: true, error: null }); }
async function start() {
  if (started || !nativeWorkload()) return;
  started = true;
  try {
    let received = false;
    await listen<Omit<WorkloadProfile, "ready" | "error">>("workload://changed", ({ payload }) => { received = true; accept(payload); });
    await listen<string>("workload://error", ({ payload }) => publish({ ...profile, error: payload }));
    const initial = await invoke<Omit<WorkloadProfile, "ready" | "error">>("workload_profile");
    if (!received) accept(initial);
  } catch { publish({ ...profile, error: "가벼운 모드 설정을 불러오지 못했습니다." }); }
}
export function getWorkloadProfile() { return profile; }
export function useWorkloadProfile() {
  const value = useSyncExternalStore(listener => { subscribers.add(listener); return () => { subscribers.delete(listener); }; }, getWorkloadProfile);
  useEffect(() => { void start(); }, []);
  return value;
}
let saving: Promise<void> = Promise.resolve();
export function updateWorkloadSettings(patch: Partial<WorkloadSettings>) {
  saving = saving.then(() => saveSettings(patch));
  return saving;
}
async function saveSettings(patch: Partial<WorkloadSettings>) {
  const { lightweight, autoEnterMinutes, closeToTray } = profile;
  try {
    accept(await invoke<Omit<WorkloadProfile, "ready" | "error">>("workload_profile", { settings: { lightweight, autoEnterMinutes, closeToTray, ...patch } }));
  } catch { publish({ ...profile, error: "가벼운 모드 설정을 저장하지 못했습니다." }); }
}
export function workloadPollDelay(normal: number, value = profile) { return value.restricted || value.hidden ? Math.max(60_000, normal) : normal; }
