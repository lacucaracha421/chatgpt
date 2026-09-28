import { AutoTagInboxSettings } from "./AutoTagInboxSettings";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import { localDateTime } from "../assets/assetMetadata";
import { Button } from "../shared/ui/Button";
import { invalidateAutoTagVocabulary } from "./autoTagVocabulary";
import type { AutoTagImportSummary } from "./types";

function summaryText(summary: AutoTagImportSummary) {
  const parts = [
    `${summary.model} · ${localDateTime(summary.importedAt)}`,
    `에셋 ${summary.taggedAssets.toLocaleString("ko-KR")}개 · 태그 ${summary.tagRows.toLocaleString("ko-KR")}개`,
    summary.skippedAssets > 0 ? `라이브러리에 없는 에셋 ${summary.skippedAssets.toLocaleString("ko-KR")}개는 건너뜀` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Settings › 라이브러리 › 자동 태그: import a tagger output file and show the last import. */
export function AutoTagSettings({ disabled }: { disabled: boolean }) {
  const gateway = useLibrary().gateway.autoTags;
  const [summary, setSummary] = useState<AutoTagImportSummary | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    if (!gateway) return;
    void gateway.importSummary().then((next) => { if (active) setSummary(next); }).catch(() => { if (active) setSummary(null); });
    return () => { active = false; };
  }, [gateway]);

  if (!gateway) return null;

  async function importFile() {
    if (!gateway || busy || disabled) return;
    const selected = await open({ multiple: false, filters: [{ name: "자동 태그 파일", extensions: ["sqlite", "db"] }] });
    if (typeof selected !== "string") return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await gateway.importFile(selected);
      setSummary(result);
      invalidateAutoTagVocabulary();
      setMessage({ text: `가져왔습니다. ${summaryText(result)}`, error: false });
    } catch (reason) {
      setMessage({ text: commandErrorMessage(reason, "자동 태그 파일을 가져오지 못했습니다."), error: true });
    } finally {
      setBusy(false);
    }
  }

  return <><AutoTagInboxSettings disabled={disabled || busy} /><dl className="settings-view__property">
    <dt>자동 태그</dt>
    <dd className="settings-view__row-note">태거가 만든 자동 태그 파일을 가져옵니다. 이전 자동 태그를 바꾸고, 에셋에서 빼거나 직접 붙인 태그는 그대로 둡니다. 이 PC에만 저장합니다.</dd>
    <dd className="settings-view__path">{summary === undefined ? "확인 중…" : summary ? summaryText(summary) : "아직 가져오지 않음"}</dd>
    <Button size="sm" disabled={busy || disabled} onClick={() => void importFile()}>{busy ? "가져오는 중…" : "파일 가져오기"}</Button>
    {message && <dd className="settings-view__row-message" role={message.error ? "alert" : "status"}>{message.text}</dd>}
  </dl></>;
}
