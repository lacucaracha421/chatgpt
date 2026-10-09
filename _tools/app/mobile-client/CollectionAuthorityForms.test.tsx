import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, renderHook, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api, native: mocks.native}));
vi.mock('./media', () => ({mediaTicket: vi.fn()}));
import {ApiError} from './transport';
import {Collections} from './Collections';
import {TrashLayer} from './TrashLayer';
import {NotesStore} from '../src/notes/store';
import {TRASH_SECTION_STORAGE_KEY} from '../src/safety/trashSections';
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
    if (path === COMMAND_PATH || path === '/v1/collections/personal-edits') { const reply = await command(body!); if (reply instanceof Error) throw reply; return {...body, ...reply as object}; }
    if (path.startsWith('/v1/collections?')) return {ready: true, filterVersion: 1, revision: 'r1', items: [item], nextCursor: null, publishedAt: null};
    return {revision: 'r1', item};
  });
  mocks.native.mockResolvedValue({url: 'https://example.invalid/cover', expires_in: 300});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const sent = () => mocks.api.mock.calls.filter(([path]) => path === COMMAND_PATH).map(([, , body]) => body);
/** Opens 컬렉션 편집 from the work detail's 작품 관리 menu. */
const openEdit = async () => {
  fireEvent.click(await screen.findByRole('button', {name: '작품 관리'}));
  fireEvent.click(within(screen.getByRole('dialog', {name: '작품 관리'})).getByRole('button', {name: '컬렉션 편집'}));
  return screen.findByRole('dialog', {name: '컬렉션 편집'});
};
describe('activation-gated tablet forms', () => {
  it('opens the AV editor from the work menu and keeps the detail mounted with optimistic details and credit names', async () => {
    localStorage.setItem('lakomics.mobile.collectionView.av.v1', JSON.stringify({layout:'grid',perRow:4}));
    const av: CollectionDetail = {...item, id:'av-edit', type:'av', av:{productCode:'OLD-001',titleJa:'以前の題名',maker:'제작',label:'기존 레이블',series:null,genres:[],releaseDate:null,
      people:[{id:'actor',name:'배우 이름',role:'performer',order:0,creditName:null}]}};
    command = () => new Error('offline');
    const previous = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (path:string, ...args:unknown[]) => {
      if (path.startsWith('/v1/collections?')) return {ready:true,filterVersion:1,revision:'r1',items:[av],nextCursor:null,publishedAt:null};
      if (path===`/v1/collections/${av.id}`) return {revision:'r1',item:av,entityRevision:9};
      return previous(path,...args);
    });
    const backRef={current:null as null|(()=>boolean)};
    render(<Collections active paused={false} backRef={backRef}/>);
    fireEvent.click(await screen.findByRole('radio',{name:'AV'}));
    // The first tap picks the tile; the second opens the work.
    fireEvent.click(await screen.findByText(av.name));
    fireEvent.click(await screen.findByText(av.name));
    const article=await screen.findByRole('article',{name:'AV 작품 화면'});
    fireEvent.click(await screen.findByRole('button',{name:'작품 관리'}));
    fireEvent.click(within(screen.getByRole('dialog',{name:'작품 관리'})).getByRole('button',{name:'AV 정보 편집'}));
    const dialog=screen.getByRole('dialog',{name:'AV 정보 편집'});
    fireEvent.change(within(dialog).getByLabelText('일본어 제목'),{target:{value:'新しい題名'}});
    fireEvent.change(within(dialog).getByLabelText('레이블'),{target:{value:'새 레이블'}});
    fireEvent.change(within(dialog).getByLabelText('배우 이름 작품 내 표기'),{target:{value:'작품 표기'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'저장'}));
    await waitFor(()=>expect(readCommands()).toHaveLength(2));
    expect(readCommands()[0].command).toMatchObject({commandType:'setAvCredits',expectedRevision:9,people:[]});
    expect(readCommands()[1].command).toMatchObject({commandType:'setAvDetails',changes:{titleJa:'新しい題名',label:'새 레이블'},expected:{titleJa:'以前の題名',label:'기존 레이블'}});
    act(()=>{expect(backRef.current?.()).toBe(true);});
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'AV 정보 편집'})).toBeNull());
    expect(await screen.findByRole('heading',{name:'新しい題名',level:1})).toBeTruthy();
    expect(screen.getByRole('article',{name:'AV 작품 화면'})).toBe(article);
    expect(within(article).getAllByText('새 레이블').length).toBeGreaterThan(0);
    expect(within(article).getByRole('region',{name:'출연 · 감독'})).toHaveTextContent('작품 표기');
    expect(screen.getAllByText('대기').length).toBeGreaterThan(0);
  });
  it('keeps create and work management hidden while inactive', async () => {
    active = false;
    localStorage.setItem('lakomics.mobile.collectionView.game.v1', JSON.stringify({layout: 'grid', perRow: 4}));
    render(<Collections active paused={false} backRef={{current: null}}/>);
    await screen.findByText(item.name); await act(async () => {});
    expect(screen.queryByRole('button', {name: '새 작품'})).toBeNull();
    fireEvent.click(screen.getByText(item.name)); await screen.findByRole('group', {name: '작품 동작'});
    expect(screen.queryByRole('button', {name: '작품 관리'})).toBeNull();
    expect(screen.queryByRole('button', {name: '휴지통'})).toBeNull();
  });
  it.each([['게임', 'game'], ['만화', 'manga'], ['영화', 'movie'], ['AV', 'av']] as const)('shows the top-bar plus on %s and defaults to its type', async (label, kind) => {
    render(<Collections active paused={false} backRef={{current: null}}/>);
    await screen.findByRole('button', {name: '새 작품'});
    fireEvent.click(screen.getAllByRole('radio', {name: label})[0]);
    const plus = screen.getByRole('button', {name: '새 작품'});
    expect(plus.closest('.top-bar')).not.toBeNull();
    expect(plus.textContent).toBe('');
    expect(screen.queryByRole('button', {name: '검색'}) !== null).toBe(kind !== 'av');
    // AV has no type shortcuts; the others keep only their own shortcuts in the section bar.
    const shortcuts = screen.queryByRole('group', {name: '컬렉션 바로가기'});
    expect(shortcuts === null).toBe(kind === 'av');
    if (shortcuts) {
      expect(within(shortcuts).queryByRole('button', {name: '새 작품'})).toBeNull();
      expect(within(shortcuts).queryByRole('button', {name: /에서 .* 추가/})).toBeNull();
    }
    fireEvent.click(plus);
    const dialog = screen.getByRole('dialog', {name: '새 컬렉션'});
    expect(within(dialog).getAllByRole('textbox').map(input => input.getAttribute('id'))).toHaveLength(2);
    expect(within(dialog).getByLabelText('이름')).toBeTruthy();
    expect(within(dialog).getByLabelText('설명')).toBeTruthy();
    expect(within(dialog).getByRole('radio', {name: label}).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog).getAllByRole('radio').map(button => button.getAttribute('aria-label'))).toEqual(['게임', '만화', '영화', '시리즈', 'AV']);
    expect(screen.queryByLabelText('개발사')).toBeNull();
    expect(screen.getByRole('button', {name: '취소'})).toBeTruthy();
  });
  it('blocks blank names with the existing validation and reopens a fresh draft after cancelling', async () => {
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(await screen.findByRole('button', {name: '새 작품'}));
    const save = screen.getByRole('button', {name: '저장'}) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '   '}});
    expect(save.disabled).toBe(true);
    fireEvent.click(save); expect(readCommands()).toHaveLength(0);
    fireEvent.submit(save.closest('form')!);
    expect(screen.getByRole('alert').textContent).toBe('이름을 입력해 주세요.');
    fireEvent.click(screen.getByRole('button', {name: '취소'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', {name: '새 작품'}));
    expect((screen.getByLabelText('이름') as HTMLInputElement).value).toBe('');
  });
  it('queues name, description and chosen type and switches tabs before opening the pending detail', async () => {
    command = () => new Error('offline');
    const backRef = {current: null as null | (() => boolean)};
    render(<Collections active paused={false} backRef={backRef}/>);
    fireEvent.click(await screen.findByRole('button', {name: '새 작품'}));
    fireEvent.click(screen.getByRole('radio', {name: '영화'}));
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '새 영화'}});
    fireEvent.change(screen.getByLabelText('설명'), {target: {value: ' 영화 설명 '}});
    fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({...identity, commandType: 'createWork', type: 'movie', name: '새 영화', fields: {description: '영화 설명'}, legacyKind: null, binding: null});
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByRole('button', {name: '작품 관리'});
    expect(screen.getByRole('heading', {name: '새 영화'})).toBeTruthy();
    expect(screen.getAllByText('컬렉션 › 영화').length).toBeGreaterThan(0);
    expect(readCommands()[0].state).toBe('pending');
    expect(mocks.api.mock.calls.some(([path]) => path === `/v1/collections/${readCommands()[0].command.workId}`)).toBe(false);
    act(() => { expect(backRef.current?.()).toBe(true); });
    await screen.findByRole('button', {name: '새 작품'});
    expect(screen.getAllByRole('radio', {name: '영화'})[0].getAttribute('aria-checked')).toBe('true');
  });
  it.each([['시리즈', 'tv'], ['영화', 'movie']] as const)('opens %s TMDB search only after the create is accepted and the server detail is ready', async (label, kind) => {
    let accept!: (value: object) => void, showDetail!: (value: object) => void;
    command = () => new Promise(resolve => { accept = resolve; });
    const serverDetail = new Promise(resolve => { showDetail = resolve; });
    const base = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (path: string, ...args: unknown[]) => {
      if (path === '/v1/providers/status') return {tmdb: true, igdb: true};
      if (path === `/v1/collections/${sent()[0]?.workId}`) return serverDetail;
      if (path.includes('/search?')) return {items: []};
      return base(path, ...args);
    });
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(await screen.findByRole('button', {name: '새 작품'}));
    fireEvent.click(screen.getByRole('radio', {name: label}));
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '새 작품 이름'}});
    fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({commandType: 'createWork', type: 'movie', name: '새 작품 이름'});
    await screen.findByRole('heading', {name: '새 작품 이름'});
    expect(readCommands()[0].state).toBe('pending');
    expect(screen.queryByRole('dialog', {name: 'TMDB에 연결'})).toBeNull();
    expect(mocks.api.mock.calls.some(([path]) => path.includes('/search?'))).toBe(false);
    await act(async () => { accept({}); });
    await waitFor(() => expect(readCommands()[0].state).toBe('accepted'));
    expect(screen.queryByRole('dialog', {name: 'TMDB에 연결'})).toBeNull();
    expect(screen.getByRole('heading', {name: '새 작품 이름'})).toBeTruthy();
    const created = {...item, id: sent()[0].workId, type: 'movie', name: '새 작품 이름'};
    await act(async () => { showDetail({revision: 'r2', item: created}); });
    const sheet = await screen.findByRole('dialog', {name: 'TMDB에 연결'});
    expect(within(sheet).getByLabelText('검색어')).toHaveValue('새 작품 이름');
    expect(within(sheet).getByRole('radio', {name: kind === 'tv' ? 'TV 시리즈' : '영화'})).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(mocks.api.mock.calls.some(([path]) => path === `/v1/providers/tmdb/search?${new URLSearchParams({query: created.name, kind})}`)).toBe(true));
    fireEvent.click(within(sheet).getByRole('button', {name: '닫기'}));
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'TMDB에 연결'})).toBeNull());
  });
  it('keeps a rejected series create in the existing conflict path without opening TMDB', async () => {
    command = () => new ApiError('충돌', 409, {detail: {code: 'nameConflict'}});
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(await screen.findByRole('button', {name: '새 작품'}));
    fireEvent.click(screen.getByRole('radio', {name: '시리즈'}));
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '같은 시리즈'}});
    fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(readCommands()[0].state).toBe('conflict'));
    expect(sent()[0].type).toBe('movie');
    expect(screen.queryByRole('dialog', {name: 'TMDB에 연결'})).toBeNull();
    expect(mocks.api.mock.calls.some(([path]) => path.includes('/search?'))).toBe(false);
    fireEvent.click(await screen.findByRole('button', {name: '확인'}));
    expect(await screen.findByRole('dialog', {name: '새 컬렉션'})).toBeTruthy();
  });
  it('does not show management for an active authority belonging to another library', async () => {
    mocks.api.mockImplementation(async (path: string) => path === AUTHORITY_STATUS_PATH ? {...identity, libraryId: 'f'.repeat(32), active: true}
      : path === '/v1/collections/status' ? status : {ready: true, filterVersion: 1, revision: 'r1', items: [item], nextCursor: null});
    render(<Collections active paused={false} backRef={{current: null}}/>);
    await screen.findByText(item.name); await act(async () => {});
    expect(screen.queryByRole('button', {name: '새 작품'})).toBeNull();
  });
  it('opens the confirmed work detail after a successful create', async () => {
    const previous = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (path: string, ...args: unknown[]) => {
      const create = sent().find(body => body.commandType === 'createWork');
      if (create && path === `/v1/collections/${create.workId}`) return {revision: 'r2', item: {...item, id: create.workId, name: create.name, description: create.fields.description}};
      return previous(path, ...args);
    });
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(await screen.findByRole('button', {name: '새 작품'}));
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '확정된 작품'}});
    fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await screen.findByRole('heading', {name: '확정된 작품'});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent()[0]).toMatchObject({commandType: 'createWork', type: 'game', fields: {description: null}});
    await waitFor(() => expect(mocks.api.mock.calls.some(([path]) => path === `/v1/collections/${sent()[0].workId}`)).toBe(true));
  });
  it('shows nameConflict inline, keeps the draft and corrects it under a fresh operation id', async () => {
    command = () => new ApiError('중복', 409, {detail: {code: 'nameConflict'}});
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click((await screen.findAllByRole('button', {name: '새 작품'}))[0]);
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '겹친 이름'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    fireEvent.click(await screen.findByRole('button', {name: '확인'}));
    await screen.findByText('같은 종류에 같은 이름의 작품이 있습니다.');
    expect((screen.getByRole('textbox', {name: /^이름/}) as HTMLInputElement).value).toBe('겹친 이름');
    const first = sent()[0].operationId; command = () => ({});
    fireEvent.change(screen.getByRole('textbox', {name: /^이름/}), {target: {value: '다른 이름'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1].name).toBe('다른 이름'); expect(sent()[1].operationId).not.toBe(first);
  });
  it('edits the name and basic info in one 컬렉션 편집 form, sending only changed fields in one updateWork', async () => {
    localStorage.setItem('lakomics.mobile.collectionView.game.v1', JSON.stringify({layout: 'grid', perRow: 4}));
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(await screen.findByText(item.name));
    const form = await openEdit();
    expect(screen.queryByRole('dialog', {name: '작품 관리'})).toBeNull();
    expect(within(form).queryByRole('group', {name: '유형'})).toBeNull();
    expect(within(form).queryByLabelText('설명')).toBeNull();
    // The PC dialog's game fields, in its order.
    expect([...form.querySelectorAll('label')].map(label => label.textContent)).toEqual(['이름', '개발사', '퍼블리셔', '플랫폼', '출시일', '외부 점수']);
    expect((within(form).getByLabelText('이름') as HTMLInputElement).value).toBe(item.name);
    fireEvent.change(within(form).getByLabelText('이름'), {target: {value: '바꾼 이름'}});
    fireEvent.change(within(form).getByLabelText('개발사'), {target: {value: '새 개발사'}});
    fireEvent.click(within(form).getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({commandType: 'updateWork', changes: {name: '바꾼 이름', developer: '새 개발사'}, expected: {name: item.name, developer: '개발사'}, expectedRevision: null});
    expect(Object.keys(sent()[0].changes).sort()).toEqual(['developer', 'name']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const again = await openEdit();
    fireEvent.change(within(again).getByLabelText('퍼블리셔'), {target: {value: '퍼블리셔'}}); fireEvent.click(within(again).getByRole('button', {name: '저장'}));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toMatchObject({changes: {publisher: '퍼블리셔'}, expected: {publisher: null}});
    expect(sent()[1].changes).not.toHaveProperty('type');
  });
  it('validates the shared fields with the PC wording before queueing', async () => {
    mocks.api.mockImplementation(async (path: string) => path === AUTHORITY_STATUS_PATH ? {...identity, active: true} : path === '/v1/collections/status' ? status
      : path.startsWith('/v1/collections?') ? {ready: true, filterVersion: 1, revision: 'r1', items: [{...item, type: 'movie', id: 'movie-1'}], nextCursor: null}
      : {revision: 'r1', item: {...item, type: 'movie', id: 'movie-1'}});
    localStorage.setItem('lakomics.mobile.collectionView.movie.v1', JSON.stringify({layout: 'grid', perRow: 4}));
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click((await screen.findAllByRole('radio', {name: '영화'}))[0]);
    fireEvent.click(await screen.findByText(item.name));
    const form = await openEdit();
    expect([...form.querySelectorAll('label')].map(label => label.textContent)).toEqual(['이름', '원제', '상영 시간(분)', '제작사', '감독', '개봉 연도']);
    fireEvent.change(within(form).getByLabelText('상영 시간(분)'), {target: {value: '0'}});
    fireEvent.submit(form.querySelector('form')!);
    expect(within(form).getByRole('alert').textContent).toBe('상영 시간은 1분 이상이어야 합니다.');
    expect(readCommands()).toHaveLength(0);
  });
  it('automatically opens an offline create, retains it on the shelf, and can reopen it without a detail read', async () => {
    command = () => new Error('offline');
    localStorage.setItem('lakomics.mobile.collectionView.game.v1', JSON.stringify({layout: 'grid', perRow: 4}));
    const backRef = {current: null as null | (() => boolean)};
    render(<Collections active paused={false} backRef={backRef}/>);
    fireEvent.click((await screen.findAllByRole('button', {name: '새 작품'}))[0]);
    fireEvent.change(screen.getByLabelText('이름'), {target: {value: '오프라인 작품'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await waitFor(() => expect(readCommands()[0]?.attempts).toBe(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByRole('button', {name: '작품 관리'});
    expect(screen.getByRole('heading', {name: '오프라인 작품'})).toBeTruthy();
    act(() => { backRef.current?.(); });
    const tile = screen.getByRole('button', {name: /오프라인 작품/}); fireEvent.click(tile);
    await screen.findByRole('button', {name: '작품 관리'});
    expect(mocks.api.mock.calls.some(([path]) => path === `/v1/collections/${readCommands()[0].command.workId}`)).toBe(false);
  });
  it('retains the original name expectation when correcting a rename nameConflict', async () => {
    localStorage.setItem('lakomics.mobile.collectionView.game.v1', JSON.stringify({layout: 'grid', perRow: 4}));
    command = () => new ApiError('중복', 409, {detail: {code: 'nameConflict'}});
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(await screen.findByText(item.name)); await openEdit();
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
    fireEvent.click(await screen.findByText(item.name)); await openEdit();
    fireEvent.change(screen.getByLabelText('개발사'), {target: {value: '내 개발사'}}); fireEvent.click(screen.getByRole('button', {name: '저장'}));
    await screen.findByText('다른 기기에서 작품 정보가 바뀌었거나 변경을 받지 못했습니다. 내용을 확인해 주세요.');
    // Closing keeps the conflict in the detail's queue; 확인 reopens the same merged form.
    fireEvent.click(screen.getByRole('button', {name: '닫기'}));
    await waitFor(() => expect(screen.queryByRole('dialog', {name: '컬렉션 편집'})).toBeNull());
    expect(screen.getByText('충돌')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '확인'}));
    const form = await screen.findByRole('dialog', {name: '컬렉션 편집'});
    expect((within(form).getByLabelText('이름') as HTMLInputElement).value).toBe(item.name);
    expect((within(form).getByLabelText('개발사') as HTMLInputElement).value).toBe('내 개발사');
    command = () => ({}); fireEvent.click(within(form).getByRole('button', {name: '저장'}));
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
describe('delete and 휴지통', () => {
  const DAY = 86_400_000;
  let trashItems: unknown[] | Error, hold: boolean, held: (() => void)[] = [];
  // A held send settles after its test, so the shared delivery pass never outlives it.
  afterEach(async () => { held.splice(0).forEach(release => release()); await act(async () => {}); });
  beforeEach(() => {
    localStorage.setItem('lakomics.mobile.collectionView.game.v1', JSON.stringify({layout: 'grid', perRow: 4}));
    trashItems = []; hold = false;
    const previous = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (path: string, ...args: unknown[]) => {
      if (path === COMMAND_PATH && hold) return new Promise((_, reject) => { held.push(() => reject(new Error('released'))); });
      if (path.startsWith('/v1/collections/authority/trash?')) { if (trashItems instanceof Error) throw trashItems; return {...identity, retentionDays: 30, items: trashItems, hasMore: false}; }
      if (path === `/v1/collections/${item.id}`) return {revision: 'r1', item, entityRevision: 4};
      return previous(path, ...args);
    });
  });
  const openTrash = async () => {
    localStorage.setItem(TRASH_SECTION_STORAGE_KEY, 'collections');
    const store=new NotesStore(async <T,>() => ({unlocked:true,notes:[]} as T));
    render(<TrashLayer endpoint="https://test.example" store={store} known={new Map()} onRestored={()=>{}} onClose={()=>{}} backRef={{current:null}}/>);
    const screenLayer=screen.getByRole('dialog',{name:'휴지통'});
    await act(async()=>{});
    return screenLayer;
  };
  const shortcuts = () => screen.getByRole('group', {name: '컬렉션 바로가기'});
  const openDelete = async () => {
    fireEvent.click(await screen.findByText(item.name));
    fireEvent.click(await screen.findByRole('button', {name: '작품 관리'}));
    const remove = within(screen.getByRole('dialog', {name: '작품 관리'})).getByRole('button', {name: /^컬렉션 삭제/});
    await waitFor(() => expect(remove).toBeEnabled()); fireEvent.click(remove);
    return screen.findByRole('dialog', {name: '컬렉션 삭제'});
  };
  it('confirms with the PC wording, queues deleteWork at the shown revision, closes the detail and hides the work while it is sent', async () => {
    hold = true;
    render(<Collections active paused={false} backRef={{current: null}}/>);
    const dialog = await openDelete();
    expect(within(dialog).getByText(`${item.name} 컬렉션을 삭제하시겠습니까? 원본 에셋은 삭제하지 않습니다. 30일 동안 휴지통에서 되살릴 수 있어요.`)).toBeTruthy();
    expect(within(dialog).getByRole('button', {name: '삭제'})).toHaveClass('ui-button--danger');
    fireEvent.click(within(dialog).getByRole('button', {name: '삭제'}));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({...identity, operationId: expect.any(String), commandType: 'deleteWork', workId: item.id, expectedRevision: 4});
    await waitFor(() => expect(screen.queryByRole('button', {name: '작품 관리'})).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    // Off the shelf at once; the shelf's queue names the delete on its way.
    expect(screen.queryByRole('button', {name: new RegExp(item.name)})).toBeNull();
    expect(screen.getByText(`${item.name} 삭제`)).toBeTruthy();
    expect(screen.queryByRole('button', {name: '다시 시도'})).toBeNull();
  });
  it('never hides a delete that could not be sent: the work returns with the reason, 다시 시도 delivers it', async () => {
    command = () => new Error('서버에 연결하지 못했습니다.');
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(within(await openDelete()).getByRole('button', {name: '삭제'}));
    await screen.findByText('서버에 연결하지 못했습니다.');
    expect(readCommands()[0]).toMatchObject({state: 'pending', attempts: 1, label: item.name});
    expect(screen.getByRole('button', {name: new RegExp(item.name)})).toBeTruthy();
    expect(screen.getByText(`${item.name} 삭제`)).toBeTruthy();
    command = () => ({});
    fireEvent.click(screen.getByRole('button', {name: '다시 시도'}));
    await waitFor(() => expect(readCommands()).toHaveLength(0));
    expect(sent().filter(body => body.commandType === 'deleteWork')).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole('button', {name: new RegExp(item.name)})).toBeNull());
  });
  it.each([['delivers', false], ['shows and lets go of', true]] as const)('%s a delete left queued by 0.9.34', async (_, offline) => {
    // 0.9.34 hid a queued delete for good; a row from an earlier run is shown until it is confirmed.
    const stuck = {command: {...identity, operationId: 'old-delete', commandType: 'deleteWork', workId: item.id, expectedRevision: 1},
      label: item.name, createdAt: Date.now() - 3_600_000, attempts: 0, nextAttemptAt: Date.now() + 60_000, state: 'pending'};
    localStorage.setItem(`lakomics.collections.commands.outbox.v1.${encodeURIComponent('https://test.example')}`, JSON.stringify([stuck]));
    hold = true;
    render(<Collections active paused={false} backRef={{current: null}}/>);
    expect(await screen.findByRole('button', {name: new RegExp(item.name)})).toBeTruthy();
    expect(screen.getByText(`${item.name} 삭제`)).toBeTruthy();
    hold = false; command = () => offline ? new Error('오프라인') : {};
    fireEvent.click(screen.getByRole('button', {name: '다시 시도'}));
    if (!offline) {
      await waitFor(() => expect(readCommands()).toHaveLength(0));
      expect(sent().at(-1)).toMatchObject({operationId: 'old-delete', commandType: 'deleteWork'});
      await waitFor(() => expect(screen.queryByRole('button', {name: new RegExp(item.name)})).toBeNull());
    } else {
      await screen.findByText('오프라인');
      fireEvent.click(screen.getByRole('button', {name: '버리기'}));
      await waitFor(() => expect(readCommands()).toHaveLength(0));
      expect(screen.getByRole('button', {name: new RegExp(item.name)})).toBeTruthy();
    }
  });
  it('keeps a confirmed delete off the shelf and lets the queue go', async () => {
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(within(await openDelete()).getByRole('button', {name: '삭제'}));
    await waitFor(() => expect(sent()).toHaveLength(1));
    await waitFor(() => expect(readCommands()).toHaveLength(0));
    await act(async () => {});
    expect(screen.queryByRole('button', {name: new RegExp(item.name)})).toBeNull();
    expect(screen.queryByText(`${item.name} 삭제`)).toBeNull();
  });
  it('does nothing when cancelled', async () => {
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(within(await openDelete()).getByRole('button', {name: '취소'}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(readCommands()).toHaveLength(0); expect(sent()).toHaveLength(0);
    expect(screen.getByRole('button', {name: '작품 관리'})).toBeTruthy();
  });
  it('brings a rejected delete back to the shelf with its conflict in the queue', async () => {
    command = body => body.commandType === 'deleteWork' ? new ApiError('충돌', 409, {detail: {code: 'revisionConflict'}}) : {};
    render(<Collections active paused={false} backRef={{current: null}}/>);
    fireEvent.click(within(await openDelete()).getByRole('button', {name: '삭제'}));
    await screen.findByText('충돌');
    expect(screen.getByText(`${item.name} 삭제`)).toBeTruthy();
    expect(screen.getByRole('button', {name: new RegExp(item.name)})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '버리기'}));
    await waitFor(() => expect(readCommands()).toHaveLength(0));
  });
  it('lists trashed works newest first with their purge day and restores one optimistically', async () => {
    hold = true;
    trashItems = [
      {workId: 'old-2', type: 'movie', name: '지운 영화', trashedAt: '2026-10-05T00:00:00Z', purgeAt: new Date(Date.now() + 10 * DAY - 60_000).toISOString(), entityRevision: 7},
      {workId: 'old-1', type: 'manga', name: '지운 만화', trashedAt: '2026-10-01T00:00:00Z', purgeAt: new Date(Date.now() + 2 * DAY - 60_000).toISOString(), entityRevision: 3},
    ];
    const sheet = await openTrash();
    await within(sheet).findByText('지운 영화');
    const rows = within(sheet).getAllByRole('listitem');
    expect(rows.map(row => row.querySelector('strong')!.textContent)).toEqual(['지운 영화', '지운 만화']);
    expect(rows[0].textContent).toContain('영화 · 10일 후 영구 삭제');
    expect(rows[1].textContent).toContain('만화 · 2일 후 영구 삭제');
    fireEvent.click(within(rows[0]).getByRole('button', {name: '지운 영화 되살리기'}));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toEqual({...identity, operationId: expect.any(String), commandType: 'restoreWork', workId: 'old-2', expectedRevision: 7});
    expect(within(sheet).queryByText('지운 영화')).toBeNull();
    expect(screen.getByRole('tab',{name:'컬렉션 1'})).toBeTruthy();
  });
  it('brings a restore that could not be sent back to the list', async () => {
    command = () => new Error('오프라인');
    trashItems = [{workId: 'old-2', type: 'movie', name: '지운 영화', trashedAt: '2026-10-05T00:00:00Z', purgeAt: new Date(Date.now() + 10 * DAY).toISOString(), entityRevision: 7}];
    const sheet = await openTrash();
    await within(sheet).findByText('지운 영화');
    fireEvent.click(within(sheet).getByRole('button', {name: '지운 영화 되살리기'}));
    await waitFor(() => expect(readCommands()[0]).toMatchObject({state: 'pending', attempts: 1, lastError: '오프라인'}));
    expect(within(sheet).getByText('지운 영화')).toBeTruthy();
  });
  it('shows the empty state and no count when the trash is empty', async () => {
    const sheet=await openTrash();
    expect(await within(sheet.querySelector('.trash-section-list') as HTMLElement).findByText('휴지통이 비어 있습니다')).toBeTruthy();
    expect(screen.getByRole('tab',{name:'컬렉션'})).toBeTruthy();
  });
  it('removes the Collections trash shortcut even when the server supports it', async () => {
    render(<Collections active paused={false} backRef={{current: null}}/>);
    await screen.findByText(item.name); await act(async () => {});
    expect(within(shortcuts()).queryByRole('button', {name: /휴지통/})).toBeNull();
  });
});
