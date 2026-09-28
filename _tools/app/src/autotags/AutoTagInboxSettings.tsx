import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { Switch } from "../shared/ui/Switch";
import { autoTagInboxResult, getAutoTagInbox, runAutoTagInboxNow, setAutoTagInbox, type AutoTagInbox } from "./autoTagInbox";
import { invalidateAutoTagVocabulary } from "./autoTagVocabulary";

export function useAutoTagInbox(disabled: boolean) {
  const [settings, setSettings] = useState<AutoTagInbox | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => getAutoTagInbox().then(value => { if (active) setSettings(value); }).catch(reason => {
      if (active) setMessage({ text: commandErrorMessage(reason, "자동 가져오기 설정을 불러오지 못했습니다."), error: true });
    });
    void refresh();
    const unlisten = listen("library://auto-tag-inbox", () => { void refresh(); }).catch(() => () => undefined);
    return () => { active = false; void unlisten.then(stop => stop()).catch(() => undefined); };
  }, []);
  async function perform(work: () => Promise<void>) {
    if (busy || disabled) return;
    setBusy(true); setMessage(null);
    try { await work(); }
    catch (reason) { setMessage({ text: commandErrorMessage(reason, "자동 가져오기를 처리하지 못했습니다."), error: true }); }
    finally { setBusy(false); }
  }
  async function chooseFolder() {
    const folder = await open({ directory: true, multiple: false, title: "매일 자동 가져오기 폴더" });
    if (typeof folder === "string" && settings) setSettings(await setAutoTagInbox(folder, settings.applyTaggerReview));
  }
  async function runNow() {
    const result = await runAutoTagInboxNow();
    // Busy/restricted runs are skips, never an empty replacement for saved settings.
    setSettings(await getAutoTagInbox());
    if (result.processed.length) invalidateAutoTagVocabulary();
    setMessage({ text: result.skipped ?? (result.processed.length ? autoTagInboxResult(result.settings) : "새로 가져올 파일이 없습니다."), error: Object.values(result.settings.last ?? {}).some(last => last.error != null) });
  }
  const disable = () => perform(async () => { if (settings?.folder) setSettings(await setAutoTagInbox(null, settings.applyTaggerReview)); });
  const setApplyTaggerReview = (checked: boolean) => perform(async () => { if (settings) setSettings(await setAutoTagInbox(settings.folder, checked)); });
  return { settings, busy, message, locked: disabled || busy || !settings, chooseFolder: () => perform(chooseFolder), disable, runNow: () => perform(runNow), setApplyTaggerReview };
}

export function AutoTagInboxSettings({ disabled }: { disabled: boolean }) {
  const { settings, busy, message, locked, chooseFolder, disable, runNow, setApplyTaggerReview } = useAutoTagInbox(disabled);
  return <>
    <dl className="settings-view__property">
      <dt>매일 가져오기 폴더</dt>
      <dd className="settings-view__status settings-view__path">{settings ? settings.folder ?? "설정 안 됨" : "확인 중…"}</dd>
      <dd className="settings-view__inline-controls">
        <Button size="sm" disabled={locked} onClick={() => void chooseFolder()}>폴더 선택</Button>
        <Button size="sm" variant="quiet" disabled={locked || !settings?.folder} onClick={() => void disable()}>사용 안 함</Button>
      </dd>
    </dl>
    <dl className="settings-view__property">
      <dt>가져온 뒤 태거 판정 자동 반영</dt>
      <dd className="settings-view__inline-controls"><Switch disabled={locked} checked={settings?.applyTaggerReview ?? true} onChange={event => void setApplyTaggerReview(event.currentTarget.checked)} aria-label="가져온 뒤 태거 판정 자동 반영" /></dd>
    </dl>
    <dl className="settings-view__property">
      <dt>최근 자동 가져오기</dt>
      {settings && <dd className="settings-view__status">{autoTagInboxResult(settings)}</dd>}
      <dd className="settings-view__inline-controls"><Button size="sm" variant="quiet" disabled={locked || !settings?.folder} onClick={() => void runNow()}>{busy ? "처리 중…" : "지금 가져오기"}</Button></dd>
    </dl>
    {message && <p className="settings-view__row-message" role={message.error ? "alert" : "status"}>{message.text}</p>}
  </>;
}
