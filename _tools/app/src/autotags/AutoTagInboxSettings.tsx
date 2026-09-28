import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { Toggle } from "../shared/ui/Toggle";
import { autoTagInboxResult, getAutoTagInbox, runAutoTagInboxNow, setAutoTagInbox, type AutoTagInbox } from "./autoTagInbox";
import { invalidateAutoTagVocabulary } from "./autoTagVocabulary";

export function AutoTagInboxSettings({ disabled }: { disabled: boolean }) {
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
  const locked = disabled || busy || !settings;
  return <dl className="settings-view__property">
    <dt>매일 자동 가져오기</dt>
    <dd className="settings-view__row-note">이 PC에서 라이브러리를 연 뒤 약 2분 후, 이후 한 시간마다 자동 태그와 그림체 파일을 확인합니다. 가벼운 모드에서는 쉽니다.</dd>
    <dd className="settings-view__path">{settings ? settings.folder ?? "폴더를 선택하면 자동 가져오기가 켜집니다." : "확인 중…"}</dd>
    <Button size="sm" disabled={locked} onClick={() => void perform(chooseFolder)}>폴더 선택</Button>
    <Button size="sm" disabled={locked || !settings?.folder} onClick={() => void perform(async () => { setSettings(await setAutoTagInbox(null, settings!.applyTaggerReview)); })}>사용 안 함</Button>
    <dd><Toggle disabled={locked} checked={settings?.applyTaggerReview ?? true} onChange={event => {
      const checked = event.currentTarget.checked;
      void perform(async () => { setSettings(await setAutoTagInbox(settings!.folder, checked)); });
    }}>가져온 뒤 태거 판정 자동 반영</Toggle></dd>
    <Button size="sm" disabled={locked || !settings?.folder} onClick={() => void perform(runNow)}>{busy ? "처리 중…" : "지금 가져오기"}</Button>
    {settings && <dd className="settings-view__path">{autoTagInboxResult(settings)}</dd>}
    {message && <dd className="settings-view__row-message" role={message.error ? "alert" : "status"}>{message.text}</dd>}
  </dl>;
}
