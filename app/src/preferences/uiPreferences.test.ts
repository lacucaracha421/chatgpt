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
  });

  it("saves preferences for a later load", () => {
    const localStorage = storage();
    const value = {
      metadataVisible: false,
      sidebarWidth: 240,
      expandedClassificationIds: ["a"],
      assetSort: "oldest" as const,
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
      sidebarWidth: 240,
      expandedClassificationIds: ["a"],
      assetSort: "newest",
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
      sidebarWidth: 360,
      expandedClassificationIds: ["a"],
      assetSort: "random",
    });
  });
});
