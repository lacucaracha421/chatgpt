/**
 * The 자동 태그 filter of the 에셋 screen, shared by the inspector chips, the 찾기 palette and
 * the header badges. It narrows whatever asset view is open and stays until cleared.
 */
import { useSyncExternalStore } from "react";
import type { AutoTagFilter } from "./types";

/** Included plus excluded tags; mirrors `MAX_FILTER_TAGS` in `library/auto_tags.rs`. */
export const MAX_AUTO_TAG_FILTERS = 8;
const EMPTY: AutoTagFilter = { include: [], exclude: [] };

let current: AutoTagFilter = EMPTY;
const listeners = new Set<() => void>();

function publish(next: AutoTagFilter) {
  current = next.include.length || next.exclude.length ? next : EMPTY;
  listeners.forEach((listener) => listener());
}

export function getAutoTagFilter() {
  return current;
}

export function subscribeAutoTagFilter(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAutoTagFilter() {
  return useSyncExternalStore(subscribeAutoTagFilter, getAutoTagFilter, getAutoTagFilter);
}

/** Adds the tag (or moves it to `mode`). False when the filter is already full. */
export function applyAutoTagFilter(tag: string, mode: "include" | "exclude" = "include") {
  const include = current.include.filter((entry) => entry !== tag);
  const exclude = current.exclude.filter((entry) => entry !== tag);
  if (include.length + exclude.length >= MAX_AUTO_TAG_FILTERS) return false;
  (mode === "include" ? include : exclude).push(tag);
  publish({ include, exclude });
  return true;
}

export function toggleAutoTagFilterMode(tag: string) {
  if (current.include.includes(tag)) applyAutoTagFilter(tag, "exclude");
  else if (current.exclude.includes(tag)) applyAutoTagFilter(tag, "include");
}

export function removeAutoTagFilter(tag: string) {
  publish({ include: current.include.filter((entry) => entry !== tag), exclude: current.exclude.filter((entry) => entry !== tag) });
}

export function clearAutoTagFilter() {
  publish(EMPTY);
}

export function hasAutoTagFilter(filter: AutoTagFilter) {
  return filter.include.length > 0 || filter.exclude.length > 0;
}
