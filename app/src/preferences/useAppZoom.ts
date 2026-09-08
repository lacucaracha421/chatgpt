import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";
import { normalizeAppZoom } from "./uiPreferences";

export function useAppZoom(percent: number) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    setError(null);
    void getCurrentWebview().setZoom(normalizeAppZoom(percent) / 100).catch(() => {
      if (active) setError("화면 배율을 적용하지 못했습니다. 앱을 다시 실행한 후 시도해 주세요.");
    });
    return () => { active = false; };
  }, [percent]);
  return error;
}
