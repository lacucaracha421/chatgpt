import type { AssetSort } from "../library/types";

export const UI_PREFERENCES_KEY = "lakomics.uiPreferences.v1";

export type UiPreferences = {
  metadataVisible: boolean;
  sidebarWidth: number;
  expandedClassificationIds: string[];
  assetSort: AssetSort;
};

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  metadataVisible: true,
  sidebarWidth: 232,
  expandedClassificationIds: [],
  assetSort: "newest",
};

export function loadUiPreferences(storage: Storage = localStorage): UiPreferences {
  const stored = storage.getItem(UI_PREFERENCES_KEY);
  if (!stored) return DEFAULT_UI_PREFERENCES;

  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
  if (!isRecord(value)) return DEFAULT_UI_PREFERENCES;

  return {
    metadataVisible:
      typeof value.metadataVisible === "boolean"
        ? value.metadataVisible
        : DEFAULT_UI_PREFERENCES.metadataVisible,
    sidebarWidth:
      typeof value.sidebarWidth === "number" && Number.isFinite(value.sidebarWidth)
        ? Math.max(184, Math.min(360, value.sidebarWidth))
        : DEFAULT_UI_PREFERENCES.sidebarWidth,
    expandedClassificationIds: Array.isArray(value.expandedClassificationIds)
      ? [...new Set(value.expandedClassificationIds.filter(isString))]
      : DEFAULT_UI_PREFERENCES.expandedClassificationIds,
    assetSort: isAssetSort(value.assetSort)
      ? value.assetSort
      : DEFAULT_UI_PREFERENCES.assetSort,
  };
}

export function saveUiPreferences(
  value: UiPreferences,
  storage: Storage = localStorage,
): void {
  storage.setItem(UI_PREFERENCES_KEY, JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isAssetSort(value: unknown): value is AssetSort {
  return (
    value === "newest" ||
    value === "oldest" ||
    value === "favorites" ||
    value === "random"
  );
}
