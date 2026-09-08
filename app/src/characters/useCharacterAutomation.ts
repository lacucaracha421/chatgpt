import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { characterApi, type CharacterApi, type CharacterTarget, type ScanStatus } from "./api";
import type { CharacterSeries } from "./hubApi";
import { commandErrorMessage } from "../library/errorMessage";

export type AutomaticCharacterApi = CharacterApi & { applyAutomatic: (scanIds: string[]) => Promise<number> };
const defaultApi: AutomaticCharacterApi = { ...characterApi, applyAutomatic: scanIds => invoke("apply_automatic_characters", { scanIds }) };
const running = (s: ScanStatus) => s.state === "running" || s.state === "cancelling";

/** One app-owned queue survives navigation; imports coalesce behind the active batch. */
export function useCharacterAutomation(targets: CharacterTarget[], series: CharacterSeries[], refreshVersion: number, onChanged: () => void, api = defaultApi) {
  const [progress, setProgress] = useState<ScanStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [retry, setRetry] = useState(0);
  const active = useRef(true), requested = useRef(false), owned = useRef<string | null>(null), stopped = useRef(false);
  const latest = useRef({ targets, series, onChanged }); latest.current = { targets, series, onChanged };
  const signature = targets.filter(t => t.ready && series.some(s => s.classificationId === t.seriesClassificationId && s.autoClassify)).map(t => `${t.id}:${t.fingerprint}:${(t.learnedReferences ?? []).map(r => r.assetHash).join(",")}`).sort().join("|");
  useEffect(() => { requested.current = Boolean(signature); }, [signature, refreshVersion, retry]);
  useEffect(() => { stopped.current = paused; }, [paused]);
  useEffect(() => {
    active.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const wait = () => new Promise<void>(resolve => { timer = setTimeout(resolve, 500); });
    async function tick() {
      try {
        if (requested.current && !stopped.current) {
          const external = await api.runs();
          if (!active.current) return;
          if (!external.some(running)) {
            requested.current = false;
            if (!(await api.runtime())) {
              if (active.current) setMessage("캐릭터 자동 분류 · 분석 환경 설정 필요");
            } else {
              const initial = await api.targets();
              const eligible = initial.filter(t => t.ready && latest.current.series.some(s => s.autoClassify && s.classificationId === t.seriesClassificationId));
              const scanIds: string[] = [];
              let confirmed = 0;
              const failures: string[] = [];
              for (const target of eligible) {
                if (!active.current || stopped.current) break;
                if (!latest.current.series.some(s => s.autoClassify && s.classificationId === target.seriesClassificationId)) continue;
                try {
                  const scan = await api.start(target.id, target.fingerprint, true);
                  owned.current = scan.id;
                  if (!active.current || stopped.current) { await api.cancel(scan.id); break; }
                  setMessage(null); setProgress(scan);
                  for (;;) {
                    await wait();
                    if (!active.current || stopped.current) { await api.cancel(scan.id); break; }
                    const runs = await api.runs();
                    if (!active.current) return;
                    const status = runs.find(s => s.id === scan.id);
                    if (!status) throw new Error("분석 작업이 바뀌었습니다. 다시 시작해 주세요.");
                    setProgress(status);
                    if (status.state === "completed" || (status.state === "running" && status.completed > 0)) {
                      const count = await api.applyAutomatic([...scanIds, status.id]);
                      confirmed += count;
                      if (count && active.current) latest.current.onChanged();
                    }
                    if (!running(status)) {
                      if (status.state !== "completed") throw new Error(status.error ?? "캐릭터 분석이 중단되었습니다.");
                      scanIds.push(status.id); break;
                    }
                  }
                } catch (error) {
                  failures.push(`${target.displayName}: ${commandErrorMessage(error, "분석 실패")}`);
                  if (owned.current) await api.cancel(owned.current).catch(() => undefined);
                } finally { owned.current = null; }
              }
              if (active.current && !stopped.current && eligible.length > 0) {
                setMessage(failures.length
                  ? `캐릭터 자동 분류 · ${confirmed}건 확정 · ${failures.join(" / ")}`
                  : confirmed ? `캐릭터 자동 분류 · ${confirmed}건 확정` : "캐릭터 분석 완료 · 애매한 결과는 분석·검토에서 확인");
                if (!confirmed) latest.current.onChanged();
              }
              if (active.current) setProgress(null);
            }
          }
        }
      } catch (e) { if (active.current) { setMessage(commandErrorMessage(e, "캐릭터 자동 분류를 완료하지 못했습니다.")); setProgress(null); } }
      if (active.current) timer = setTimeout(() => void tick(), 1500);
    }
    timer = setTimeout(() => void tick(), 1500);
    return () => { active.current = false; clearTimeout(timer); if (owned.current) void api.cancel(owned.current).catch(() => undefined); };
  }, [api]);
  return { progress, message, paused, pause: () => { stopped.current = true; setPaused(true); if (owned.current) void api.cancel(owned.current).catch(e => setMessage(commandErrorMessage(e, "분석 취소에 실패했습니다."))); }, resume: () => { stopped.current = false; setPaused(false); setRetry(v => v + 1); }, dismiss: () => setMessage(null) };
}
