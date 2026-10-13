import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { nativeWorkload } from "../app/workloadProfile";
import type { ActivityItem } from "./activityTimeline";

type Snapshot = { revision: number; jobs: ActivityItem[] };

/** Listen before reading, and reject an initial read overtaken by a newer event. */
export function useActivityRegistry() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ revision: -1, jobs: [] });
  useEffect(() => {
    if (!nativeWorkload()) return;
    let active = true;
    let stop: (() => void) | undefined;
    const receive = (next: Snapshot | null | undefined) => {
      if (active && next && Array.isArray(next.jobs)) setSnapshot(current => next.revision > current.revision ? next : current);
    };
    void listen<Snapshot>("library://activities-changed", event => receive(event.payload)).then(unlisten => {
      if (!active) { unlisten(); return; }
      stop = unlisten;
      return invoke<Snapshot>("activity_snapshot").then(receive);
    }).catch(() => undefined);
    return () => { active = false; stop?.(); };
  }, []);
  return snapshot.jobs;
}

export function dismissNativeActivity(id: string) {
  return invoke("dismiss_activity", { id });
}
