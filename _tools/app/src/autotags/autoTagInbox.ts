import { invoke } from "@tauri-apps/api/core";

export type AutoTagInboxLast = {
  fileModified: string;
  fileSize: number;
  importedAt: string;
  imported: Record<string, number>;
  tagger: { veto: number; recommend: number } | null;
  error: string | null;
};
export type AutoTagInbox = {
  folder: string | null;
  applyTaggerReview: boolean;
  last: Record<string, AutoTagInboxLast> | null;
};
export type AutoTagInboxRun = { settings: AutoTagInbox; processed: string[]; skipped: string | null };
export const getAutoTagInbox = () => invoke<AutoTagInbox>("get_auto_tag_inbox");
export const setAutoTagInbox = (folder: string | null, applyTaggerReview: boolean) =>
  invoke<AutoTagInbox>("set_auto_tag_inbox", { folder, applyTaggerReview });
export const runAutoTagInboxNow = () => invoke<AutoTagInboxRun>("run_auto_tag_inbox_now");

export function autoTagInboxResult(settings: AutoTagInbox): string {
  const entries = Object.entries(settings.last ?? {});
  if (!entries.length) return "아직 자동으로 가져오지 않음";
  return entries.map(([name, last]) => {
    const date = new Date(last.importedAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const time = Number.isNaN(date.getTime()) ? last.importedAt : `${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const label = name === "auto-tags-latest.sqlite" ? "자동 태그" : "그림체";
    if (last.error) return `${time} ${label} 가져오기 실패 · ${last.error}`;
    const result = label === "자동 태그" ? "자동 태그 가져옴" : `그림체 ${(last.imported.imported ?? 0).toLocaleString("ko-KR")}장`;
    const tagger = last.tagger ? ` · 태거 판정 ${(last.tagger.veto + last.tagger.recommend).toLocaleString("ko-KR")}건 반영` : "";
    return `${time} ${result}${tagger}`;
  }).join(" · ");
}
