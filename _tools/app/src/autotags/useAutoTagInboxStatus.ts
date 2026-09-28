import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { nativeWorkload } from "../app/workloadProfile";
import { invalidateAutoTagVocabulary } from "./autoTagVocabulary";

export type AutoTagInboxStatus = { message: string; error: boolean };
/** The shell owns this listener, so a nightly run is visible with Settings closed. */
export function useAutoTagInboxStatus() {
  const [status, setStatus] = useState<AutoTagInboxStatus | null>(null);
  useEffect(() => {
    if (!nativeWorkload()) return;
    let active = true;
    const unlisten = listen<AutoTagInboxStatus>("library://auto-tag-inbox", ({ payload }) => {
      if (active) { setStatus(payload); invalidateAutoTagVocabulary(); }
    }).catch(() => () => undefined);
    return () => { active = false; void unlisten.then(stop => stop()).catch(() => undefined); };
  }, []);
  return { status, dismiss: () => setStatus(null) };
}
