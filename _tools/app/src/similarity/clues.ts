import type { AssetSummary, SimilarityDecision } from "../library/types";

export type AccountRole = "artist" | "unknown" | "reposter";
export type ClueSideKey = "a" | "b";
export type ClueKey = "account" | "posted" | "resolution" | "bytes";
export type Clues = Record<ClueKey, ClueSideKey | null>;
export type ClueSideData = {
  handle: string | null; host: string | null; role: AccountRole; postedAt: string | null;
  width: number | null; height: number | null; byteSize: number | null; format: string;
};
export const EMPTY_CLUES: Clues = { account: null, posted: null, resolution: null, bytes: null };
export const CLUE_ROWS = [["account", "계정"], ["posted", "게시"], ["resolution", "해상도"], ["bytes", "크기"]] as const;
export const ROLE_LABELS = { artist: "작가", reposter: "퍼온 계정", unknown: "알 수 없음" };
export const SIMILARITY_CHOICES: {decision: SimilarityDecision; label: string; saved: string; moved: string}[] = [
  {decision: "keep_existing", label: "A 유지 · B 휴지통", saved: "A 유지 · B 휴지통으로 저장", moved: "A 유지 · B 휴지통으로 보냄"},
  {decision: "replace_existing", label: "B 유지 · A 휴지통", saved: "B 유지 · A 휴지통으로 저장", moved: "B 유지 · A 휴지통으로 보냄"},
  {decision: "keep_both", label: "둘 다 보관", saved: "둘 다 보관으로 저장", moved: "둘 다 보관으로 정리"},
];
export const sideNames = (historical: boolean): [string, string] => historical ? ["A", "B"] : ["기존 이미지", "새 이미지"];
export function choiceLabel(decision: SimilarityDecision, historical: boolean): string {
  return historical ? SIMILARITY_CHOICES.find(c => c.decision === decision)!.label
    : ({ keep_existing: "기존 이미지 유지", replace_existing: "새 이미지로 교체", keep_both: "둘 다 보관" })[decision];
}
export function sourceHost(value: string | null): string | null {
  try { return new URL(value ?? "").hostname.replace(/^www\./, ""); } catch { return null; }
}
export function assetClueSide(asset: AssetSummary, role: AccountRole = "unknown", format: string): ClueSideData {
  const host = sourceHost(asset.sourceUrl);
  const handle = host && ["x.com", "twitter.com", "mobile.twitter.com"].includes(host) && asset.creatorHandle
    ? `@${asset.creatorHandle.replace(/^@/, "")}` : null;
  return { handle, host, role, postedAt: asset.sourcePublishedAt, width: asset.width, height: asset.height, byteSize: asset.byteSize, format };
}
export function reasonSentence(reason: ClueKey | null, clues: Clues, names: [string,string], sides: [ClueSideData,ClueSideData]): string {
  const favoured = reason && clues[reason];
  if (!favoured) return "단서가 같거나 없어 권장하지 않습니다.";
  const index = favoured === "a" ? 0 : 1;
  const who = names[index];
  switch (reason) {
    case "account": return sides[index].role === "artist" ? `작가 계정에 올라온 ${who}를 권장합니다.` : `퍼온 계정이 아닌 ${who}를 권장합니다.`;
    case "posted": return `먼저 올라온 ${who}를 권장합니다.`;
    case "resolution": return sides[0].handle && sides[0].handle.toLowerCase() === sides[1].handle?.toLowerCase()
      ? `같은 계정이라 해상도가 더 큰 ${who}를 권장합니다.` : `해상도가 더 큰 ${who}를 권장합니다.`;
    case "bytes": return `파일이 더 큰 ${who}를 권장합니다.`;
    default: return "단서가 같거나 없어 권장하지 않습니다.";
  }
}
