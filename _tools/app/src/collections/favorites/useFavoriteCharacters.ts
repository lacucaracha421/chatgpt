import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { subscribeWindowFocus, windowPollDelay } from "../../app/windowFocus";
import { cloudCommandRefused, commandErrorMessage } from "../../library/errorMessage";
import type { FavoriteCharacters, FavoriteCommand, LibraryGateway } from "../../library/types";
import { isManualFavorite } from "./model";

type Snapshot = { document: FavoriteCharacters | null; busy: boolean; error: string | null };
const stores = new WeakMap<LibraryGateway, Map<string, ReturnType<typeof createStore>>>();

function createStore(gateway: LibraryGateway, root: string) {
  const key = `lakomics.favoriteCharacters.v1:${root}`;
  const pendingKey = `${key}:pending`;
  let document: FavoriteCharacters | null = null;
  let pending: FavoriteCommand[] = [];
  const rejected = new WeakSet<FavoriteCommand>();
  try { document = JSON.parse(localStorage.getItem(key) ?? "null"); } catch { /* First read can still load from the server. */ }
  try { pending = JSON.parse(localStorage.getItem(pendingKey) ?? "[]"); } catch { /* No persisted edits yet. */ }
  let snapshot: Snapshot = { document, busy: false, error: null };
  const listeners = new Set<() => void>();
  let running: Promise<void> | null = null;
  let again = false;
  const publish = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  };
  const adopt = (next: FavoriteCharacters) => {
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* In-memory cache remains usable. */ }
    publish({ document: next, error: null });
  };
  const writePending = () => {
    try {
      if (pending.length) localStorage.setItem(pendingKey, JSON.stringify(pending));
      else localStorage.removeItem(pendingKey);
    } catch { /* The session still retains its queue, like folder pins. */ }
  };
  const refresh = (): Promise<void> => {
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        publish({ busy: true });
        try {
          if (!gateway.favoriteCharacters) throw new Error("캐릭터 목록을 사용할 수 없습니다.");
          if (pending.length) {
            if (!gateway.changeFavoriteCharacters) throw new Error("캐릭터 목록을 사용할 수 없습니다.");
            // A link travels alone: its collision refuses the whole batch and must not take other edits with it.
            const link = pending.findIndex(command => command.op === "link");
            const sent = pending.slice(0, link === 0 ? 1 : link > 0 ? Math.min(link, 20) : 20);
            try {
              const reply = await gateway.changeFavoriteCharacters(sent);
              pending = pending.slice(sent.length); writePending();
              document = reply;
              adopt(applyCommands(reply, pending));
            } catch (error) {
              if (!cloudCommandRefused(error)) throw error;
              // Resending a refused batch can never succeed. Drop it (and its optimistic change) so later edits still save.
              sent.forEach(command => rejected.add(command));
              pending = pending.slice(sent.length); writePending();
              try { document = await gateway.favoriteCharacters(); } catch { /* Keep the last confirmed document until the next read. */ }
              if (document) adopt(applyCommands(document, pending));
              publish({ error: refusalMessage(error) });
            }
            if (pending.length) again = true;
          } else {
            const reply = await gateway.favoriteCharacters();
            document = reply;
            adopt(applyCommands(reply, pending));
          }
        } catch (error) { publish({ error: pending.length ? "변경 내용을 PC에 보관했습니다. 연결되면 다시 저장합니다." : commandErrorMessage(error, "캐릭터 목록을 불러오지 못했습니다.") }); }
      } while (again);
    })().finally(() => { running = null; publish({ busy: false }); });
    return running;
  };
  // Per-id commands survive offline/re-entry, like shared folder pins. Replies are rebased with
  // edits made during a request, so an older read never erases a newer profile or order.
  const change = async (commands: FavoriteCommand[]): Promise<boolean> => {
    if (!gateway.changeFavoriteCharacters || !snapshot.document) {
      publish({ error: "캐릭터 목록을 사용할 수 없습니다." }); return false;
    }
    pending = [...pending, ...commands]; writePending();
    adopt(applyCommands(snapshot.document, commands));
    await refresh();
    return !commands.some(command => rejected.has(command));
  };
  return { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, refresh, change };
}

function refusalMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === "favoriteCharacterExists") return "이미 추가된 캐릭터입니다. 다른 캐릭터를 선택하세요.";
  // The tablet may have filled the list since this PC last read it.
  if (code === "cloud_object_key_conflict") return "캐릭터는 300명까지 추가할 수 있습니다. 목록을 다시 불러왔습니다.";
  return "서버가 캐릭터 목록 변경을 거부해 되돌렸습니다.";
}

export function applyCommands(document: FavoriteCharacters, commands: FavoriteCommand[]): FavoriteCharacters {
  let entries = document.entries;
  for (const command of commands) {
    if (command.op === "update") entries = entries.map(entry => {
      if (entry.characterId !== command.id) return entry;
      const { name, seriesName, ...set } = command.set;
      return { ...entry, ...set, ...(isManualFavorite(entry.characterId) ? {
        ...(name !== undefined ? { name: name.trim() } : {}), ...(seriesName !== undefined ? { seriesName } : {}),
      } : {}) };
    });
    else if (command.op === "create") {
      if (!entries.some(entry => entry.characterId === command.id)) entries = [...entries, {
        characterId: command.id, name: command.name.trim(), ...(command.seriesName !== undefined ? { seriesName: command.seriesName } : {}),
        coverAssetId: null, coverY: 50, profile: {}, workIds: [], extraWorks: [],
      }];
    } else if (command.op === "link") {
      if (!entries.some(entry => entry.characterId === command.characterId)) entries = entries.map(entry => {
        if (entry.characterId !== command.id) return entry;
        const { name: _name, seriesName: _seriesName, ...linked } = entry;
        return { ...linked, characterId: command.characterId };
      });
    }
    else if (command.op === "remove") entries = entries.filter(entry => !command.ids.includes(entry.characterId));
    else if (command.op === "add") {
      const existing = new Set(entries.map(entry => entry.characterId));
      entries = [...entries, ...command.ids.filter(id => !existing.has(id)).map(characterId => ({ characterId, coverAssetId: null, coverY: 50, profile: {}, workIds: [], extraWorks: [] }))];
    } else {
      const byId = new Map(entries.map(entry => [entry.characterId, entry]));
      entries = [...command.ids.flatMap(id => byId.get(id) ?? []), ...entries.filter(entry => !command.ids.includes(entry.characterId))];
    }
  }
  return { ...document, entries };
}

export function useFavoriteCharacters(gateway: LibraryGateway, root: string) {
  const store = useMemo(() => {
    let byRoot = stores.get(gateway);
    if (!byRoot) { byRoot = new Map(); stores.set(gateway, byRoot); }
    let value = byRoot.get(root);
    if (!value) { value = createStore(gateway, root); byRoot.set(root, value); }
    return value;
  }, [gateway, root]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    if (!root) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      clearTimeout(timer);
      void store.refresh().finally(() => { if (!stopped) timer = setTimeout(tick, windowPollDelay(60_000)); });
    };
    tick();
    const stopFocus = subscribeWindowFocus(() => { if (document.hasFocus()) tick(); });
    window.addEventListener("online", tick);
    return () => { stopped = true; clearTimeout(timer); stopFocus(); window.removeEventListener("online", tick); };
  }, [store, root]);
  return { ...snapshot, refresh: store.refresh, change: useCallback(store.change, [store]) };
}
