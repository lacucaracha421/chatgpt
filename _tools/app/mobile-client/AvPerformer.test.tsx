import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api, native: mocks.native}));
vi.mock('./media', () => ({mediaTicket: vi.fn()}));
import {ApiError} from './transport';
import {AvPerformerScreen} from './AvPerformer';
import {AuthorityQueue} from './CollectionAuthorityForms';
import {useCollectionAuthority} from './useCollectionAuthority';
import {AUTHORITY_STATUS_PATH, COMMAND_PATH, clearPersonNotice, readCommands, type PersonCommand} from './collectionCommandOutbox';
import type {CollectionPage, CollectionPerson, CollectionSummary} from './collectionModel';

const identity = {libraryId: 'e'.repeat(32), epoch: 5, contractVersion: 1 as const};
const work: CollectionSummary = {id: 'av-a', name: '오후의 창가', type: 'av', showcase: false, releaseDate: '2026-08-14',
  av: {productCode: 'LMNS-123', genres: [], releaseDate: '2026-08-14', people: [{id: 'p1', name: '하야세 미오', role: 'performer', order: 0, creditName: null}]}};
const listPage: CollectionPage = {ready: true, filterVersion: 1, revision: 'r1', publishedAt: null, totalCount: 1, items: [work], nextCursor: null};
let person: CollectionPerson | null, active: boolean, send: (body: PersonCommand) => unknown;
const sent = () => mocks.api.mock.calls.filter(([path]) => path === COMMAND_PATH).map(([, , body]) => body as PersonCommand);
const personReads = () => mocks.api.mock.calls.filter(([path]) => path === '/v1/collections/people/p1').length;
beforeEach(() => {
  localStorage.clear(); setOutboxConnection('https://test.example'); mocks.api.mockReset(); mocks.native.mockReset(); clearPersonNotice('p1');
  person = {id: 'p1', memo: '첫 메모', favorite: false, profile: null, portrait: null}; active = true; send = () => ({});
  mocks.api.mockImplementation(async (path: string, _signal: unknown, body: PersonCommand) => {
    if (path === AUTHORITY_STATUS_PATH) return active ? {...identity, active: true} : {active: false};
    if (path === '/v1/collections/people/p1') { if (!person) throw new ApiError('없음', 404, null); return {person}; }
    if (path.startsWith('/v1/collections?type=av')) return listPage;
    if (path === COMMAND_PATH) {
      const reply = await send(body); if (reply instanceof Error) throw reply;
      // The server applies the change, as a later read shows.
      if (person) person = {...person, ...body.changes};
      return {...body, ...reply as object};
    }
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Harness() {
  const authority = useCollectionAuthority(true, () => {}, true);
  return <AvPerformerScreen personId="p1" currentId={null} active privacy={false} perRow={4} order="newest" authority={authority}
    onOpen={() => {}} onPerformer={() => {}} onSort={() => {}} onView={() => {}}/>;
}
const open = async () => { render(<Harness/>); return screen.findByRole('region', {name: '내 메모'}); };
const editable = () => screen.findByRole('button', {name: '즐겨찾기'});

describe('tablet performer 즐겨찾기 and 내 메모', () => {
  it('toggles 즐겨찾기 at once, queues setPerson with the confirmed value and keeps the star while it is sent', async () => {
    let release: (value: unknown) => void = () => {};
    send = () => new Promise(resolve => { release = resolve; });
    await open();
    fireEvent.click(await editable());
    // Shown at once and while the command is on its way.
    expect(screen.getByRole('button', {name: '즐겨찾기 해제'})).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({...identity, commandType: 'setPerson', personId: 'p1', changes: {favorite: true}, expected: {favorite: false}});
    expect(readCommands()[0]).toMatchObject({label: '하야세 미오'});
    expect(screen.getByRole('button', {name: '즐겨찾기 해제'})).toBeTruthy();
    const reads = personReads();
    await act(async () => { release({}); });
    // The acknowledgement asks for a fresh read; the star never goes back in between.
    await waitFor(() => expect(personReads()).toBe(reads + 1));
    expect(screen.getByRole('button', {name: '즐겨찾기 해제'})).toBeTruthy();
    await waitFor(() => expect(readCommands()).toEqual([]));
    expect(screen.getByRole('button', {name: '즐겨찾기 해제'})).toBeTruthy();
  });

  it('edits 내 메모 in a sheet: trims, clears to nothing, queues nothing when unchanged and refuses over 2,000', async () => {
    const memo = await open();
    await editable();
    fireEvent.click(within(memo).getByRole('button', {name: '배우 메모 편집'}));
    let dialog = await screen.findByRole('dialog', {name: '내 메모'});
    const box = within(dialog).getByLabelText('배우 메모');
    expect(box).toHaveValue('첫 메모');
    fireEvent.change(box, {target: {value: '  첫 메모 \n'}});
    fireEvent.click(within(dialog).getByRole('button', {name: '저장'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(readCommands()).toEqual([]);

    fireEvent.click(within(memo).getByRole('button', {name: '첫 메모'}));
    dialog = await screen.findByRole('dialog', {name: '내 메모'});
    fireEvent.change(within(dialog).getByLabelText('배우 메모'), {target: {value: 'あ'.repeat(2001)}});
    expect(within(dialog).getByRole('alert')).toHaveTextContent('메모는 2,000자까지 쓸 수 있습니다.');
    expect(within(dialog).getByRole('button', {name: '저장'})).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('배우 메모'), {target: {value: '  새 메모  '}});
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', {name: '저장'}));
    expect(within(memo).getByRole('button', {name: '새 메모'})).toBeTruthy();
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({changes: {memo: '새 메모'}, expected: {memo: '첫 메모'}});

    fireEvent.click(within(memo).getByRole('button', {name: '배우 메모 편집'}));
    dialog = await screen.findByRole('dialog', {name: '내 메모'});
    fireEvent.change(within(dialog).getByLabelText('배우 메모'), {target: {value: '   '}});
    fireEvent.click(within(dialog).getByRole('button', {name: '저장'}));
    expect(within(memo).getByRole('button', {name: '메모 쓰기'})).toBeTruthy();
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toMatchObject({changes: {memo: null}, expected: {memo: '새 메모'}});
  });

  it('shows a refusal as 충돌 with 덮어쓰기 over the server value, and locks editing until it is resolved', async () => {
    let calls = 0;
    send = () => ++calls === 1 ? new ApiError('충돌', 409, {detail: {code: 'revisionConflict', current: {person: {personId: 'p1', memo: '다른 기기', favorite: false}}}}) : {};
    await open();
    fireEvent.click(await editable());
    expect(await screen.findByText('충돌')).toBeTruthy();
    expect(screen.getByText('다른 기기에서 배우 정보가 바뀌었습니다.')).toBeTruthy();
    expect(screen.getByRole('button', {name: '즐겨찾기 해제'})).toBeDisabled();
    expect(screen.getByRole('button', {name: '배우 메모 편집'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name: '덮어쓰기'}));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toMatchObject({changes: {favorite: true}, expected: {favorite: false}});
    await waitFor(() => expect(screen.queryByText('충돌')).toBeNull());
    expect(screen.getByRole('button', {name: '즐겨찾기 해제'})).not.toBeDisabled();
  });

  it('lists a refused person change on the shelf queue with the performer name', async () => {
    send = () => new ApiError('충돌', 409, {detail: {code: 'revisionConflict', current: {person: {personId: 'p1', memo: '첫 메모', favorite: false}}}});
    function Shelf() { const authority = useCollectionAuthority(true, () => {}, true); return <AuthorityQueue authority={authority} onForm={() => {}}/>; }
    await open();
    fireEvent.click(await editable());
    await screen.findByText('충돌');
    cleanup();
    render(<Shelf/>);
    expect(await screen.findByText('하야세 미오 배우 정보')).toBeTruthy();
    expect(screen.getByRole('button', {name: '덮어쓰기'})).toBeTruthy();
    expect(screen.getByRole('button', {name: '버리기'})).toBeTruthy();
  });

  it('버리기 drops a refused change and shows the server value again', async () => {
    send = () => new ApiError('충돌', 409, {detail: {code: 'revisionConflict', current: {person: {personId: 'p1', memo: '첫 메모', favorite: true}}}});
    await open();
    fireEvent.click(await editable());
    expect(await screen.findByText('충돌')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '버리기'}));
    await waitFor(() => expect(readCommands()).toEqual([]));
    expect(screen.getByRole('button', {name: '즐겨찾기'})).toHaveAttribute('aria-pressed', 'false');
  });

  it('says so when the server has no such person, and drops the change', async () => {
    send = () => new ApiError('없음', 404, {detail: {code: 'personNotFound', personId: 'p1'}});
    await open();
    fireEvent.click(await editable());
    expect(await screen.findByText('서버에 하야세 미오 배우 정보가 없어 변경을 보내지 못했습니다.')).toBeTruthy();
    expect(readCommands()).toEqual([]);
    expect(screen.getByRole('button', {name: '즐겨찾기'})).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', {name: '닫기'}));
    await waitFor(() => expect(screen.queryByText(/배우 정보가 없어/)).toBeNull());
  });

  it('offers no editing without an active authority or a server person', async () => {
    active = false;
    const memo = await open();
    await act(async () => {});
    expect(within(memo).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', {name: '즐겨찾기'})).toBeNull();
    cleanup();
    active = true; person = null;
    render(<Harness/>);
    await screen.findByRole('region', {name: '프로필 정보'});
    await act(async () => {});
    expect(screen.queryByRole('region', {name: '내 메모'})).toBeNull();
    expect(screen.queryByRole('button', {name: /즐겨찾기/})).toBeNull();
  });
});
