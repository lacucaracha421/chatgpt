import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { FolderSearchPicker } from "../classification/FolderSearchPicker";
import { useOptionalLibrary } from "../library/LibraryContext";
import type { ClassificationEntry } from "../library/types";
import { workloadPollDelay } from "../app/workloadProfile";
import { commandErrorMessage } from "../library/errorMessage";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { SettingsRow } from "../shared/ui/SettingsRow";
import { Switch } from "../shared/ui/Switch";
import { TextInput } from "../shared/ui/TextInput";

type MemberStatus = {
  state: string; planId: string | null; buckets: [number, number, number]; knownBuckets?: [number, number, number];
  estimateLowUsd: number; estimateHighUsd: number;
  total: number; done: number; failed: number;
  capUsd: number; spentUsd: number; reservedUsd: number; remainingUsd: number;
  ongoingEnabled: boolean; ongoingUntilCutoff: boolean;
};
type ExcludedFolder = { id: string; path: string };
const usd = (v: number) => `$${v.toFixed(2)}`;
const count = (v: number) => v.toLocaleString("ko-KR");
// Of each bucket: images without any character, and images that already have one accepted character.
const split = (status: MemberStatus, index: number) => {
  const one = status.knownBuckets?.[index] ?? 0;
  return `캐릭터 없음 ${count(status.buckets[index] - one)}장 · 한 명 지정 ${count(one)}장`;
};
const labels: Record<string, string> = {
  idle: "시작 전", draft: "시작 전", running: "진행", paused: "일시 정지", cancelled: "취소됨",
  completed: "완료", capped: "분석 한도 도달", no_key: "API 키를 넣어 주세요", credential: "API 키를 확인하세요",
  error: "요청 실패 · 다시 시작할 수 있습니다",
};

