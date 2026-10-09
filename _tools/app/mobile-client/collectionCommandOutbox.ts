import {rememberPersonNames} from './personNameCache';
import {applyProfileChanges, hasOwn, hasProfileMetadata, profileExpected, validateProfileChanges, validateProfileExpected, validateProfileCareer, type ProfilePerson, type ProfileChanges, type ProfileExpected} from "../src/collections/av/personProfileFields";
import {connectionOutbox, outboxConnection, outboxKey} from './outboxConnection';
import {api, ApiError, errorText} from './transport';
import type {CollectionDetail, CollectionKind, CollectionSummary, CollectionPerson} from './collectionModel';
import {SAVE_FAILED} from './collectionEditOutbox';
import {avCredits, avValue, canonicalAvCredits, emptyAv, normalizePersonMemo, sameAvValue, validateAvCredits, validateAvDetails, validatePersonFields, AV_INPUT_ERROR,
  type AvCredit, type AvDetailFields, type AvDetailKey, type AvNewPerson, type AvOverlay, type PersonFields, type PersonKey, type PersonValues} from './avEditModel';

export const AUTHORITY_STATUS_PATH = '/v1/collections/authority/status';
export const COMMAND_PATH = '/v1/collections/authority/commands';
export const COMMAND_EVENT = 'lakomics-collection-commands';
const KEY = connectionOutbox('lakomics.collections.commands.outbox.v1');
export type AuthorityIdentity = {libraryId: string; epoch: number; contractVersion: 1};
export type Fields = Record<string, string | number | boolean | null>;
export type Provider = 'tmdb' | 'igdb';
export type ProviderApply = {operation: 'create' | 'connect' | 'refresh'; provider: Provider; externalId: string; workId: string; type?: 'movie' | 'game'};
export type BlobReceipt = {sha256: string; sizeBytes: number; contentType: string};
export type ArtworkReceipt = {provider: string; providerImageId: string; original: BlobReceipt; width: number; height: number};
/** The relay's reply: an older server sends no thumbnail. */
export type ArtworkReply = ArtworkReceipt & {thumbnail?: BlobReceipt | null};
export type CommandReceipt = AuthorityIdentity & {operationId: string; commandType: string; authorityCursor?: number; changed?: boolean; entities?: {works?: {workId: string; entityRevision: number}[]}; person?: CollectionPerson};
export type WorkCommand =
  | {commandType: 'setKakaoPartialDismissed'; workId: string; dismissed: boolean; expectedVolumes: number[]}
  | {commandType: 'setVolumeRange'; workId: string; minVolume: number | null; maxVolume: number | null; hideConnectionPrompt: boolean; expectedRange: {minVolume: number | null; maxVolume: number | null; hideConnectionPrompt: boolean}; expectedRevision: null}
  | ({commandType: 'providerApply'} & ProviderApply)
  | ({commandType: 'addArtwork'; workId: string; artworkId: string; kind: string; language: string | null; thumbnail: BlobReceipt | null} & ArtworkReceipt)
  | {commandType: 'selectArtwork'; workId: string; slot: 'work' | 'hero' | 'backdrop' | 'spine' | 'back'; artworkId: string | null; expectedArtworkId: string | null}
  | {commandType: 'createWork'; workId: string; type: CollectionKind; name: string; legacyKind: null; fields: Fields; binding: null}
  | {commandType: 'updateWork'; workId: string; changes: Fields; expected: Fields; expectedRevision: number | null}
  | {commandType: 'setAvDetails'; workId: string; changes: AvDetailFields; expected: AvDetailFields}
  | {commandType: 'setAvCredits'; workId: string; credits: AvCredit[]; people: AvNewPerson[]; expectedRevision: number}
  | {commandType: 'deleteWork' | 'restoreWork'; workId: string; expectedRevision: number}
  | {commandType: 'setOwnershipTracking'; workId: string; editionIndex: number; count: number; expectedCount: number | null; expectedRevision: null}
  | {commandType: 'setReleaseSubscription'; workId: string; enabled: boolean; expectedEnabled: boolean; expectedRevision: null};
