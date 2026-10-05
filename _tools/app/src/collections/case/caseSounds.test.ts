import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseSoundClips, caseSoundSet, playCaseSound, preloadCaseSounds, resetCaseSoundsForTest } from "./caseSounds";
import { CASE_SOUNDS_KEY, setCaseSoundsEnabled } from "../../preferences/caseSoundPreference";

class FakeAudio {
  static made: FakeAudio[] = [];
  static played: string[] = [];
  static play: () => unknown = () => Promise.resolve();
  preload = ""; volume = 1; currentTime = 5;
  constructor(public src: string) { FakeAudio.made.push(this); }
  play() { FakeAudio.played.push(this.src); return FakeAudio.play(); }
}
const name = (url: string) => /([a-z]+-[a-z]+-\d+)\.mp3/.exec(url)?.[1];

beforeEach(() => {
  FakeAudio.made = []; FakeAudio.played = []; FakeAudio.play = () => Promise.resolve();
  vi.stubGlobal("Audio", FakeAudio);
  resetCaseSoundsForTest(); localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

describe("case sounds", () => {
  it("ships every recorded clip, in order", () => {
    expect(Object.fromEntries(Object.entries(caseSoundClips).map(([set, urls]) => [set, urls.map(name)]))).toEqual({
      "switch-open": ["switch-open-1", "switch-open-2", "switch-open-3"],
      "switch-close": [1, 2, 3, 4, 5, 6, 7].map(n => `switch-close-${n}`),
      "steel-open": ["steel-open-1", "steel-open-2", "steel-open-3"],
      "steel-close": ["steel-close-1", "steel-close-2"],
      "book-open": ["book-open-1", "book-open-2"],
    });
  });
  it("maps Switch and AV cases to the switch set, the rest to steelbooks, and books to an open only", () => {
    for (const platform of ["sw", "sw2", "av"] as const) expect([caseSoundSet(platform, "open"), caseSoundSet(platform, "close")]).toEqual(["switch-open", "switch-close"]);
    for (const platform of ["ps5", "pc", "other", "film"] as const) expect([caseSoundSet(platform, "open"), caseSoundSet(platform, "close")]).toEqual(["steel-open", "steel-close"]);
    expect([caseSoundSet("book", "open"), caseSoundSet("book", "close")]).toEqual(["book-open", null]);
    playCaseSound("book", "close");
    expect(FakeAudio.played).toEqual([]);
  });
  it("plays a random clip at 0.55 from the start, never the same clip twice in a row", () => {
    for (let index = 0; index < 60; index += 1) playCaseSound("sw", "close");
    const names = FakeAudio.played.map(name);
    expect(names.every((clip, index) => index === 0 || clip !== names[index - 1])).toBe(true);
    expect(new Set(names).size).toBeGreaterThan(3);
    expect(FakeAudio.made.every(audio => audio.volume === .55 && audio.preload === "auto")).toBe(true);
    expect(FakeAudio.made.every(audio => audio.currentTime === 0)).toBe(true);
    // Even a random source stuck on one value alternates within a two-clip set.
    for (let index = 0; index < 4; index += 1) playCaseSound("film", "close", () => 0);
    expect(FakeAudio.played.slice(-4).map(name)).toEqual(["steel-close-1", "steel-close-2", "steel-close-1", "steel-close-2"]);
  });
  it("reuses one element per clip and preloads a platform's clips only while sounds are on", () => {
    preloadCaseSounds("ps5");
    expect(FakeAudio.made.map(audio => name(audio.src)).sort()).toEqual(["steel-close-1", "steel-close-2", "steel-open-1", "steel-open-2", "steel-open-3"]);
    playCaseSound("ps5", "open", () => 0); playCaseSound("ps5", "open", () => .99);
    expect(FakeAudio.made).toHaveLength(5);
    resetCaseSoundsForTest(); FakeAudio.made = [];
    setCaseSoundsEnabled(false);
    preloadCaseSounds("book");
    expect(FakeAudio.made).toEqual([]);
  });
  it("is silent when the preference is off or the page is hidden", () => {
    expect(localStorage.getItem(CASE_SOUNDS_KEY)).toBeNull();
    setCaseSoundsEnabled(false);
    playCaseSound("sw", "open");
    expect(FakeAudio.played).toEqual([]);
    setCaseSoundsEnabled(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    playCaseSound("sw", "open");
    expect(FakeAudio.played).toEqual([]);
    vi.restoreAllMocks();
    playCaseSound("sw", "open");
    expect(FakeAudio.played).toHaveLength(1);
  });
  it("ignores a refused, throwing or missing play", async () => {
    FakeAudio.play = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
    expect(() => playCaseSound("pc", "open")).not.toThrow();
    FakeAudio.play = () => { throw new Error("no audio"); };
    expect(() => playCaseSound("pc", "open")).not.toThrow();
    FakeAudio.play = () => undefined;
    expect(() => playCaseSound("pc", "open")).not.toThrow();
    vi.stubGlobal("Audio", undefined);
    resetCaseSoundsForTest();
    expect(() => { playCaseSound("pc", "close"); preloadCaseSounds("pc"); }).not.toThrow();
    await Promise.resolve();
  });
});
