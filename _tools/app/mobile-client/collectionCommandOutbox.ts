import {connectionOutbox, outboxConnection, outboxKey} from './outboxConnection';
import {api, ApiError} from './transport';
import type {CollectionDetail, CollectionKind, CollectionSummary} from './collectionModel';
import {SAVE_FAILED} from './collectionEditOutbox';

export const AUTHORITY_STATUS_PATH = '/v1/collections/authority/status';
export const COMMAND_PATH = '/v1/collections/authority/commands';
export const COMMAND_EVENT = 'lakomics-collection-commands';
const KEY = connectionOutbox('lakomics.collections.commands.outbox.v1');
export type AuthorityIdentity = {libraryId: string; epoch: number; contractVersion: 1};
export type Fields = Record<string, string | number | boolean | null>;
export type WorkCommand =
  | {commandType: 'createWork'; workId: string; type: CollectionKind; name: string; legacyKind: null; fields: Fields; binding: null}
  | {commandType: 'updateWork'; workId: string; changes: Fields; expected: Fields; expectedRevision: number | null}
  | {commandType: 'setOwnershipTracking'; workId: string; editionIndex: number; count: number; expectedCount: number | null; expectedRevision: null}
  | {commandType: 'setReleaseSubscription'; workId: string; enabled: boolean; expectedEnabled: boolean; expectedRevision: null};
export type Command = AuthorityIdentity & WorkCommand & {operationId: string};
export type CommandIntent = {command: Command; createdAt: number; attempts: number; nextAttemptAt: number;
  state: 'pending' | 'conflict' | 'accepted'; conflict?: {code: string; current?: {work?: {name: string; fields: Fields}}}};