/** A person command has no work: its queue order and label belong to the person. */
export type SetPersonCommand = {commandType: 'setPerson'; personId: string; workId?: never; changes: PersonFields; expected: PersonFields};
export type PortraitManifest = {original: BlobReceipt; width: number; height: number; attribution: {source: 'stashdb' | 'commons' | 'local'; sourceUrl: string | null; license: string | null; author: string | null}};
export type PersonRevisionCommand = {personId: string; workId?: never; expectedRevision: number} & (
  {commandType: 'setPersonProfile'; stashdbId: string | null} |
  {commandType: 'setPersonPortrait'; portrait: ({kind: 'image'} & PortraitManifest) | null});
export type SetPersonProfileFieldsCommand = {commandType: 'setPersonProfileFields'; personId: string; workId?: never; changes: ProfileChanges; expected: ProfileExpected};
export type PersonCommand = SetPersonCommand | PersonRevisionCommand | SetPersonProfileFieldsCommand;
export type AuthorityCommand = WorkCommand | PersonCommand;
export function isPersonCommand(command: AuthorityCommand): command is PersonCommand {
  return command.commandType === 'setPersonProfileFields' || command.commandType === 'setPerson' || command.commandType === 'setPersonProfile' || command.commandType === 'setPersonPortrait';
}
export type Command = AuthorityIdentity & AuthorityCommand & {operationId: string};
/**
 * `label` names the work for queue rows whose work is not on screen (a delete or restore);
 * `lastError` is why the last delivery attempt did not reach the server.
 */
export type ConflictWork = {name: string; fields: Fields; entityRevision?: number; details?: {av?: CollectionSummary['av']}; avCredits?: AvCredit[]};
/** The server's person in a `setPerson` conflict (`current.person`). */
export type ConflictPerson = ProfilePerson & {personId?: string; memo?: string | null; favorite?: boolean; entityRevision?: number};
export type CommandIntent = {inboxId?: string; command: Command; label?: string; avOverlay?: AvOverlay; lastError?: string; receipts?: CommandReceipt[]; acceptedAt?: number; createdAt: number; attempts: number; nextAttemptAt: number;
  state: 'pending' | 'conflict' | 'accepted'; conflict?: {code: string; current?: {work?: ConflictWork; person?: ConflictPerson}}};
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
    return Array.isArray(rows) ? rows.filter(row => {
      if (!row?.command || typeof row.command.operationId !== 'string'
        || !(typeof row.command.workId === 'string' || isPersonCommand(row.command) && typeof row.command.personId === 'string')
        || !authorityIdentity({...row.command, active: true}) || !['pending', 'conflict', 'accepted'].includes(row.state)) return false;
      if (row.command.commandType === 'setPersonProfileFields' || row.command.commandType === 'setPersonProfile' || row.command.commandType === 'setPersonPortrait') {
        try { validateAvCommand(row.command); } catch { return false; }
      }
      return true;
    }) : [];
  } catch { return []; }
}
function write(rows: CommandIntent[], connection = outboxConnection()) {
  const key = outboxKey(KEY, connection);
  if (!key) throw new Error(SAVE_FAILED);
  try { localStorage.setItem(key, JSON.stringify(rows)); } catch { throw new Error(SAVE_FAILED); }
  if (connection === outboxConnection()) window.dispatchEvent(new Event(COMMAND_EVENT));
}
export const isLifecycle = (command: AuthorityCommand) => command.commandType === 'deleteWork' || command.commandType === 'restoreWork';
/** When this app run began: a queued row from an earlier run is not "being sent right now". */
export const SESSION_STARTED_AT = Date.now();
/**
 * A delete or restore that may still be on its way: queued in this run and not yet failed.
 * Only such a row (or a confirmed one) may hide a work; anything else shows its work again with
 * the queue's 대기 row, so an undelivered delete is never silent.
 */
