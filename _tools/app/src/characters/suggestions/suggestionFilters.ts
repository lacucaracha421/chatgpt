/** Browsing filters of the 새 캐릭터 제안 list, remembered on this device (like the other view options). */
export type SuggestionFilters = { minimum: number; insideOnly: boolean };

export const SUGGESTION_MINIMUMS = [1, 3, 5, 10, 20] as const;
export const DEFAULT_SUGGESTION_FILTERS: SuggestionFilters = { minimum: 5, insideOnly: false };
export const SUGGESTION_FILTERS_KEY = "lakomics.characterSuggestionFilters.v1";

export function readSuggestionFilters(): SuggestionFilters {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SUGGESTION_FILTERS_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return DEFAULT_SUGGESTION_FILTERS;
    const { minimum, insideOnly } = value as Record<string, unknown>;
    return {
      minimum: SUGGESTION_MINIMUMS.find(option => option === minimum) ?? DEFAULT_SUGGESTION_FILTERS.minimum,
      insideOnly: insideOnly === true,
    };
  } catch { return DEFAULT_SUGGESTION_FILTERS; }
}

export function writeSuggestionFilters(value: SuggestionFilters): void {
  try { localStorage.setItem(SUGGESTION_FILTERS_KEY, JSON.stringify(value)); } catch { /* Keep the session choice if storage is unavailable. */ }
}