export function ClaudeMemberSettings({ disabled }: { disabled: boolean }) {
  const [status, setStatus] = useState<MemberStatus | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<MemberStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const library = useOptionalLibrary();
  const [excluded, setExcluded] = useState<ExcludedFolder[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [folders, setFolders] = useState<ClassificationEntry[] | null>(null);
  useEffect(() => {
    let active = true;
    invoke<ExcludedFolder[]>("claude_member_excluded_folders").then(
      next => { if (active && Array.isArray(next)) setExcluded(next); },
      reason => { if (active) setError(commandErrorMessage(reason, "제외한 폴더를 불러오지 못했습니다.")); },
    );
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!pickerOpen || folders || !library) return;
    let active = true;
    library.gateway.listClassifications().then(
      next => { if (active) setFolders(next); },
      reason => { if (active) { setFolders([]); setError(commandErrorMessage(reason, "폴더를 불러오지 못했습니다.")); } },
    );
    return () => { active = false; };
  }, [pickerOpen, folders, library]);
  const excludedIds = useMemo(() => new Set(excluded?.map(folder => folder.id)), [excluded]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let delay = 8_000;
      try {
        const next = await invoke<MemberStatus>("claude_member_status");
        if (active && typeof next?.state === "string") {
          setStatus(next);
          if (next.state === "running") delay = 2_000;
        }
      } catch (reason) {
        if (active) setError(commandErrorMessage(reason, "분석 상태를 확인하지 못했습니다."));
      }
      if (active) timer = setTimeout(() => void tick(), workloadPollDelay(delay));
    };
    void tick();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);

  const control = async (action: string, extras: { capUsd?: number; ongoingEnabled?: boolean; planId?: string | null } = {}) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await invoke<MemberStatus>("claude_member_control", { action, ...extras });
      setStatus(saved); setRefresh(v => v + 1);
      if (action === "start") setConfirm(null);
      if (extras.capUsd !== undefined) setCap(null);
    } catch (reason) { setError(commandErrorMessage(reason, "분석 설정을 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  };
  const preview = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const next = await invoke<MemberStatus>("claude_member_plan");
      setStatus(next); setConfirm(next);
    } catch (reason) { setError(commandErrorMessage(reason, "분석 대상을 확인하지 못했습니다.")); }
    finally { setBusy(false); }
  };
  const saveExcluded = async (ids: string[]) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await invoke<ExcludedFolder[]>("claude_member_set_excluded_folders", { ids });
      setExcluded(saved);
    } catch (reason) { setError(commandErrorMessage(reason, "제외할 폴더를 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  };
  const blocked = disabled || busy || !status;
  const canResume = status && ["paused", "capped", "error", "no_key", "credential"].includes(status.state);
  const capValue = cap ?? String(status?.capUsd ?? 45);
  const validCap = capValue.trim() !== "" && Number.isFinite(Number(capValue)) && Number(capValue) >= 0 && Number(capValue) <= 100_000;
  return <>
    <SettingsRow name="미분류 일괄 분석" status={status && `${labels[status.state] ?? status.state} · ${count(status.done)} / ${count(status.total)}장${status.failed ? ` · 실패 ${count(status.failed)}장` : ""}`}
      control={<>
        {(!status || ["idle", "draft", "completed", "cancelled"].includes(status.state)) && <Button disabled={blocked} onClick={() => void preview()}><BusyLabel busy={busy} idle={status && ["completed", "cancelled"].includes(status.state) ? "새 대상 확인" : "대상 확인"}>확인 중</BusyLabel></Button>}
        {status?.state === "running" && <Button disabled={blocked} onClick={() => void control("pause")}>일시 정지</Button>}
        {canResume && <Button disabled={blocked} onClick={() => void control("resume")}>다시 시작</Button>}
        {status && !["idle", "draft", "completed", "cancelled"].includes(status.state) && <Button disabled={blocked} onClick={() => void control("cancel")}>실행 취소</Button>}
      </>} />
    <SettingsRow name="분석 한도 ($)" status={status && `사용 ${usd(status.spentUsd)} · 남음 ${usd(status.remainingUsd)}${status.reservedUsd ? ` · 응답 미확인 예약 ${usd(status.reservedUsd)}` : ""}`}
      control={<>
        <TextInput aria-label="분석 한도 ($)" type="number" min={0} max={100_000} step="1" value={capValue} disabled={blocked} onChange={e => setCap(e.target.value)} />
        <Button aria-label="분석 한도 저장" disabled={blocked || cap === null || !validCap} onClick={() => void control("settings", { capUsd: Number(capValue) })}>저장</Button>
      </>} />
    <SettingsRow name="신규 이미지 자동 분석" status={status?.ongoingUntilCutoff ? "2026.10.26까지 · 이후 자동 꺼짐" : "예비 · 월 한도 사용"}
      control={<Switch aria-label="신규 이미지 자동 분석" checked={status?.ongoingEnabled ?? false} disabled={blocked} onChange={e => void control("settings", { ongoingEnabled: e.target.checked })} />} />
    <SettingsRow name="분석에서 제외할 폴더" status="이 폴더와 하위 폴더의 이미지는 캐릭터 분석에 보내지 않습니다."
      control={<Button disabled={blocked || !excluded} onClick={() => setPickerOpen(open => !open)}>{pickerOpen ? "닫기" : "추가"}</Button>} />
    {excluded && excluded.length > 0 && <ul className="settings-view__chips" aria-label="분석에서 제외한 폴더">
      {excluded.map(folder => <li key={folder.id} className="settings-view__chip">
        <span>{folder.path}</span>
        <button type="button" aria-label={`${folder.path} 제외 해제`} disabled={blocked} onClick={() => void saveExcluded(excluded.filter(item => item.id !== folder.id).map(item => item.id))}><XMarkIcon aria-hidden="true" /></button>
      </li>)}
    </ul>}
    {pickerOpen && <FolderSearchPicker folders={library ? folders : []} hiddenIds={excludedIds} pending={blocked}
      onPick={id => void saveExcluded([...(excluded ?? []).map(folder => folder.id), id])} />}
    <Dialog open={confirm !== null} title="미분류 이미지 분석" onClose={() => { if (!busy) setConfirm(null); }}>
      {confirm && <>
        <SettingsRow name="2–5명 시리즈" value={`${count(confirm.buckets[0])}장`} status={`${split(confirm, 0)} · Sonnet · 확신도 90% 이상 자동 지정`} />
        <SettingsRow name="6–15명 시리즈" value={`${count(confirm.buckets[1])}장`} status={`${split(confirm, 1)} · Haiku → 필요 시 Sonnet · 확인 목록에 추천`} />
        <SettingsRow name="16명 이상 시리즈" value={`${count(confirm.buckets[2])}장`} status={`${split(confirm, 2)} · Haiku → 필요 시 Sonnet · 확인 목록에 추천`} />
        <SettingsRow name="예상 비용" value={`${usd(confirm.estimateLowUsd)}–${usd(confirm.estimateHighUsd)}`} status={`실험 단가 기준 · 분석 한도 ${usd(status?.capUsd ?? confirm.capUsd)}`} />
        <p>일치하는 캐릭터가 없으면 그대로 둡니다. 한 명 지정 이미지는 이미 지정된 캐릭터를 건드리지 않고 추가로 있는 캐릭터만 찾습니다.</p>
        {error && <p className="settings-view__row-message" role="alert">{error}</p>}
        <div className="settings-view__actions">
          <Button disabled={busy} onClick={() => setConfirm(null)}>닫기</Button>
          <Button variant="primary" disabled={blocked || confirm.total === 0} onClick={() => void control("start", { planId: confirm.planId })}><BusyLabel busy={busy} idle="분석 시작">시작 중</BusyLabel></Button>
        </div>
      </>}
    </Dialog>
    {error && !confirm && <p className="settings-view__row-message" role="alert">{error}</p>}
  </>;
}
