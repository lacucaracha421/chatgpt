import type { CasePlatform } from "./CollectionCase";
import { caseSoundsEnabled } from "../../preferences/caseSoundPreference";

/**
 * The user's own recorded case sounds (2026-10-05): mono 48 kHz mp3s whose click lands ~30 ms after the start.
 * The 책장 pull-out and put-back sounds (user, 2026-10-18) are cut from the user's recordings as 16-bit wavs, levelled to the open
 * clicks: 넣기 lands its click 400 ms in (the put-back is 440 ms), 빼기 starts on its first sound.
 * Vite emits them as assets in both the PC and the tablet build; the glob keeps the sets in step with the folder.
 */
const FILES = import.meta.glob<string>("./sounds/*.{mp3,wav}", { eager: true, import: "default" });
export type CaseMove = "open" | "close";
export type ShelfMove = "out" | "in";
export type CaseSoundSet = "switch-open" | "switch-close" | "steel-open" | "steel-close" | "book-open" | "shelf-out" | "shelf-in";
/** Time from the start of each clip to its click, so a sound can be started that much before the lid lands. */
export const CASE_SOUND_ATTACK_MS = 30;
const VOLUME = .55;

function clips(set: CaseSoundSet): string[] {
  const number = (path: string) => Number(/-(\d+)\.(?:mp3|wav)$/.exec(path)?.[1] ?? 0);
  return Object.keys(FILES).filter(path => path.startsWith(`./sounds/${set}-`)).sort((left, right) => number(left) - number(right)).map(path => FILES[path]!);
}
const SETS: Record<CaseSoundSet, string[]> = {
  "switch-open": clips("switch-open"), "switch-close": clips("switch-close"),
  "steel-open": clips("steel-open"), "steel-close": clips("steel-close"), "book-open": clips("book-open"),
  "shelf-out": clips("shelf-out"), "shelf-in": clips("shelf-in"),
};

/** Switch cartridge cases (and AV, user 2026-10-05) click like a Switch case; PS, Steam, Xbox and films are steelbooks; a book only opens. */
export function caseSoundSet(platform: CasePlatform, move: CaseMove): CaseSoundSet | null {
  if (platform === "book") return move === "open" ? "book-open" : null;
  return `${platform === "sw" || platform === "sw2" || platform === "av" ? "switch" : "steel"}-${move}`;
}

const players = new Map<string, HTMLAudioElement>();
const lastPlayed = new Map<CaseSoundSet, number>();
function player(url: string) {
  let audio = players.get(url);
  if (!audio) { audio = new Audio(url); audio.preload = "auto"; audio.volume = VOLUME; players.set(url, audio); }
  return audio;
}

/** Creates (and so starts loading) a platform's clips before the first click, so that click is not late. */
export function preloadCaseSounds(platform: CasePlatform): void {
  try {
    if (!caseSoundsEnabled()) return;
    for (const move of ["open", "close"] as const) { const set = caseSoundSet(platform, move); if (set) SETS[set].forEach(player); }
  } catch { /* Sound is decoration; a missing Audio never breaks the case. */ }
}

/** Plays a random clip of the set, never the one it played last, unless sounds are off or the page is hidden. */
export function playCaseSound(platform: CasePlatform, move: CaseMove, random: () => number = Math.random): void {
  const set = caseSoundSet(platform, move);
  if (set) playSet(set, random);
}

/** A case taken off (`out`) or put back on (`in`) the games and AV 책장. */
export function playShelfSound(move: ShelfMove, random: () => number = Math.random): void {
  playSet(`shelf-${move}`, random);
}

/** Loads the 책장 clips with the shelf, so the first pull is not late. */
export function preloadShelfSounds(): void {
  try { if (caseSoundsEnabled()) [...SETS["shelf-out"], ...SETS["shelf-in"]].forEach(player); } catch { /* Sound is decoration. */ }
}

function playSet(set: CaseSoundSet, random: () => number): void {
  try {
    if (!caseSoundsEnabled() || document.hidden) return;
    const urls = SETS[set]; if (!urls.length) return;
    const previous = lastPlayed.get(set);
    let index = Math.min(urls.length - 1, Math.floor(random() * (previous === undefined || urls.length < 2 ? urls.length : urls.length - 1)));
    if (previous !== undefined && urls.length > 1 && index >= previous) index += 1;
    lastPlayed.set(set, index);
    const audio = player(urls[index]!);
    audio.currentTime = 0;
    void Promise.resolve(audio.play()).catch(() => undefined);
  } catch { /* A refused or failed play is ignored. */ }
}

/** Tests start from an empty cache and no last clip. */
export function resetCaseSoundsForTest(): void { players.clear(); lastPlayed.clear(); }
export const caseSoundClips = SETS;