export const lifecycleInFlight = (row: CommandIntent) => row.state === 'pending' && row.attempts === 0 && !row.lastError && row.createdAt >= SESSION_STARTED_AT;
export function enqueueCommand(identity: AuthorityIdentity, command: AuthorityCommand, label?: string): CommandIntent {
  validateAvCommand(command);
  const intent: CommandIntent = {command: {...identity, ...command, operationId: crypto.randomUUID()},
    ...(label ? {label} : {}), createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, state: 'pending'};
  validateAvCommand(intent.command);
  write([...readCommands(), intent]);
  return intent;
}
/** Persist related commands together, before any network delivery can begin. */
export function enqueueCommands(identity: AuthorityIdentity, commands: WorkCommand[], avOverlay?: AvOverlay): CommandIntent[] {
  commands.forEach(validateAvCommand);
  const intents: CommandIntent[] = commands.map(command => ({command: {...identity, ...command, operationId: crypto.randomUUID()},
    ...(command.commandType === 'setAvCredits' && avOverlay ? {avOverlay} : {}),
    createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, state: 'pending'}));
  intents.forEach(intent => validateAvCommand(intent.command));
  write([...readCommands(), ...intents]); return intents;
}
/** Immutable inbox operations can be recovered after a crash between plan and queue writes. */
export function enqueueInboxCommands(inboxId: string, commands: Command[], connection = outboxConnection()) {
  const rows = readCommands(connection);
  for (const command of commands) {
    validateAvCommand(command);
    const prior = rows.find(row => row.command.operationId === command.operationId);
    if (prior && JSON.stringify(prior.command) !== JSON.stringify(command)) throw new Error(SAVE_FAILED);
    if (!prior) rows.push({inboxId, command, createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, state: 'pending'});
  }
  write(rows, connection);
}
/** Completed applies release their pinned receipt rows after acknowledgement. */
export function releaseInboxCommands(inboxId: string, connection = outboxConnection()) {
  write(readCommands(connection).filter(row => row.inboxId !== inboxId), connection);
}
export function discardInboxCommands(inboxId:string,connection=outboxConnection()){
  write(readCommands(connection).filter(row=>row.inboxId!==inboxId||row.state==='accepted'),connection);
}
export function providerApplyBody(command: Command & {commandType: 'providerApply'}) {
  const {libraryId, epoch, operation, provider, externalId, workId, type} = command;
  return {commandId: command.operationId, libraryId, epoch, operation, provider, externalId, workId,
    ...(operation === 'create' ? {type} : {})};
}
function changeIntent(connection: string, operationId: string, update: (row: CommandIntent) => void) {
  const rows = readCommands(connection), row = rows.find(value => value.command.operationId === operationId);
  if (!row) return;
  update(row); write(rows, connection);
}
/** 다시 시도: a queued row is due now (its backoff is cleared). */
export function retryCommandNow(operationId: string) {
  const connection = outboxConnection();
  if (connection) changeIntent(connection, operationId, stored => { if (stored.state === 'pending') stored.nextAttemptAt = 0; });
}
/** 버리기 for a delete or restore that has not been confirmed: the work stays where the server has it. */
export function discardLifecycle(operationId: string) {
  const rows = readCommands(), row = rows.find(value => value.command.operationId === operationId);
  if (!row || row.state === 'accepted' || !isLifecycle(row.command)) return;
  write(rows.filter(value => value !== row));
}
export function dropWork(identity: AuthorityIdentity, workId: string, connection = outboxConnection()) {
  write(readCommands(connection).filter(row => !sameAuthority(row.command, identity) || row.command.workId !== workId), connection);
}
/** A conflict proves rejection. A replacement payload always receives a fresh operation ID. */
export function replaceCommand(operationId: string, command: AuthorityCommand | null, avOverlay?: AvOverlay) {
  const rows = readCommands(), index = rows.findIndex(row => row.command.operationId === operationId);
  if (index < 0 || rows[index].state !== 'conflict') return;
  if (command) {
    validateAvCommand(command);
    rows[index] = {...rows[index], command: {libraryId: rows[index].command.libraryId, epoch: rows[index].command.epoch, contractVersion: 1, ...command, operationId: crypto.randomUUID()},
      ...(avOverlay ? {avOverlay} : {}), state: 'pending', conflict: undefined, receipts: undefined, acceptedAt: undefined, attempts: 0, nextAttemptAt: 0};
    validateAvCommand(rows[index].command);
  }
  else rows.splice(index, 1);
  write(rows);
  return command ? rows[index] : undefined;
}
const inFlight = new Map<string, Promise<void>>();
function validateAvCommand(command: AuthorityCommand) {
  if (command.commandType === 'setPersonProfileFields') {
    if (typeof command.personId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.personId)) throw new Error(AV_INPUT_ERROR);
    validateProfileChanges(command.changes); validateProfileExpected(command.changes, command.expected);
    if (new TextEncoder().encode(JSON.stringify(command)).byteLength > 64 * 1024) throw new Error(AV_INPUT_ERROR);
  } else if (command.commandType === 'setPerson') {
    if (typeof command.personId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.personId)) throw new Error(AV_INPUT_ERROR);
    validatePersonFields(command.changes); validatePersonFields(command.expected);
    if (!sameAvValue(Object.keys(command.changes).sort(), Object.keys(command.expected).sort())) throw new Error(AV_INPUT_ERROR);
  } else if (command.commandType === 'setPersonProfile' || command.commandType === 'setPersonPortrait') {
    if (typeof command.personId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.personId) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) throw new Error(AV_INPUT_ERROR);
    if (command.commandType === 'setPersonProfile' && command.stashdbId !== null && (typeof command.stashdbId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.stashdbId))) throw new Error(AV_INPUT_ERROR);
    if (command.commandType === 'setPersonPortrait' && command.portrait !== null) { if (command.portrait?.kind !== 'image') throw new Error(AV_INPUT_ERROR); validatePortraitManifest(command.portrait); }
  } else if (command.commandType === 'setAvDetails') {
    validateAvDetails(command.changes); validateAvDetails(command.expected);
    if (!Object.keys(command.changes).length || !sameAvValue(Object.keys(command.changes).sort(), Object.keys(command.expected).sort())) throw new Error('AV 입력을 확인해 주세요.');
  } else if (command.commandType === 'setAvCredits') validateAvCredits(command.credits, command.people, command.expectedRevision);
  if ((command.commandType === 'setAvDetails' || command.commandType === 'setAvCredits') && new TextEncoder().encode(JSON.stringify(command)).byteLength > 64 * 1024)
    throw new Error('AV 입력을 확인해 주세요.');
}
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
    for (const row of due) retryLater(connection, row.command.operationId, errorText(error));
    throw error;
  }
  if (!identity || connection !== outboxConnection()) return;
  for (const snapshot of readCommands(connection)) {
    if (connection !== outboxConnection()) return;
    const rows = readCommands(connection), index = rows.findIndex(row => row.command.operationId === snapshot.command.operationId);
    const row = rows[index];
    if (!row || !sameAuthority(row.command, identity) || row.state !== 'pending' || row.nextAttemptAt > Date.now()) continue;
    // FIFO per work (or person): a create, a failed send, or an unresolved conflict blocks its later edits.
    if (rows.slice(0, index).some(earlier => sameAuthority(earlier.command, identity) && entityKey(earlier.command) === entityKey(row.command) && earlier.state !== 'accepted')) {
      // A waiting delete or restore says why, so its work is shown again instead of hidden.
      if (isLifecycle(row.command) && !row.lastError) changeIntent(connection, row.command.operationId, stored => { stored.lastError = '이 작품의 앞선 변경을 먼저 보내야 합니다.'; });
      continue;
    }
    try {
      validateAvCommand(row.command);
      if (row.command.commandType === 'providerApply') {
        const reply = await api<{receipts: CommandReceipt[]}>('/v1/providers/apply', undefined, providerApplyBody(row.command), 'POST', false, connection);
        // Relay-imported gallery artwork precedes the final snapshot atomically.
        // Keep accepting older servers' single create receipt.
        const order = row.command.operation === 'create' ? /^createWork(?:,addArtwork)*,applyProviderSnapshot$|^createWork$/
          : row.command.operation === 'connect' ? /^bindProvider(?:,addArtwork)*,applyProviderSnapshot$/
          : /^(?:addArtwork,)*applyProviderSnapshot$/;
        if (!Array.isArray(reply?.receipts) || !order.test(reply.receipts.map(receipt => receipt?.commandType).join(','))
          || reply.receipts.some(receipt => !receipt || !sameAuthority(receipt, row.command) || typeof receipt.operationId !== 'string')
          || new Set(reply.receipts.map(receipt => receipt.operationId)).size !== reply.receipts.length)
          throw new Error('서버 응답을 확인하지 못했습니다. 다시 전송합니다.');
        // Retain the server's command receipts in their original order, just as ordinary acknowledgements.
        changeIntent(connection, row.command.operationId, stored => { stored.receipts = reply.receipts; stored.acceptedAt = Date.now(); stored.state = 'accepted'; });
        continue;
      }
      const receipt = await api<CommandReceipt>(COMMAND_PATH, undefined, row.command, 'PUT', false, connection);
      if (!receipt || !sameAuthority(receipt, row.command) || receipt.operationId !== row.command.operationId || receipt.commandType !== row.command.commandType)
        throw new Error('서버 응답을 확인하지 못했습니다. 다시 전송합니다.');
      changeIntent(connection, row.command.operationId, stored => { stored.receipts = [receipt]; stored.acceptedAt = Date.now(); stored.state = 'accepted'; });
      // No read ever shows a trashed work, so nothing would reconcile it: screens keep the
      // acknowledgement they just observed, and the queue lets it go.
      if (isLifecycle(row.command)) write(readCommands(connection).filter(stored => stored.command.operationId !== row.command.operationId), connection);
    } catch (error) {
      const detail = error instanceof ApiError ? (error.details as {detail?: {code?: string; current?: {work?: ConflictWork; person?: ConflictPerson}}} | null)?.detail : null;
      const code = detail?.code;
      if (code === 'workDeleted' && !row.inboxId && !isPersonCommand(row.command)) { dropWork(identity, row.command.workId, connection); continue; }
      // The server has no such person: no retry can succeed, so its queued edits go, with a note.
      if (code === 'personNotFound' && isPersonCommand(row.command)) { dropPerson(identity, row.command.personId, connection, row.label); continue; }
      if (error instanceof ApiError && error.status !== null && error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status)) {
        changeIntent(connection, row.command.operationId, stored => {
          stored.state = 'conflict'; stored.conflict = {code: code ?? 'commandRejected', current: detail?.current};
        });
        continue;
      }
      retryLater(connection, row.command.operationId, errorText(error));
      return;
    }
  }
}
/** The queue order of a command: per work, or per person for `setPerson`. */
const entityKey = (command: AuthorityCommand) => isPersonCommand(command) ? `person:${command.personId}` : `work:${command.workId}`;
const personNotices = new Map<string, string>();
export const PERSON_NOT_FOUND = (name?: string) => `서버에 ${name ? `${name} ` : '이 '}배우 정보가 없어 변경을 보내지 못했습니다.`;
/** Why this person's queued edits were dropped, until the page that shows it is closed. */
export const personNotice = (personId: string) => personNotices.get(personId);
export function clearPersonNotice(personId: string) {
  if (personNotices.delete(personId)) window.dispatchEvent(new Event(COMMAND_EVENT));
}
function dropPerson(identity: AuthorityIdentity, personId: string, connection: string, label?: string) {
  personNotices.set(personId, PERSON_NOT_FOUND(label));
  write(readCommands(connection).filter(row => !sameAuthority(row.command, identity) || !isPersonCommand(row.command) || row.command.personId !== personId), connection);
}
function retryLater(connection: string, operationId: string, reason: string) {
  changeIntent(connection, operationId, stored => {
    stored.attempts++; stored.lastError = reason; stored.nextAttemptAt = Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(stored.attempts - 1, 6));
  });
}
/** Accepted overlays survive restart and remain until a read actually contains the desired fields. */
export function reconcileCommands(identity: AuthorityIdentity, item: CollectionSummary, source: 'list' | 'detail' = 'list', readStartedAt?: number) {
  const rows = readCommands();
  const next = rows.filter((row, index) => {
    if (row.inboxId || !sameAuthority(row.command, identity) || row.command.workId !== item.id || row.state !== 'accepted') return true;
    const command = row.command;
    if (command.commandType === 'setKakaoPartialDismissed' || command.commandType === 'setVolumeRange') {
      const latest = [...rows.slice(index)].reverse().find(later => sameAuthority(later.command, identity) && later.command.workId === item.id && later.command.commandType === command.commandType)!;
      const review = item.kakaoReview;
      if (!review || latest.state !== 'accepted') return true;
      if (latest.command.commandType === 'setKakaoPartialDismissed' && JSON.stringify(review.volumes) !== JSON.stringify(latest.command.expectedVolumes)) return false;
      return latest.command.commandType === 'setKakaoPartialDismissed' ? review.partialDismissed !== latest.command.dismissed
        : latest.command.commandType === 'setVolumeRange' && (review.hideConnectionPrompt !== latest.command.hideConnectionPrompt || review.minVolume !== latest.command.minVolume || review.maxVolume !== latest.command.maxVolume);
    }
    if (command.commandType === 'providerApply') return command.operation === 'create' ? source !== 'list'
      : source !== 'detail' || readStartedAt === undefined || readStartedAt < (row.acceptedAt ?? Infinity);
    if (command.commandType === 'addArtwork') return !(item as CollectionDetail).artworks?.some(art => art.id === command.artworkId);
    if (command.commandType === 'selectArtwork') {
      const key = command.slot === 'work' ? 'selectedWorkArtworkId' : command.slot === 'hero' ? 'selectedHeroArtworkId' : 'selectedBackdropArtworkId';
      return (item[key] ?? null) !== command.artworkId;
    }
    // A detail response cannot retire the shelf's optimistic new tile before its list catches up.
    if (command.commandType === 'createWork') return source !== 'list';
    if (command.commandType === 'setAvDetails') return !Object.entries(command.changes).every(([key, value]) => {
      const latest = [...rows.slice(index + 1)].reverse().find(later => sameAuthority(later.command, identity) && later.command.workId === item.id
        && later.command.commandType === 'setAvDetails' && key in later.command.changes);
      return latest ? latest.state === 'accepted' && latest.command.commandType === 'setAvDetails' && sameAvValue(avValue(item.av, key as AvDetailKey), latest.command.changes[key as AvDetailKey])
        : sameAvValue(avValue(item.av, key as AvDetailKey), value);
    });
    if (command.commandType === 'setAvCredits') {
      const latest = [...rows.slice(index)].reverse().find(later => sameAuthority(later.command, identity) && later.command.workId === item.id && later.command.commandType === 'setAvCredits')!;
      return latest.state !== 'accepted' || latest.command.commandType !== 'setAvCredits' || !sameAvValue(avCredits(item.av?.people ?? []), canonicalAvCredits(latest.command.credits));
    }
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
    if (isLifecycle(command)) return false;
    const latest = [...rows.slice(index)].reverse().find(later => sameAuthority(later.command, identity) && later.command.workId === item.id && later.command.commandType === 'setReleaseSubscription')!;
    return latest.state !== 'accepted' || latest.command.commandType !== 'setReleaseSubscription' || item.releaseWatch?.enabled !== latest.command.enabled;
  });
  if (next.length !== rows.length) write(next);
}
export function optimisticWork<T extends CollectionSummary>(item: T, rows: CommandIntent[]): T {
  let next = item;
  for (const {command, avOverlay} of rows.filter(row => row.command.workId === item.id)) {
    if (next.kakaoReview && command.commandType === 'setKakaoPartialDismissed' && JSON.stringify(next.kakaoReview.volumes) === JSON.stringify(command.expectedVolumes)) next = {...next, kakaoReview: {...next.kakaoReview, partialDismissed: command.dismissed}};
    if (next.kakaoReview && command.commandType === 'setVolumeRange') next = {...next, kakaoReview: {...next.kakaoReview, minVolume: command.minVolume, maxVolume: command.maxVolume, hideConnectionPrompt: command.hideConnectionPrompt}};
    if (command.commandType === 'updateWork') next = {...next, ...command.changes};
    if (command.commandType === 'setAvDetails') next = {...next, av: {...(next.av ?? emptyAv()), ...command.changes}};
    if (command.commandType === 'setAvCredits') {
      const people = command.credits.map(credit => {
        const known = avOverlay?.people.find(person => person.id === credit.personId) ?? next.av?.people.find(person => person.id === credit.personId);
        const added = command.people.find(person => person.personId === credit.personId);
        return {...known, id: credit.personId, name: known?.name ?? added?.displayName ?? credit.personId, nameJa: known?.nameJa ?? added?.nameJa ?? null,
          role: credit.role, order: credit.order, creditName: credit.creditName};
      }).sort((a,b) => (a.role === b.role ? a.order - b.order : a.role === 'performer' ? -1 : 1));
      next = {...next, av: {...(next.av ?? emptyAv()), people}};
    }
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
    if (command.commandType === 'setAvDetails') {
      const changes = Object.fromEntries(Object.entries(command.changes).filter(([key]) => sameAvValue(avValue(next.av, key as AvDetailKey), command.expected[key as AvDetailKey])));
      next = {...next, av: {...(next.av ?? emptyAv()), ...changes}};
    } else if (command.commandType === 'setKakaoPartialDismissed') next = optimisticWork(next, [row]);
    else if (command.commandType === 'setVolumeRange' && next.kakaoReview && next.kakaoReview.hideConnectionPrompt === command.expectedRange.hideConnectionPrompt && next.kakaoReview.minVolume === command.expectedRange.minVolume && next.kakaoReview.maxVolume === command.expectedRange.maxVolume) next = optimisticWork(next, [row]);
    else if (command.commandType === 'setAvCredits' && row.avOverlay && sameAvValue(avCredits(next.av?.people ?? []), row.avOverlay.expectedCredits)) next = optimisticWork(next, [row]);
    else if (command.commandType === 'updateWork') {
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

const personKeys: PersonKey[] = ['memo', 'favorite'];
const isPersonRow = (row: CommandIntent, personId: string): row is CommandIntent & {command: Command & SetPersonCommand} =>
  row.command.commandType === 'setPerson' && row.command.personId === personId;
/** A confirmed read plus this device's accepted intents that the read may predate (each only on its exact expected value). */
export function confirmedPerson(person: PersonValues, personId: string, rows: CommandIntent[]): PersonValues {
  const next = {...person};
  for (const row of rows) if (row.state === 'accepted' && isPersonRow(row, personId))
    for (const key of personKeys) if (key in row.command.changes && next[key] === row.command.expected[key]) (next as Record<PersonKey, unknown>)[key] = row.command.changes[key];
  return next;
}
/** What the page shows: queued and refused intents over the confirmed values, in queue order. */
export function optimisticPerson(person: PersonValues, personId: string, rows: CommandIntent[]): PersonValues {
  const next = {...person};
  for (const row of rows) if (row.state !== 'accepted' && isPersonRow(row, personId)) Object.assign(next, row.command.changes);
  return next;
}
/**
 * The `setPerson` that turns the shown person into `desired`, or null when nothing changes. Expected
 * values are the confirmed values with this person's earlier unsent intents applied in queue order,
 * since the server applies those first.
 */
export function personCommand(personId: string, confirmed: PersonValues, rows: CommandIntent[], desired: PersonFields): SetPersonCommand | null {
  const base = optimisticPerson(confirmed, personId, rows);
  const changes: PersonFields = {}, expected: PersonFields = {};
  for (const key of personKeys) {
    if (!(key in desired)) continue;
    const value = key === 'memo' ? normalizePersonMemo(desired.memo) : desired.favorite;
    const previous = key === 'memo' ? normalizePersonMemo(base.memo) : base.favorite;
    if (value !== previous) { (changes as Record<PersonKey, unknown>)[key] = value; (expected as Record<PersonKey, unknown>)[key] = previous; }
  }
  return Object.keys(changes).length ? {commandType: 'setPerson', personId, changes, expected} : null;
}
/** 덮어쓰기 for a refused `setPerson`: the same wish, expected from the server's current person. */
export function rebasePersonCommand(row: CommandIntent): PersonCommand | null {
  const command = row.command, current = row.conflict?.current?.person;
  if (!isPersonCommand(command) || !current) return null;
  if (command.commandType === 'setPersonProfileFields') return row.conflict?.code === 'revisionConflict' && hasProfileMetadata(current) ? {commandType: 'setPersonProfileFields', personId: command.personId, changes: command.changes, expected: profileExpected(current, command.changes)} : null;
  if (command.commandType !== 'setPerson') return row.conflict?.code === 'revisionConflict' && Number.isSafeInteger(current.entityRevision) && current.entityRevision! > 0
    ? command.commandType === 'setPersonProfile'
      ? {commandType: 'setPersonProfile', personId: command.personId, stashdbId: command.stashdbId, expectedRevision: current.entityRevision!}
      : {commandType: 'setPersonPortrait', personId: command.personId, portrait: command.portrait, expectedRevision: current.entityRevision!} : null;
  const expected: PersonFields = {};
  for (const key of personKeys) if (key in command.changes) (expected as Record<PersonKey, unknown>)[key] = key === 'memo' ? normalizePersonMemo(current.memo) : current.favorite === true;
  return {commandType: 'setPerson', personId: command.personId, changes: command.changes, expected};
}
/** Accepted person intents retire once a read contains them or began after their acknowledgement. */
export function reconcilePerson(identity: AuthorityIdentity, personId: string, person: PersonValues, readStartedAt?: number) {
  const rows = readCommands();
  const next = rows.filter(row => !(row.state === 'accepted' && sameAuthority(row.command, identity) && isPersonRow(row, personId)
    && (readStartedAt !== undefined && readStartedAt > (row.acceptedAt ?? Infinity)
      || personKeys.every(key => !(key in row.command.changes) || (row.command as SetPersonCommand).changes[key] === (key === 'memo' ? normalizePersonMemo(person.memo) : person.favorite)))));
  if (next.length !== rows.length) write(next);
}

/** Wait for unresolved person intents: profile refresh and portrait equality can be no-ops. */
export function personRevision(personId: string, revision: number | undefined, rows: CommandIntent[]): number | null {
  if (!Number.isSafeInteger(revision) || revision! < 1) return null;
  let result = revision!;
  for (const row of rows) if (isPersonCommand(row.command) && row.command.personId === personId) {
    if (row.state !== 'accepted') return null;
    const accepted = row.receipts?.[row.receipts.length - 1]?.person?.entityRevision;
    if (Number.isSafeInteger(accepted) && accepted! > 0) result = Math.max(result, accepted!);
    else return null;
  }
  return result;
}
export function validatePortraitManifest(value: PortraitManifest) {
  if (!value || !value.original || !/^[a-f0-9]{64}$/.test(value.original.sha256) || value.original.contentType !== 'image/jpeg'
    || !Number.isSafeInteger(value.original.sizeBytes) || value.original.sizeBytes < 1 || value.original.sizeBytes > 5 * 1024 * 1024
    || !Number.isSafeInteger(value.width) || value.width < 1 || value.width > 1600 || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 1600
    || !value.attribution || !['stashdb', 'commons', 'local'].includes(value.attribution.source)) throw new Error(AV_INPUT_ERROR);
}
/** Full person receipts update identity/profile immediately; older receipts leave the plain read intact. */
export function confirmedPersonEntity(person: CollectionPerson, personId: string, rows: CommandIntent[]): CollectionPerson {
  let next = person;
  for (const row of rows) if (row.state === 'accepted' && isPersonCommand(row.command) && row.command.personId === personId) {
    const received = row.receipts?.[row.receipts.length - 1]?.person;
    if (received && (received.id === personId || received.personId === personId) && (received.entityRevision ?? 0) >= (next.entityRevision ?? 0)) next = {...next, ...received, id: personId};
  }
  rememberPersonNames([next]);
  return next;
}
export function reconcilePersonRevision(identity: AuthorityIdentity, personId: string, revision: number, readStartedAt: number) {
  const rows = readCommands();
  const next = rows.filter(row => !(row.state === 'accepted' && sameAuthority(row.command, identity) && isPersonCommand(row.command)
    && row.command.personId === personId && row.command.commandType !== 'setPerson' && readStartedAt > (row.acceptedAt ?? Infinity)
    && revision >= (row.receipts?.[row.receipts.length - 1]?.person?.entityRevision ?? Infinity)));
  if (next.length !== rows.length) write(next);
}

/** Unresolved FIFO profile intents over the newest confirmed full-person read/receipt. */
export function optimisticPersonProfile<T extends ProfilePerson>(person: T, personId: string, rows: CommandIntent[]): T {
  let next = person;
  for (const row of rows) if (row.state !== 'accepted' && isPersonCommand(row.command) && row.command.personId === personId) {
    if (row.command.commandType === 'setPersonProfileFields') next = applyProfileChanges(next, row.command.changes);
    else if (row.command.commandType === 'setPersonProfile' && row.command.stashdbId === null) {
      next = {...next, stashdbId: null, stashdbProfile: null};
      const changes: ProfileChanges = {};
      for (const key of ['birthDate','heightCm','bandIn','waistIn','hipIn','cup','breastType','careerStart','careerEnd','urls'] as const)
        if (!hasOwn(next.profileOverrides ?? {}, key)) changes[key] = {reset: true};
      next = applyProfileChanges(next, changes);
    }
  }
  return next;
}
export function personProfileCommand(personId: string, person: ProfilePerson, rows: CommandIntent[], changes: ProfileChanges, expected: ProfileExpected): SetPersonProfileFieldsCommand {
  if (!hasProfileMetadata(person) || rows.some(row => row.state === 'conflict' && isPersonCommand(row.command) && row.command.personId === personId)) throw new Error('충돌을 정리한 뒤 다시 편집할 수 있습니다.');
  if (rows.some(row => row.state !== 'accepted' && row.command.commandType === 'setPersonProfile' && row.command.personId === personId && row.command.stashdbId !== null)) throw new Error('앞선 StashDB 변경을 보낸 뒤 다시 저장해 주세요.');
  const predicted = optimisticPersonProfile(person, personId, rows);
  validateProfileChanges(changes); validateProfileExpected(changes, expected); validateProfileCareer(predicted, changes);
  return {commandType: 'setPersonProfileFields', personId, changes, expected};
}
