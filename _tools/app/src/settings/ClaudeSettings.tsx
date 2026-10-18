import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { workloadPollDelay } from "../app/workloadProfile";
import { commandErrorMessage } from "../library/errorMessage";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Select } from "../shared/ui/Select";
import { SettingsRow } from "../shared/ui/SettingsRow";
import { Switch } from "../shared/ui/Switch";
import { ClaudeMemberSettings } from "./ClaudeMemberSettings";
import { CredentialRow } from "./CredentialRow";

export type ClaudeState = "off" | "no_key" | "idle" | "running" | "capped" | "credential" | "error";
export type ClaudeStatus = {
  state: ClaudeState;
  done: number;
  total: number;
  spentUsd: number;
  capUsd: number;
  autoAccepted: number;
  autoRejected: number;
  leftForUser: number;
  lastRunAt: string | null;
};
type ClaudeSettingsValue = { enabled: boolean; monthlyCapUsd: number };

const CAP_CHOICES = [1, 2, 5, 10, 20, 50, 100];
const STATES: readonly string[] = ["off", "no_key", "idle", "running", "capped", "credential", "error"];
/** The busy text of a run appears only after this long, so a quick run never blinks. */
const BUSY_DELAY_MS = 400;

function isStatus(value: unknown): value is ClaudeStatus {
  const status = value as Partial<ClaudeStatus> | null | undefined;
  return !!status && typeof status.state === "string" && STATES.includes(status.state)
    && typeof status.spentUsd === "number" && typeof status.capUsd === "number";
}

function isSettings(value: unknown): value is ClaudeSettingsValue {
  const settings = value as Partial<ClaudeSettingsValue> | null | undefined;
  return !!settings && typeof settings.enabled === "boolean" && typeof settings.monthlyCapUsd === "number";
}

const dollars = (value: number) => `$${value.toFixed(2)}`;
const capLabel = (value: number) => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;

/** The text of a status that is not a running one; a running one wraps it in a busy label. */
function restingText(status: ClaudeStatus | null): { text: string; tone?: string } {
  if (!status) return { text: "" };
  switch (status.state) {
    case "off": return { text: "자동 판정이 꺼져 있습니다" };
    case "no_key": return { text: "API 키를 넣으면 시작할 수 있습니다" };
    case "capped": return { text: "이번 달 한도 도달" };
    case "credential": return { text: "API 키를 확인하세요", tone: "danger" };
    case "error": return { text: "연결하지 못했습니다. 잠시 뒤 다시 시도합니다", tone: "off" };
    default: return { text: `이번 달 자동 처리 ${(status.autoAccepted + status.autoRejected).toLocaleString("ko-KR")}건 · 확인 필요 ${status.leftForUser.toLocaleString("ko-KR")}건` };
  }
}

/** Settings 라이브러리 › Claude: the API key, the on/off switch, the monthly cap and one status line. */
export function ClaudeSettings({ disabled = false }: { disabled?: boolean }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<ClaudeSettingsValue | null>(null);
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  // The status follows the run; it keeps the last answer on screen while the next one is read.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let delay = 8_000;
      try {
        const next = await invoke<ClaudeStatus>("claude_status");
        if (!active) return;
        if (isStatus(next)) {
          setStatus(next);
          if (next.state === "running") delay = 2_000;
        }
      } catch { /* the next read tries again */ }
      if (active) timer = setTimeout(() => void tick(), workloadPollDelay(delay));
    };
    void tick();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void invoke<{ configured: boolean }>("claude_credential_status")
      .then(value => { if (active && typeof value?.configured === "boolean") setConfigured(value.configured); })
      .catch(reason => { if (active) setError(commandErrorMessage(reason, "Claude API 키 상태를 확인하지 못했습니다.")); });
    void invoke<ClaudeSettingsValue>("claude_settings")
      .then(value => { if (active && isSettings(value)) setSettings(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const saveKey = useCallback(async () => {
    const value = key.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("set_claude_credential", { key: value });
      setConfigured(true);
      setEditing(false);
      setKey("");
      setRefresh(count => count + 1);
    } catch (reason) {
      setError(commandErrorMessage(reason, "Claude API 키를 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }, [busy, key]);

  const deleteKey = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("delete_claude_credential");
      setConfigured(false);
      setConfirmingDelete(false);
      setRefresh(count => count + 1);
    } catch (reason) {
      setError(commandErrorMessage(reason, "Claude API 키를 삭제하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const change = useCallback(async (next: ClaudeSettingsValue) => {
    if (busy) return;
    const previous = settings;
    setSettings(next);
    setBusy(true);
    setError(null);
    try {
      const saved = await invoke<ClaudeSettingsValue>("set_claude_settings", { enabled: next.enabled, monthlyCapUsd: next.monthlyCapUsd });
      if (isSettings(saved)) setSettings(saved);
      setRefresh(count => count + 1);
    } catch (reason) {
      setSettings(previous);
      setError(commandErrorMessage(reason, "Claude 설정을 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }, [busy, settings]);

  const running = status?.state === "running";
  // While a run is on, the line shows its progress; what it replaces is the month's tally.
  const resting = restingText(running ? { ...status!, state: "idle" } : status);
  const capChoices = settings && !CAP_CHOICES.includes(settings.monthlyCapUsd) ? [...CAP_CHOICES, settings.monthlyCapUsd].sort((a, b) => a - b) : CAP_CHOICES;
  const ready = configured === true && settings !== null;

  return <div className="claude-settings" aria-busy={busy}>
    <CredentialRow
      name="Claude API 키"
      placeholder="API 키 (sk-ant-…)"
      configured={configured}
      editing={editing}
      value={key}
      busy={busy || disabled}
      onEdit={() => setEditing(true)}
      onChange={setKey}
      onSave={() => void saveKey()}
      onCancel={() => { setEditing(false); setKey(""); }}
      confirmDelete={confirmingDelete}
      onDelete={() => setConfirmingDelete(true)}
      onCancelDelete={() => setConfirmingDelete(false)}
      onConfirmDelete={() => void deleteKey()}
    />
    <ClaudeMemberSettings disabled={disabled || configured !== true} />
    <SettingsRow
      name="자동 판정"
      control={<Switch aria-label="자동 판정" checked={settings?.enabled ?? false} disabled={disabled || busy || !ready} onChange={event => settings && void change({ ...settings, enabled: event.target.checked })} />}
    />
    <SettingsRow
      name="월 한도"
      status={status ? `이번 달 ${dollars(status.spentUsd)} 사용` : undefined}
      control={<Select label="월 한도" value={String(settings?.monthlyCapUsd ?? 10)} disabled={disabled || busy || !ready} onChange={event => settings && void change({ ...settings, monthlyCapUsd: Number(event.target.value) })}>
        {capChoices.map(value => <option key={value} value={String(value)}>{capLabel(value)}</option>)}
      </Select>}
    />
    <SettingsRow
      name="상태"
      tone={resting.tone}
      status={status ? <BusyLabel busy={running} delay={BUSY_DELAY_MS} idle={resting.text}>{`처리 중 ${status.done.toLocaleString("ko-KR")} / ${status.total.toLocaleString("ko-KR")}`}</BusyLabel> : undefined}
    />
    {error && <p className="settings-view__row-message" role="alert">{error}</p>}
  </div>;
}
