import {useCallback, useEffect, useRef, useState} from 'react';
import {visibleInterval} from './useVisibleInterval';
import {usePendingRetry} from './useBookmarks';
import {outboxConnection} from './outboxConnection';
import {api, errorText} from './transport';
import {AUTHORITY_STATUS_PATH, COMMAND_EVENT, authorityIdentity, confirmedWork, createdWork, dropWork, enqueueCommand, enqueueCommands, flushCommands,
  optimisticWork, readCommands, reconcileCommands, replaceCommand, sameAuthority,
  type AuthorityIdentity, type WorkCommand} from './collectionCommandOutbox';
import {normalizeCollectionEdit, sameEditValue, type CollectionEditField, type CollectionEditValue, type OwnedVolumesValue} from './collectionEditOutbox';
import type {CollectionSummary} from './collectionModel';

export function useCollectionAuthority(active: boolean, onSettled: () => void) {
  const connection = outboxConnection();
  const [status, setStatus] = useState<{connection: string | null; identity: AuthorityIdentity} | null>(null);
  const [library, setLibrary] = useState<string | null>(null);
  const [rows, setRows] = useState(readCommands);
  const [confirmed, setConfirmed] = useState(() => readCommands().filter(row => row.state === 'accepted'));
  const [failure, setFailure] = useState('');
  const settled = useRef(onSettled); settled.current = onSettled;
  const identity = status?.connection === connection && status.identity.libraryId === library ? status.identity : null;
  useEffect(() => {
    if (!active || !connection) return;
    const controller = new AbortController();
    const check = async () => {
      try {
        const reply = await api(AUTHORITY_STATUS_PATH, controller.signal, undefined, 'GET', false, connection);
        if (controller.signal.aborted || connection !== outboxConnection()) return;
        const value = authorityIdentity(reply); setStatus(value ? {connection, identity: value} : null);
      } catch { /* A temporary outage keeps the last confirmed identity usable offline. */ }
    };
    void check(); const stop = visibleInterval(() => void check(), 60_000);
    return () => { controller.abort(); stop(); };
  }, [active, connection]);
  useEffect(() => {
    setConfirmed(readCommands().filter(row => row.state === 'accepted'));
    const read = () => {
      const next = readCommands(); setRows(next);
      // Queue acknowledgement and each screen's read-back have different lifetimes.
      setConfirmed(current => [...current, ...next.filter(row => row.state === 'accepted' && !current.some(previous => previous.command.operationId === row.command.operationId))]);
    };
    read(); window.addEventListener(COMMAND_EVENT, read);
    return () => window.removeEventListener(COMMAND_EVENT, read);
  }, [connection]);
  const flush = useCallback(async () => {
    const before = readCommands();
    try {
      await flushCommands(); setFailure('');
      const after = readCommands();
      if (before.some(row => row.state !== 'accepted' && (!after.some(next => next.command.operationId === row.command.operationId) || after.some(next => next.command.operationId === row.command.operationId && next.state === 'accepted')))) settled.current();
    } catch (error) { setFailure(errorText(error)); }
  }, []);
  const scoped = identity ? rows.filter(row => sameAuthority(row.command, identity)) : [];
  const settledRows = identity ? confirmed.filter(row => sameAuthority(row.command, identity)) : [];
  const pending = scoped.some(row => row.state === 'pending');
  usePendingRetry(active, pending, flush);
  useEffect(() => { if (active && pending) void flush(); }, [active, pending, flush, identity?.epoch]);
  const enqueue = useCallback((command: WorkCommand) => {
    if (!identity) throw new Error('작품을 편집할 수 없습니다. 연결을 확인해 주세요.');
    const result = enqueueCommand(identity, command); void flush(); return result;
  }, [identity?.libraryId, identity?.epoch, flush]);
  const enqueueBatch = (commands: WorkCommand[]) => {
    if (!identity) throw new Error('작품을 편집할 수 없습니다. 연결을 확인해 주세요.');
    const result = enqueueCommands(identity, commands); void flush(); return result;
  };
  const edit = (workId: string, field: CollectionEditField, value: CollectionEditValue, expected: CollectionEditValue) => {
    const normalized = normalizeCollectionEdit(field, value);
    if (field === 'ownedVolumes') {
      const owned = normalized as OwnedVolumesValue;
      enqueue({commandType: 'setOwnershipTracking', workId, editionIndex: owned.editionIndex, count: owned.count!, expectedCount: (expected as OwnedVolumesValue).count, expectedRevision: null});
    } else if (field === 'releaseWatch') enqueue({commandType: 'setReleaseSubscription', workId, enabled: normalized as boolean, expectedEnabled: expected as boolean, expectedRevision: null});
    else {
      const key = field === 'memo' ? 'description' : field;
      enqueue({commandType: 'updateWork', workId, changes: {[key]: normalized as string | number | boolean | null}, expected: {[key]: expected as string | number | boolean | null}, expectedRevision: null});
    }
  };
  const visible = <T extends CollectionEditValue>(workId: string, field: CollectionEditField, authoritative: T) => {
    if (!identity) return null;
    const key = field === 'memo' ? 'description' : field;
    const matches = (row: (typeof scoped)[number]) => {
      const command = row.command;
      return command.workId === workId && (command.commandType === 'updateWork' && key in command.changes
        || command.commandType === 'setReleaseSubscription' && field === 'releaseWatch'
        || command.commandType === 'setOwnershipTracking' && field === 'ownedVolumes' && command.editionIndex === (authoritative as OwnedVolumesValue).editionIndex);
    };
    const row = [...scoped].reverse().find(row => row.state !== 'accepted' && matches(row));
    if (!row) {
      let value: CollectionEditValue = authoritative;
      for (const row of settledRows.filter(matches)) {
        const command = row.command;
        const expected = command.commandType === 'updateWork' ? command.expected[key]
          : command.commandType === 'setReleaseSubscription' ? command.expectedEnabled
          : command.commandType === 'setOwnershipTracking' ? {editionIndex: command.editionIndex, count: command.expectedCount} : undefined;
        if (!sameEditValue(value, expected)) continue;
        value = command.commandType === 'updateWork' ? command.changes[key]
          : command.commandType === 'setReleaseSubscription' ? command.enabled
          : command.commandType === 'setOwnershipTracking' ? {editionIndex: command.editionIndex, count: command.count} : value;
      }
      return sameEditValue(value, authoritative) ? null : {value: value as T, pending: false, conflict: null};
    }
    const command = row.command;
    const value = command.commandType === 'updateWork' ? command.changes[key]
      : command.commandType === 'setReleaseSubscription' ? command.enabled
      : command.commandType === 'setOwnershipTracking' ? {editionIndex: command.editionIndex, count: command.count} : authoritative;
    return {value: value as T, pending: row.state !== 'accepted', conflict: row.state === 'conflict' ? {current: (row.conflict?.current?.work?.fields[key] ?? null) as CollectionEditValue} : null};
  };
  const resolveConflict = (workId: string, field: CollectionEditField, choice: 'overwrite' | 'discard') => {
    const key = field === 'memo' ? 'description' : field;
    const row = scoped.find(row => row.state === 'conflict' && row.command.workId === workId && row.command.commandType === 'updateWork' && key in row.command.changes);
    if (!row || row.command.commandType !== 'updateWork') return false;
    replaceCommand(row.command.operationId, choice === 'discard' ? null : {...row.command, expected: {[key]: row.conflict?.current?.work?.fields[key] ?? null}});
    if (choice === 'overwrite') void flush();
    return true;
  };
  return {identity, rows: scoped, acknowledgements: settledRows, failure, enqueue, enqueueBatch, edit, visible, resolveConflict, flush,
    drop: (workId: string) => { if (identity) dropWork(identity, workId); },
    observeLibrary: setLibrary,
    work: <T extends CollectionSummary>(item: T) => optimisticWork(confirmedWork(item, settledRows), scoped.filter(row=>row.state!=='accepted')),
    creations: scoped.flatMap(row => { const item = createdWork(row); return item ? [optimisticWork(item, scoped)] : []; }),
    reconcile: (item: CollectionSummary, source: 'list' | 'detail' = 'list', readStartedAt?: number) => { if (identity) reconcileCommands(identity, item, source, readStartedAt); }};
}
