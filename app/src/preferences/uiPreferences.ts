import type { AssetSort, CollectionType } from "../library/types";
import { clampSidebarWidth } from "../layout/sidebarWidth";

export const UI_PREFERENCES_KEY = "lakomics.uiPreferences.v1";

export type UiPreferences = {
  metadataVisible: boolean;
  privacyMode: boolean;
  sidebarWidth: number;
  expandedClassificationIds: string[];
  expandedAlbumIds: string[];
  assetSort: AssetSort;
  thumbnailRowHeight: number;
  creatorCardSize: number;
  collectionType: CollectionType;
};

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  metadataVisible: true,
  privacyMode: false,
  sidebarWidth: 208,
  expandedClassificationIds: [],
  expandedAlbumIds: [],
  assetSort: "newest",
  thumbnailRowHeight: 180,
  creatorCardSize: 200,
  collectionType: "manga",
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
    privacyMode:
      typeof value.privacyMode === "boolean"
        ? value.privacyMode
        : DEFAULT_UI_PREFERENCES.privacyMode,
    sidebarWidth:
      typeof value.sidebarWidth === "number" && Number.isFinite(value.sidebarWidth)
        ? clampSidebarWidth(value.sidebarWidth)
        : DEFAULT_UI_PREFERENCES.sidebarWidth,
    expandedClassificationIds: Array.isArray(value.expandedClassificationIds)
      ? [...new Set(value.expandedClassificationIds.filter(isString))]
      : DEFAULT_UI_PREFERENCES.expandedClassificationIds,
    expandedAlbumIds: Array.isArray(value.expandedAlbumIds)
      ? [...new Set(value.expandedAlbumIds.filter(isString))]
      : DEFAULT_UI_PREFERENCES.expandedAlbumIds,
    assetSort: isAssetSort(value.assetSort)
      ? value.assetSort
      : DEFAULT_UI_PREFERENCES.assetSort,
    thumbnailRowHeight:
      typeof value.thumbnailRowHeight === "number" && Number.isFinite(value.thumbnailRowHeight)
        ? Math.max(96, Math.min(320, value.thumbnailRowHeight))
        : DEFAULT_UI_PREFERENCES.thumbnailRowHeight,
    creatorCardSize:
      typeof value.creatorCardSize === "number" && Number.isFinite(value.creatorCardSize)
        ? Math.max(96, Math.min(320, value.creatorCardSize))
        : DEFAULT_UI_PREFERENCES.creatorCardSize,
    collectionType: isCollectionType(value.collectionType)
      ? value.collectionType
      : DEFAULT_UI_PREFERENCES.collectionType,
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

function isCollectionType(value: unknown): value is CollectionType {
  return value === "game" || value === "manga" || value === "movie";
}
