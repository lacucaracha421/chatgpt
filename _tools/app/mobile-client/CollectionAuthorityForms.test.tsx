import {act, cleanup, fireEvent, render, renderHook, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api, native: mocks.native}));
vi.mock('./media', () => ({mediaTicket: vi.fn()}));
import {ApiError} from './transport';
import {Collections} from './Collections';
import {useCollectionEdits} from './useCollectionEdits';
import {AUTHORITY_STATUS_PATH, COMMAND_PATH, readCommands} from './collectionCommandOutbox';
import {readCollectionEdits} from './collectionEditOutbox';
import type {CollectionDetail} from './collectionModel';

const identity = {libraryId: 'e'.repeat(32), epoch: 5, contractVersion: 1};
const item: CollectionDetail = {id: 'game-1', type: 'game', name: '기존 작품', developer: '개발사', showcase: false, artworks: [], volumes: []};
const status = {revision: 'r1', libraryId: identity.libraryId, capabilities: {collectionPersonalEdit: true, collectionRecordEdit: true}};
let active: boolean, command: (body: Record<string, unknown>) => unknown;
beforeEach(() => {
  localStorage.clear(); setOutboxConnection('https://test.example'); mocks.api.mockReset(); mocks.native.mockReset();
  active = true; command = () => ({});
  mocks.api.mockImplementation(async (path: string, _signal: unknown, body?: Record<string, unknown>) => {
    if (path === AUTHORITY_STATUS_PATH) return active ? {...identity, active: true} : {active: false};
    if (path === '/v1/collections/status') return status;
    if (path === COMMAND_PATH || path === '/v1/collections/personal-edits') { const reply = command(body!); if (reply instanceof Error) throw reply; return {...body, ...reply as object}; }
    if (path.startsWith('/v1/collections?')) return {ready: true, filterVersion: 1, revision: 'r1', items: [item], nextCursor: null, publishedAt: null};
    return {revision: 'r1', item};
  });
  mocks.native.mockResolvedValue({url: 'https://example.invalid/cover', expires_in: 300});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const sent = () => mocks.api.mock.calls.filter(([path]) => path === COMMAND_PATH).map(([, , body]) => body);
describe('activation-gated tablet forms', () => {
  it('keeps create and work management hidden while inactive', async () => {
    active = false;
    render(<Collections active paused={false} backRef={{current: null}}/>);
    await screen.findByText(item.name); await act(async () => {});
    expect(screen.queryByRole('button', {name: '새 작품'})).toBeNull();
    expect(screen.queryByRole('button', {name: '이름 바꾸기'})).toBeNull();
    expect(screen.queryByRole('button', {name: '기본 정보 편집'})).toBeNull();
  });
  it('shows create only for the current active library and exposes type-specific basic fields', async () => {
    render(<Collections active paused={false} backRef={{current: null}}/>);
    const buttons = await screen.findAllByRole('button', {name: '새 작품'}); fireEvent.click(buttons[0]);
    expect(screen.getByLabelText('개발사')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '만화'})); expect(screen.getByLabelText('작가')).toBeTruthy();
    expect(screen.queryByLabelText('개발사')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: '영화'})); expect(screen.getByLabelText('감독')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '새 영화'}});
    fireEvent.change(screen.getByLabelText('상영 시간(분)'), {target: {value: '90'}});
    fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({...identity, commandType: 'createWork', type: 'movie', name: '새 영화', fields: {runtimeMinutes: 90}, legacyKind: null, binding: null});
  });
  it('does not show management for an active authority belonging to another library', async () => {
    mocks.api.mockImplementation(async (path: string) => path === AUTHORITY_STATUS_PATH ? {...identity, libraryId: 'f'.repeat(32), active: true}
      : path === '/v1/collections/status' ? status : {ready: true, filterVersion: 1, revision: 'r1', items: [item], nextCursor: null});
    render(<Collections active paused={false} backRef={{current: null}}/>);
    await screen.findByText(item.name); await act(async () => {});
    expect(screen.queryByRole('button', {name: '새 작품'})).toBeNull();
  });
  it('shows nameConflict inline, keeps the draft and corrects it under a fresh operation id', async () => {
    command = () => new ApiError('중복', 409, {detail: {code: 'nameConflict'}});
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click((await screen.findAllByRole('button', {name: '새 작품'}))[0]);
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '겹친 이름'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await screen.findByText('같은 종류에 같은 이름의 작품이 있습니다.');
    expect((screen.getByRole('textbox', {name: /^이름/}) as HTMLInputElement).value).toBe('겹친 이름');
    const first = sent()[0].operationId; command = () => ({});
    fireEvent.change(screen.getByRole('textbox', {name: /^이름/}), {target: {value: '다른 이름'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1].name).toBe('다른 이름'); expect(sent()[1].operationId).not.toBe(first);
  });
  it('shows rename and basic info on an active work, with no type-change control', async () => {
    localStorage.setItem('lakomics.mobile.collectionView.game.v1', JSON.stringify({layout: 'grid', perRow: 4}));
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(await screen.findByText(item.name));
    fireEvent.click(await screen.findByRole('button', {name: '이름 바꾸기'}));
    expect(screen.queryByRole('group', {name: '유형'})).toBeNull();
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '바꾼 이름'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({commandType: 'updateWork', changes: {name: '바꾼 이름'}, expected: {name: item.name}});
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', {name: '기본 정보 편집'}));
    fireEvent.change(screen.getByLabelText('개발사'), {target: {value: '새 개발사'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toMatchObject({changes: {developer: '새 개발사'}, expected: {developer: '개발사'}});
    expect(sent()[1].changes).not.toHaveProperty('type');
  });
  it('retains a queued create in the shelf and opens it offline without a detail read', async () => {
    command = () => new Error('offline');
    localStorage.setItem('lakomics.mobile.collectionView.game.v1', JSON.stringify({layout: 'grid', perRow: 4}));
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click((await screen.findAllByRole('button', {name: '새 작품'}))[0]);
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '오프라인 작품'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(readCommands()[0]?.attempts).toBe(1));
    fireEvent.click(screen.getByRole('button', {name: '닫기'}));
    const tile = screen.getByRole('button', {name: /오프라인 작품/}); fireEvent.click(tile);
    await screen.findByRole('button', {name: '기본 정보 편집'});
    expect(mocks.api.mock.calls.some(([path]) => path === `/v1/collections/${readCommands()[0].command.workId}`)).toBe(false);
  });
  it('retains the original name expectation when correcting a rename nameConflict', async () => {
    localStorage.setItem('lakomics.mobile.collectionView.game.v1', JSON.stringify({layout: 'grid', perRow: 4}));
    command = () => new ApiError('중복', 409, {detail: {code: 'nameConflict'}});
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(await screen.findByText(item.name)); fireEvent.click(await screen.findByRole('button', {name: '이름 바꾸기'}));
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '겹친 이름'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await screen.findByText('같은 종류에 같은 이름의 작품이 있습니다.'); command = () => ({});
    fireEvent.change(screen.getByRole('textbox', {name: /^이름/}), {target: {value: '다른 이름'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1].expected).toEqual({name: item.name});
    expect(sent()[1].operationId).not.toBe(sent()[0].operationId);
  });
  it('does not overwrite untouched remote basic-info fields when retrying a conflict', async () => {
    localStorage.setItem('lakomics.mobile.collectionView.game.v1', JSON.stringify({layout: 'grid', perRow: 4}));
    command = () => new ApiError('충돌', 409, {detail: {code: 'revisionConflict', current: {work: {name: item.name, fields: {developer: '다른 개발사', publisher: '다른 퍼블리셔'}}}}});
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(await screen.findByText(item.name)); fireEvent.click(await screen.findByRole('button', {name: '기본 정보 편집'}));
    fireEvent.change(screen.getByLabelText('개발사'), {target: {value: '내 개발사'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await screen.findByText('다른 기기에서 작품 정보가 바뀌었거나 변경을 받지 못했습니다. 내용을 확인해 주세요.');
    command = () => ({}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1].changes).toEqual({developer: '내 개발사'});
    expect(sent()[1].expected).toEqual({developer: '다른 개발사'});
  });
});
describe('record routing', () => {
  it('keeps and resolves an authority memo conflict with a new operation id', async () => {
    command = () => new ApiError('충돌', 409, {detail: {code: 'revisionConflict', current: {work: {name: item.name, fields: {description: '다른 메모'}}}}});
    const view = renderHook(() => useCollectionEdits({active: true, onSettled: vi.fn()}));
    act(() => view.result.current.observeStatus(status)); await waitFor(() => expect(view.result.current.authority.identity).not.toBeNull());
    act(() => view.result.current.edit(item.id, 'memo', '내 메모', '원래 메모'));
    await waitFor(() => expect(view.result.current.visible(item.id, 'memo', '원래 메모').conflict?.current).toBe('다른 메모'));
    const first = readCommands()[0].command.operationId; command = () => ({});
    act(() => view.result.current.resolveConflict(item.id, 'memo', 'overwrite'));
    await waitFor(() => expect(readCommands()[0].state).toBe('accepted'));
    expect(readCommands()[0].command).toMatchObject({changes: {description: '내 메모'}, expected: {description: '다른 메모'}});
    expect(readCommands()[0].command.operationId).not.toBe(first);
  });
  it('keeps a confirmed value on a stale detail after the shelf reconciles, and lets a later remote edit win', async () => {
    const view = renderHook(() => useCollectionEdits({active: true, onSettled: vi.fn()}));
    act(() => view.result.current.observeStatus(status));
    await waitFor(() => expect(view.result.current.authority.identity).not.toBeNull());
    act(() => view.result.current.edit(item.id, 'memo', '새 메모', '원래 메모'));
    await waitFor(() => expect(readCommands()[0]?.state).toBe('accepted'));
    act(() => view.result.current.authority.reconcile({...item, description: '새 메모'}));
    expect(readCommands()).toHaveLength(0);
    expect(view.result.current.visible(item.id, 'memo', '원래 메모').value).toBe('새 메모');
    expect(view.result.current.authority.work({...item, description: '원래 메모'}).description).toBe('새 메모');
    expect(view.result.current.visible(item.id, 'memo', '다른 기기의 메모').value).toBe('다른 기기의 메모');
  });
  it.each([true, false])('routes status/platform/score/memo according to authority active=%s', async activation => {
    active = activation; command = () => new Error('offline');
    const view = renderHook(() => useCollectionEdits({active: true, onSettled: vi.fn()}));
    act(() => view.result.current.observeStatus(status));
    if (activation) await waitFor(() => expect(view.result.current.authority.identity).not.toBeNull());
    else await act(async () => {});
    for (const [field, value] of [['status', 'done'], ['ownedPlatform', 'PC'], ['myScore', 4], ['memo', '메모']] as const)
      act(() => view.result.current.edit(item.id, field, value, null));
    await act(async () => {});
    if (activation) {
      expect(Object.keys(readCollectionEdits())).toHaveLength(0);
      expect(readCommands()).toHaveLength(4);
      expect(readCommands().map(row => row.command.commandType)).toEqual(Array(4).fill('updateWork'));
      expect(sent()[0].changes).toEqual({status: 'done'});
      expect(view.result.current.visible(item.id, 'memo', null).value).toBe('메모');
    } else {
      expect(Object.keys(readCollectionEdits())).toHaveLength(4); expect(readCommands()).toHaveLength(0); expect(sent()).toHaveLength(0);
    }
  });
});