export function authorityIdentity(reply: unknown): AuthorityIdentity | null {
  const value = reply as Partial<AuthorityIdentity> & {active?: boolean} | null;
  return value?.active === true && typeof value.libraryId === 'string' && /^[a-f0-9]{32}$/.test(value.libraryId)
    && Number.isSafeInteger(value.epoch) && value.epoch! > 0 && value.contractVersion === 1
    ? {libraryId: value.libraryId, epoch: value.epoch!, contractVersion: 1} : null;
}
export const sameAuthority = (a: AuthorityIdentity, b: AuthorityIdentity) => a.libraryId === b.libraryId && a.epoch === b.epoch && a.contractVersion === b.contractVersion;
export function readCommands(connection = outboxConnection()): CommandIntent[] {
  try {
    const key = outboxKey(KEY, connection), rows: unknown = key ? JSON.parse(localStorage.getItem(key) ?? '[]') : [];
    return Array.isArray(rows) ? rows.filter(row => row?.command && typeof row.command.operationId === 'string'
      && typeof row.command.workId === 'string' && authorityIdentity({...row.command, active: true})
      && ['pending', 'conflict', 'accepted'].includes(row.state)) : [];
  } catch { return []; }
}
function write(rows: CommandIntent[], connection = outboxConnection()) {
  const key = outboxKey(KEY, connection);
  if (!key) throw new Error(SAVE_FAILED);
  try { localStorage.setItem(key, JSON.stringify(rows)); } catch { throw new Error(SAVE_FAILED); }
  if (connection === outboxConnection()) window.dispatchEvent(new Event(COMMAND_EVENT));
}
export function enqueueCommand(identity: AuthorityIdentity, command: WorkCommand): CommandIntent {
  const intent: CommandIntent = {command: {...identity, ...command, operationId: crypto.randomUUID()},
    createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, state: 'pending'};
  write([...readCommands(), intent]);
  return intent;
}
function changeIntent(connection: string, operationId: string, update: (row: CommandIntent) => void) {
  const rows = readCommands(connection), row = rows.find(value => value.command.operationId === operationId);
  if (!row) return;
  update(row); write(rows, connection);
}
export function dropWork(identity: AuthorityIdentity, workId: string, connection = outboxConnection()) {
  write(readCommands(connection).filter(row => !sameAuthority(row.command, identity) || row.command.workId !== workId), connection);
}
/** A conflict proves rejection. A replacement payload always receives a fresh operation ID. */
export function replaceCommand(operationId: string, command: WorkCommand | null) {
  const rows = readCommands(), index = rows.findIndex(row => row.command.operationId === operationId);
  if (index < 0 || rows[index].state !== 'conflict') return;
  if (command) rows[index] = {...rows[index], command: {...rows[index].command, ...command, operationId: crypto.randomUUID()},
    state: 'pending', conflict: undefined, attempts: 0, nextAttemptAt: 0};
  else rows.splice(index, 1);
  write(rows);
  return command ? rows[index] : undefined;
}
const inFlight = new Map<string, Promise<void>>();
export function flushCommands(): Promise<void> {
  const connection = outboxConnection();
  if (!connection) return Promise.resolve();
  const existing = inFlight.get(connection);
  if (existing) return existing;
  const pass = deliver(connection).finally(() => { inFlight.delete(connection); });
  inFlight.set(connection, pass); return pass;
}
async function deliver(connection: string) {
  const due = readCommands(connection).filter(row => row.state === 'pending' && row.nextAttemptAt <= Date.now());
  if (!due.length) return;
  let identity: AuthorityIdentity | null;
  try { identity = authorityIdentity(await api(AUTHORITY_STATUS_PATH, undefined, undefined, 'GET', false, connection)); }
  catch (error) {
    for (const row of due) retryLater(connection, row.command.operationId);
    throw error;
  }
  if (!identity || connection !== outboxConnection()) return;
  for (const snapshot of readCommands(connection)) {
    if (connection !== outboxConnection()) return;
    const rows = readCommands(connection), index = rows.findIndex(row => row.command.operationId === snapshot.command.operationId);
    const row = rows[index];
    if (!row || !sameAuthority(row.command, identity) || row.state !== 'pending' || row.nextAttemptAt > Date.now()) continue;
    // FIFO per work: a create, a failed send, or an unresolved conflict blocks its later edits.
    if (rows.slice(0, index).some(earlier => sameAuthority(earlier.command, identity) && earlier.command.workId === row.command.workId && earlier.state !== 'accepted')) continue;
    try {
      const receipt = await api<AuthorityIdentity & {operationId: string; commandType: string}>(COMMAND_PATH, undefined, row.command, 'PUT', false, connection);
      if (!receipt || !sameAuthority(receipt, row.command) || receipt.operationId !== row.command.operationId || receipt.commandType !== row.command.commandType)
        throw new Error('서버 응답을 확인하지 못했습니다. 다시 전송합니다.');
      changeIntent(connection, row.command.operationId, stored => { stored.state = 'accepted'; });
    } catch (error) {
      const detail = error instanceof ApiError ? (error.details as {detail?: {code?: string; current?: {work?: {name: string; fields: Fields}}}} | null)?.detail : null;
      const code = detail?.code;
      if (code === 'workDeleted') { dropWork(identity, row.command.workId, connection); continue; }
      if (error instanceof ApiError && error.status !== null && error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status)) {
        changeIntent(connection, row.command.operationId, stored => {
          stored.state = 'conflict'; stored.conflict = {code: code ?? 'commandRejected', current: detail?.current};
        });
        continue;
      }
      retryLater(connection, row.command.operationId);
      return;
    }
  }
}
function retryLater(connection: string, operationId: string) {
  changeIntent(connection, operationId, stored => {
    stored.attempts++; stored.nextAttemptAt = Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(stored.attempts - 1, 6));
  });
}
/** Accepted overlays survive restart and remain until a read actually contains the desired fields. */
export function reconcileCommands(identity: AuthorityIdentity, item: CollectionSummary, source: 'list' | 'detail' = 'list') {
  const rows = readCommands();
  const next = rows.filter((row, index) => {
    if (!sameAuthority(row.command, identity) || row.command.workId !== item.id || row.state !== 'accepted') return true;
    const command = row.command;
    // A detail response cannot retire the shelf's optimistic new tile before its list catches up.
    if (command.commandType === 'createWork') return source !== 'list';
    if (command.commandType === 'updateWork') return !Object.entries(command.changes).every(([key, value]) => {
      const latest = [...rows.slice(index + 1)].reverse().find(later => sameAuthority(later.command, identity)
        && later.command.workId === item.id && later.command.commandType === 'updateWork' && key in later.command.changes);
      if (latest) return latest.state === 'accepted' && latest.command.commandType === 'updateWork'
        && Object.is((item as unknown as Fields)[key] ?? null, latest.command.changes[key]);
      return Object.is((item as unknown as Fields)[key] ?? null, value);
    });
    if (command.commandType === 'setOwnershipTracking') {
      const latest = [...rows.slice(index)].reverse().find(later => sameAuthority(later.command, identity) && later.command.workId === item.id
        && later.command.commandType === 'setOwnershipTracking' && later.command.editionIndex === command.editionIndex)!;
      return latest.state !== 'accepted' || latest.command.commandType !== 'setOwnershipTracking'
        || item.ownedVolumes?.find(entry => entry.editionIndex === command.editionIndex)?.count !== latest.command.count;
    }
    const latest = [...rows.slice(index)].reverse().find(later => sameAuthority(later.command, identity) && later.command.workId === item.id && later.command.commandType === 'setReleaseSubscription')!;
    return latest.state !== 'accepted' || latest.command.commandType !== 'setReleaseSubscription' || item.releaseWatch?.enabled !== latest.command.enabled;
  });
  if (next.length !== rows.length) write(next);
}
export function optimisticWork<T extends CollectionSummary>(item: T, rows: CommandIntent[]): T {
  let next = item;
  for (const {command} of rows.filter(row => row.command.workId === item.id)) {
    if (command.commandType === 'updateWork') next = {...next, ...command.changes};
    if (command.commandType === 'setOwnershipTracking') next = {...next, ownedVolumes: [...(next.ownedVolumes ?? []).filter(entry => entry.editionIndex !== command.editionIndex), {editionIndex: command.editionIndex, count: command.count}]};
    if (command.commandType === 'setReleaseSubscription') next = {...next, releaseWatch: {...next.releaseWatch, available: next.releaseWatch?.available ?? false, enabled: command.enabled}};
  }
  return next;
}
/** A confirmed value still belongs on another surface holding its exact pre-edit value. */
export function confirmedWork<T extends CollectionSummary>(item: T, rows: CommandIntent[]): T {
  let next = item;
  for (const row of rows.filter(row => row.command.workId === item.id)) {
    const command = row.command;
    if (command.commandType === 'updateWork') {
      const changes = Object.fromEntries(Object.entries(command.changes).filter(([key]) => Object.is((next as unknown as Fields)[key] ?? null, command.expected[key])));
      next = {...next, ...changes};
    } else if (command.commandType === 'setOwnershipTracking' && (next.ownedVolumes?.find(entry => entry.editionIndex === command.editionIndex)?.count ?? null) === command.expectedCount)
      next = optimisticWork(next, [row]);
    else if (command.commandType === 'setReleaseSubscription' && next.releaseWatch?.enabled === command.expectedEnabled) next = optimisticWork(next, [row]);
  }
  return next;
}
export function createdWork(row: CommandIntent): CollectionDetail | null {
  const command = row.command;
  return command.commandType === 'createWork' ? {id: command.workId, type: command.type, name: command.name,
    showcase: false, ...command.fields, volumes: [], artworks: [], createdAt: new Date(row.createdAt).toISOString()} : null;
}
