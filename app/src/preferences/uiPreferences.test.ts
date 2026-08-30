import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_PREFERENCES,
  loadUiPreferences,
  saveUiPreferences,
  UI_PREFERENCES_KEY,
} from "./uiPreferences";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe("UI preferences", () => {
  it("loads defaults when no preferences are stored", () => {
    expect(loadUiPreferences(storage())).toEqual(DEFAULT_UI_PREFERENCES);
    expect(DEFAULT_UI_PREFERENCES.sidebarWidth).toBe(208);
  });

  it("saves preferences for a later load", () => {
    const localStorage = storage();
    const value = {
      metadataVisible: false,
      privacyMode: false,
      sidebarWidth: 240,
      expandedClassificationIds: ["a"],
      expandedAlbumIds: ["album-a"],
      assetSort: "oldest" as const,
      thumbnailRowHeight: 220,
      creatorCardSize: 240,
      collectionType: "manga" as const,
    };

    saveUiPreferences(value, localStorage);

    expect(loadUiPreferences(localStorage)).toEqual(value);
  });

  it("uses defaults when stored JSON is malformed", () => {
    const localStorage = storage();
    localStorage.setItem(UI_PREFERENCES_KEY, "{");

    expect(loadUiPreferences(localStorage)).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it("falls back only an invalid sort field", () => {
    const localStorage = storage();
    localStorage.setItem(
      UI_PREFERENCES_KEY,
      JSON.stringify({
        metadataVisible: false,
        sidebarWidth: 240,
        expandedClassificationIds: ["a"],
        assetSort: "name",
      }),
    );

    expect(loadUiPreferences(localStorage)).toEqual({
      metadataVisible: false,
      privacyMode: false,
      sidebarWidth: 240,
      expandedClassificationIds: ["a"],
      expandedAlbumIds: [],
      assetSort: "newest",
      thumbnailRowHeight: 180,
      creatorCardSize: 200,
      collectionType: "manga",
    });
  });

  it("clamps width and removes invalid or duplicate classification IDs", () => {
    const localStorage = storage();
    localStorage.setItem(
      UI_PREFERENCES_KEY,
      JSON.stringify({
        metadataVisible: false,
        sidebarWidth: 999,
        expandedClassificationIds: ["a", "a", 3],
        assetSort: "random",
      }),
    );

    expect(loadUiPreferences(localStorage)).toEqual({
      metadataVisible: false,
      privacyMode: false,
      sidebarWidth: 320,
      expandedClassificationIds: ["a"],
      expandedAlbumIds: [],
      assetSort: "random",
      thumbnailRowHeight: 180,
      creatorCardSize: 200,
      collectionType: "manga",
    });
  });

  it("restores privacy mode and replaces an invalid value with false", () => {
    const localStorage = storage();
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ privacyMode: true }));
    expect(loadUiPreferences(localStorage).privacyMode).toBe(true);

    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ privacyMode: "on" }));
    expect(loadUiPreferences(localStorage).privacyMode).toBe(false);
  });

  it("clamps sidebar width to the compact resize range", () => {
    const localStorage = storage();
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ sidebarWidth: 100 }));
    expect(loadUiPreferences(localStorage).sidebarWidth).toBe(176);

    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ sidebarWidth: 400 }));
    expect(loadUiPreferences(localStorage).sidebarWidth).toBe(320);
  });

  it("migrates a missing thumbnail height and clamps stored values", () => {
    const localStorage = storage();
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ thumbnailRowHeight: 999 }));
    expect(loadUiPreferences(localStorage).thumbnailRowHeight).toBe(320);

    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ thumbnailRowHeight: 40 }));
    expect(loadUiPreferences(localStorage).thumbnailRowHeight).toBe(96);
  });

  it("migrates a missing creator card size and clamps stored values", () => {
    const localStorage = storage();
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ creatorCardSize: 999 }));
    expect(loadUiPreferences(localStorage).creatorCardSize).toBe(320);

    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ creatorCardSize: 40 }));
    expect(loadUiPreferences(localStorage).creatorCardSize).toBe(96);
  });

  it("restores a valid collection type and replaces an invalid one with manga", () => {
    const localStorage = storage();
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ collectionType: "movie" }));
    expect(loadUiPreferences(localStorage).collectionType).toBe("movie");

    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ collectionType: "gacha" }));
    expect(loadUiPreferences(localStorage).collectionType).toBe("manga");
  });
});
