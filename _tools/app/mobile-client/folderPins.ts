import {api} from './transport';

/**
 * Shared folder pins (폴더 고정): one ordered list of classification ids that the PC sidebar and the
 * tablet both edit. The server owns it and merges per-id commands, so two devices editing at once
 * never conflict. `revision` 0 means the list was never written.
 */
export type FolderPins = {revision: number; pinnedIds: string[]};
type PinCommand = {op: 'add' | 'remove' | 'order'; ids: string[]};

const PATH = '/v1/library/folder-pins';
/** The `signals` key of `/v1/sync/status` that moves when the list changes (see `useSyncSignal`). */
export const FOLDER_PINS_SIGNAL = 'folderPins';

function read(value: unknown): FolderPins {
  const reply = value as {version?: unknown; revision?: unknown; pinnedIds?: unknown} | null;
  if (!reply || reply.version !== 1 || !Number.isSafeInteger(reply.revision) || !Array.isArray(reply.pinnedIds)
    || reply.pinnedIds.some(id => typeof id !== 'string')) throw new Error('고정한 폴더를 불러오지 못했습니다. 다시 시도해 주세요.');
  return {revision: reply.revision as number, pinnedIds: reply.pinnedIds as string[]};
}

function send(commands: PinCommand[], signal?: AbortSignal): Promise<FolderPins> {
  return api<unknown>(PATH, signal, {commands}, 'POST').then(read);
}

export function loadFolderPins(signal?: AbortSignal): Promise<FolderPins> {
  return api<unknown>(PATH, signal).then(read);
}

/** Pins the folders that are not pinned yet, at the end of the list. */
export const addFolderPins = (ids: string[], signal?: AbortSignal) => send([{op: 'add', ids}], signal);

export const removeFolderPins = (ids: string[], signal?: AbortSignal) => send([{op: 'remove', ids}], signal);

/** Puts the listed pins first, in this order; pins another device added meanwhile follow them. */
export const reorderFolderPins = (ids: string[], signal?: AbortSignal) => send([{op: 'order', ids}], signal);
