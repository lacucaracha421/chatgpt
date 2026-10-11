import type { CharacterTarget } from "../characters/api";
import { READY_EXAMPLES, READY_REVIEWED, type S36PublicationSettings, type S36Readiness } from "../characters/S36Publication";
import type { ShadowReviewSummary, ShadowVerdictCounts } from "../characters/shadowReviewApi";

/** Wrong answers a character may have collected before 학습 인식 steps back: 5% of its judgments, at least one. */
export const allowedWrong = (judged: number) => Math.max(1, Math.floor(judged * 0.05));

export type RecognitionInUse = "기본 인식" | "학습 인식" | "수동";
export type RecognitionRow = {
  targetId: string;
  name: string;
  recognition: RecognitionInUse;
  /** 확인에서 판단한 학습 인식 후보 (the readiness count of reviewed automatic candidates). */
  judged: number;
  /** 맞음 예시. */
  examples: number;
  wrong: number;
  allowed: number;
  /** Whether the numbers are still short of the 학습 인식 line (30 판단, 50 예시). */
  collecting: boolean;
};
export type RecognitionSeries = { seriesId: string; seriesName: string; rows: RecognitionRow[]; learning: number };

/** Which recognition places the character's images now: 학습 인식 in a series switched to it (unless the character is excluded). */
function inUse(target: CharacterTarget, settings: S36PublicationSettings | null): RecognitionInUse {
  if (!target.enabled || target.manualOnly) return "수동";
  const seriesId = target.seriesClassificationId;
  return seriesId && settings?.series.includes(seriesId) && !settings.excludedTargets.includes(target.id) ? "학습 인식" : "기본 인식";
}

/** Characters grouped by series, each with its 판단 / 예시 / 틀림 numbers; busiest series first. */
export function recognitionSeries(
  targets: readonly CharacterTarget[],
  readiness: ReadonlyMap<string, S36Readiness>,
  settings: S36PublicationSettings | null,
  seriesName: (id: string) => string | undefined,
): RecognitionSeries[] {
  const bySeries = new Map<string, RecognitionSeries>();
  for (const target of targets) {
    if (target.role === "extras" || !target.seriesClassificationId) continue;
    const seriesId = target.seriesClassificationId;
    let series = bySeries.get(seriesId);
    if (!series) bySeries.set(seriesId, series = { seriesId, seriesName: seriesName(seriesId) ?? "시리즈 없음", rows: [], learning: 0 });
    const numbers = readiness.get(target.id);
    const judged = numbers?.reviewed ?? 0, examples = numbers?.examples ?? 0, wrong = numbers?.wrong ?? 0;
    const recognition = inUse(target, settings);
    series.rows.push({ targetId: target.id, name: target.displayName, recognition, judged, examples, wrong, allowed: allowedWrong(judged),
      collecting: judged < READY_REVIEWED || examples < READY_EXAMPLES });
    if (recognition === "학습 인식") series.learning += 1;
  }
  const result = [...bySeries.values()];
  for (const series of result) series.rows.sort((a, b) => b.judged - a.judged || b.examples - a.examples || a.name.localeCompare(b.name, "ko"));
  return result.sort((a, b) => b.learning - a.learning || b.rows.reduce((sum, row) => sum + row.judged, 0) - a.rows.reduce((sum, row) => sum + row.judged, 0) || a.seriesName.localeCompare(b.seriesName, "ko"));
}

export type AccuracyRow = { label: string; judged: number; accepted: number; percent: number | null };
const accuracy = (label: string, counts: ShadowVerdictCounts | undefined): AccuracyRow => {
  const accepted = counts?.accepted ?? 0, judged = accepted + (counts?.rejected ?? 0);
  return { label, judged, accepted, percent: judged > 0 ? Math.round((accepted / judged) * 100) : null };
};

/** The overall table: how often the people's 확인 agreed with each kind of suggestion. */
export function accuracyRows(candidates: ShadowReviewSummary | null, doubtful: ShadowReviewSummary | null): AccuracyRow[] {
  return [
    accuracy("자동 후보", candidates?.automatic),
    accuracy("추천 후보", candidates?.recommended),
    accuracy("학습 인식이 넣은 것 다시 봄", doubtful?.doubtful),
  ];
}
