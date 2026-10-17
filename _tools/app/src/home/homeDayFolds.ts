import { useCallback, useState } from "react";

/** Which day-panel lists (모든 구독, 사고 싶은 것) are open. A per-device preference: all closed until opened. */
export const DAY_FOLDS_KEY = "lakomics.home.dayFolds.v1";
export type DayFold = "subscriptions" | "wishes";
export type DayFolds = Record<DayFold, boolean>;

const read = (): DayFolds => {
  try {
    const saved = JSON.parse(localStorage.getItem(DAY_FOLDS_KEY) ?? "null");
    return { subscriptions: saved?.subscriptions === true, wishes: saved?.wishes === true };
  } catch { return { subscriptions: false, wishes: false }; }
};

export function useDayFolds() {
  const [folds, setFolds] = useState(read);
  const toggle = useCallback((fold: DayFold) => setFolds(previous => {
    const next = { ...previous, [fold]: !previous[fold] };
    try { localStorage.setItem(DAY_FOLDS_KEY, JSON.stringify(next)); } catch { /* Storage can be unavailable. */ }
    return next;
  }), []);
  return [folds, toggle] as const;
}
