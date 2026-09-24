import type { CatalogLanguage, CatalogStatus, CatalogStreamStatus } from "./types";

export function catalogStreamStatus(status: CatalogStatus, language: CatalogLanguage): CatalogStreamStatus {
  const stream = status.streams?.find((candidate) => (
    candidate.provider === "kHentai" && candidate.language === language
  ));
  if (stream) return stream;

  if (language === "korean") {
    return {
      provider: "kHentai",
      language,
      hasState: status.lastAttemptAt !== null || status.lastSuccessAt !== null || status.lastError !== null,
      initialComplete: status.installed,
      watermark: 0,
      cursor: null,
      pendingMax: 0,
      lastAttemptAt: status.lastAttemptAt,
      lastProgressAt: status.lastSuccessAt,
      lastCompletedAt: status.lastSuccessAt,
      lastAdded: status.lastAdded,
      lastError: status.lastError,
    };
  }

  return {
    provider: "kHentai",
    language,
    hasState: false,
    initialComplete: false,
    watermark: 0,
    cursor: null,
    pendingMax: 0,
    lastAttemptAt: null,
    lastProgressAt: null,
    lastCompletedAt: null,
    lastAdded: 0,
    lastError: null,
  };
}

/** The newest completed catalog DB update across the legacy field and every stream. */
export function latestCatalogUpdate(status: CatalogStatus): string | null {
  const completed = [status.lastSuccessAt, ...(status.streams ?? []).map((stream) => stream.lastCompletedAt)]
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)));
  return completed.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
