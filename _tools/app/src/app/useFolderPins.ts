import { useCallback, useEffect, useRef } from "react";
import type { LibraryGateway } from "../library/types";
import { subscribeWindowFocus, windowPollDelay } from "./windowFocus";

/**
 * Folder pins ("폴더 고정") are shared with the tablet: the server owns the list and merges per-id
 * commands. This hook keeps the PC's local preference as the cache the sidebar always renders
 * from, sends local edits as commands, and takes over the server's list when it differs.
 */
export type FolderPinCommand = { op: "add" | "remove" | "order"; ids: string[] };
export type FolderPinsReply = { version: 1; revision: number; pinnedIds: string[] };

export const FOLDER_PINS_PENDING_KEY = "lakomics.folderPins.pending.v1";
const POLL_MS = 60_000;

/** The commands that turn `previous` into `next` on the server. */
export function pinCommands(previous: string[], next: string[]): FolderPinCommand[] {
  const before = new Set(previous), after = new Set(next);
  const commands: FolderPinCommand[] = [];
  const removed = previous.filter(id => !after.has(id));
  const added = next.filter(id => !before.has(id));
  if (removed.length) commands.push({ op: "remove", ids: removed });
  if (added.length) commands.push({ op: "add", ids: added });
  const kept = previous.filter(id => after.has(id));
  // Added pins land at the end, so only a different order of the kept ones needs an order command.
  if (kept.some((id, index) => next[index] !== id)) commands.push({ op: "order", ids: next });
  return commands;
}

function readPending(): FolderPinCommand[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FOLDER_PINS_PENDING_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is FolderPinCommand =>
      !!entry && typeof entry.op === "string" && Array.isArray(entry.ids)) : [];
  } catch { return []; }
}

function writePending(commands: FolderPinCommand[]) {
  try {
    if (commands.length) localStorage.setItem(FOLDER_PINS_PENDING_KEY, JSON.stringify(commands));
    else localStorage.removeItem(FOLDER_PINS_PENDING_KEY);
  } catch { /* The in-memory queue still holds the edits for this session. */ }
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Returns the function the sidebar calls with its new pin list. Without a gateway that can
 * reach the server (browser preview, tests, sync not configured) pins stay purely local.
 */
export function useFolderPins(gateway: LibraryGateway, libraryRoot: string, pinnedIds: string[],
  setPinnedIds: (ids: string[]) => void): (next: string[]) => void {
  const latest = useRef({ pinnedIds, setPinnedIds });
  latest.current = { pinnedIds, setPinnedIds };
  const pending = useRef<FolderPinCommand[] | null>(null);
  const edits = useRef(0);
  const running = useRef<Promise<void> | null>(null);
  const rerun = useRef(false);
  const available = !!gateway.folderPins && !!gateway.changeFolderPins;

  const sync = useCallback((): Promise<void> => {
    if (!gateway.folderPins || !gateway.changeFolderPins) return Promise.resolve();
    if (running.current) { rerun.current = true; return running.current; }
    const job = (async () => {
      do {
        rerun.current = false;
        const seen = edits.current;
        try {
          if (pending.current === null) pending.current = readPending();
          let reply: FolderPinsReply;
          if (pending.current.length) {
            const sent = pending.current.length;
            reply = await gateway.changeFolderPins!(pending.current);
            pending.current = pending.current.slice(sent);
            writePending(pending.current);
          } else {
            reply = await gateway.folderPins!();
            // The list was never written on the server: this PC's own pins become the shared list once.
            if (reply.revision === 0 && latest.current.pinnedIds.length && edits.current === seen) {
              reply = await gateway.changeFolderPins!([{ op: "add", ids: latest.current.pinnedIds }]);
            }
          }
          // An edit made during the request is still queued or in flight; its own round adopts the result.
          if (edits.current === seen && !pending.current.length && !sameIds(reply.pinnedIds, latest.current.pinnedIds)) {
            latest.current.setPinnedIds(reply.pinnedIds);
          }
        } catch { /* Offline or not configured: the local list keeps working and the edits stay queued. */ }
      } while (rerun.current);
    })().finally(() => { running.current = null; });
    running.current = job;
    return job;
  }, [gateway]);

  useEffect(() => {
    if (!available) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      void sync().finally(() => { if (!stopped) timer = setTimeout(tick, windowPollDelay(POLL_MS)); });
    };
    tick();
    const stopFocus = subscribeWindowFocus(() => { if (document.hasFocus()) tick(); });
    window.addEventListener("online", tick);
    return () => { stopped = true; if (timer) clearTimeout(timer); stopFocus(); window.removeEventListener("online", tick); };
  }, [available, sync, libraryRoot]);

  return useCallback((next: string[]) => {
    const commands = pinCommands(latest.current.pinnedIds, next);
    latest.current.pinnedIds = next;
    latest.current.setPinnedIds(next);
    if (!available || !commands.length) return;
    edits.current += 1;
    pending.current = [...(pending.current ?? readPending()), ...commands];
    writePending(pending.current);
    void sync();
  }, [available, sync]);
}
