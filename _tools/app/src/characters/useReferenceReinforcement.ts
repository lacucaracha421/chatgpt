import { useEffect, useRef, useState } from "react";
import type { CharacterApi, ReferenceReinforcement, ReinforcementRun } from "./api";

export type ReferenceReinforcementState = {
  /** What the PC added on its own and the user has not yet seen resolved; null when nothing is pending. */
  run: ReinforcementRun | null;
  ghosts: ReferenceReinforcement["ghosts"];
  /** Forget the pending run after it was undone: the line leaves without a refetch. */
  dismissRun: () => void;
};

const NOTHING: ReferenceReinforcementState = { run: null, ghosts: [], dismissRun: () => {} };

// The last answer per character for this session: a reopened panel paints its suggestion tiles at once
// (no late tiles growing the panel and reflowing the strip) and refreshes them quietly.
const lastReads = new Map<string, ReferenceReinforcement>();

/**
 * Reads the quiet reinforcement of one character while its info panel is open, and tells the
 * host the user has seen the pending run once that panel is saved or closed.
 *
 * Reading fails quietly: without an answer there is simply no line and no suggestion tiles.
 * The acknowledgement is sent once per run and its errors are ignored.
 */
export function useReferenceReinforcement(targetId: string | null, api: Pick<CharacterApi, "referenceReinforcement" | "acknowledgeReferenceReinforcement">): ReferenceReinforcementState {
  const [read, setRead] = useState<{ targetId: string; data: ReferenceReinforcement; dismissed: boolean } | null>(null);
  const latest = useRef(api);
  latest.current = api;
  const shown = useRef<{ targetId: string; runId: string } | null>(null);
  const acknowledged = useRef(new Set<string>());
  const read_ = api.referenceReinforcement;

  useEffect(() => {
    if (!targetId || !latest.current.referenceReinforcement) return;
    let active = true;
    void latest.current.referenceReinforcement(targetId).then(data => {
      if (!active) return;
      lastReads.set(targetId, data);
      setRead({ targetId, data, dismissed: false });
      if (data.pendingRun) shown.current = { targetId, runId: data.pendingRun.runId };
    }, () => {});
    return () => {
      active = false;
      // Saved or closed after the line was shown: the run counts as seen, once.
      const seen = shown.current;
      shown.current = null;
      if (seen && seen.targetId === targetId && !acknowledged.current.has(seen.runId)) {
        acknowledged.current.add(seen.runId);
        void Promise.resolve(latest.current.acknowledgeReferenceReinforcement?.(seen.targetId, seen.runId)).catch(() => {});
      }
    };
  }, [targetId, Boolean(read_)]);

  if (!targetId) return NOTHING;
  const current = read && read.targetId === targetId ? read : lastReads.has(targetId) ? { targetId, data: lastReads.get(targetId)!, dismissed: false } : null;
  if (!current) return NOTHING;
  return {
    run: current.dismissed ? null : current.data.pendingRun,
    ghosts: current.data.ghosts,
    dismissRun: () => {
      shown.current = null;
      const cached = lastReads.get(targetId);
      if (cached) lastReads.set(targetId, { ...cached, pendingRun: null });
      setRead(old => old && old.targetId === targetId ? { ...old, dismissed: true } : old);
    },
  };
}
