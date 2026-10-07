import '@testing-library/jest-dom/vitest';
import {useState} from 'react';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import limits from '../src/collections/avLimits.json';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api}));
vi.mock('./CollectionProviders', () => ({useProviderBinding: () => ({provider: null}), ProviderArtworkSheet: () => null, ProviderSearchSheet: () => null}));
import {ApiError} from './transport';
import {WorkManage, type ManageSheet} from './CollectionWorkManage';
import {AuthorityQueue} from './CollectionAuthorityForms';
import {useCollectionAuthority} from './useCollectionAuthority';
import {AUTHORITY_STATUS_PATH, readCommands, type CommandIntent} from './collectionCommandOutbox';
import {AV_DETAIL_FIELDS, AV_INPUT_ERROR, avCredits, validateAvCredits, validateAvDetails} from './avEditModel';
import type {CollectionDetail} from './collectionModel';

const identity = {libraryId: 'e'.repeat(32), epoch: 5, contractVersion: 1 as const};
const item: CollectionDetail = {id: 'av-1', type: 'av', name: '작품', showcase: false, artworks: [], volumes: [], av: {
  productCode: 'AB-001', titleJa: '元の題名', maker: '메이커', label: '레이블', series: '시리즈', genres: ['기존 장르'], releaseDate: '2025-01-02',
  people: [{id: 'actor-1', name: '첫 배우', role: 'performer', order: 0, creditName: null}, {id: 'actor-2', name: '둘째 배우', role: 'performer', order: 1, creditName: '별명'},
    {id: 'director-1', name: '감독 이름', role: 'director', order: 0}],
}};
const other: CollectionDetail = {...item, id: 'av-2', av: {...item.av!, people: [{id: 'actor-known', name: '기존 인물', nameJa: '既存', role: 'performer', order: 0}]}};
let send: (body: Record<string, unknown>) => unknown;
beforeEach(() => {
  localStorage.clear(); setOutboxConnection('https://test.example'); mocks.api.mockReset(); send = () => new Error('offline');
  mocks.api.mockImplementation(async (path: string, _signal: unknown, body: Record<string, unknown>) => {
    if (path === AUTHORITY_STATUS_PATH) return {...identity, active: true};
    const result = await send(body); if (result instanceof Error) throw result;
    return {...body, ...result as object};
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Harness({work = item}: {work?: CollectionDetail}) {
  const authority = useCollectionAuthority(true, () => {} , true);
  const [sheet, setSheet] = useState<ManageSheet>('menu');
  const [retry, setRetry] = useState<CommandIntent>();
  const shown = authority.work(work);
  return <><output data-testid="shown">{JSON.stringify(shown.av)}</output>
    <button onClick={() => {setRetry(undefined);setSheet('menu');}}>관리 열기</button>
    <AuthorityQueue authority={authority} workId={work.id} item={shown} onForm={() => {}} onAvEdit={row => {setRetry(row);setSheet('av');}}/>
    {authority.identity && <WorkManage item={shown} confirmed={work} items={[work,other]} entityRevision={7} refreshing={false} avRetry={retry} authority={authority}
      status={{} as never} active sheet={sheet} onSheet={value => {setSheet(value);setRetry(undefined);}} onForm={() => {}} onDeleted={() => {}}/>}</>;
}
async function open(work = item) {
  render(<Harness work={work}/>);
  fireEvent.click(await screen.findByRole('button', {name: 'AV 정보 편집'}));
  return screen.findByRole('dialog', {name: 'AV 정보 편집'});
}
const save = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', {name: '저장'}));
describe('tablet AV editor', () => {
  it('does not queue untouched cast with gaps in published order numbers', async () => {
    const dialog = await open({...item,av:{...item.av!,genres:['쉼표, 포함'],people:item.av!.people.map((person,index)=>({...person,order:index*3+2}))}});
    fireEvent.change(within(dialog).getByLabelText('품번'),{target:{value:'DETAIL-ONLY'}}); save(dialog);
    await waitFor(()=>expect(readCommands()[0]?.attempts).toBe(1));
    expect(readCommands().map(row=>row.command.commandType)).toEqual(['setAvDetails']);
    expect(readCommands()[0].command).toMatchObject({changes:{productCode:'DETAIL-ONLY'}});
    if (readCommands()[0].command.commandType === 'setAvDetails') expect(Object.keys((readCommands()[0].command as {changes:object}).changes)).toEqual(['productCode']);
  });
  it('shows the seven fields, shared limits, roles, aliases and a bottom-sheet surface', async () => {
    const dialog = await open();
    expect(dialog.querySelector('.library-sheet.av-work-edit')).toBeTruthy();
    for (const field of AV_DETAIL_FIELDS) {
      const input = within(dialog).getByLabelText(field.label);
      if (field.maxLength) expect(input).toHaveAttribute('maxlength', String(field.maxLength));
    }
    expect(within(dialog).getByLabelText('일본어 제목')).toHaveValue('元の題名');
    expect(within(dialog).getByLabelText('장르')).toHaveValue('기존 장르');
    expect(within(dialog).getByLabelText('둘째 배우 작품 내 표기')).toHaveValue('별명');
    expect(within(dialog).getByLabelText('인물 이름 검색')).toHaveAttribute('maxlength', String(limits.personName));
    expect(within(dialog).getByLabelText('첫 배우 작품 내 표기')).toHaveAttribute('maxlength', String(limits.creditName));
  });
  it('queues only changed details with confirmed expected fields and shows the saved values while pending', async () => {
    const dialog = await open(), output = screen.getByTestId('shown');
    fireEvent.change(within(dialog).getByLabelText('품번'), {target: {value: ' NEW-002 '}});
    fireEvent.change(within(dialog).getByLabelText('장르'), {target: {value: ' 새 장르, 두번째 '}});
    fireEvent.change(within(dialog).getByLabelText('메이커'), {target: {value: ' '}});
    save(dialog);
    await waitFor(() => expect(readCommands()[0]?.attempts).toBe(1));
    expect(readCommands()).toHaveLength(1);
    expect(readCommands()[0].command).toMatchObject({commandType: 'setAvDetails', workId: item.id,
      changes: {productCode: 'NEW-002', genres: ['새 장르','두번째'], maker: null}, expected: {productCode: 'AB-001', genres: ['기존 장르'], maker: '메이커'}});
    expect(screen.getByTestId('shown')).toBe(output);
    expect(JSON.parse(output.textContent!)).toMatchObject({productCode: 'NEW-002', genres: ['새 장르','두번째'], maker: null});
    expect(within(dialog).getByText('대기')).toBeTruthy();
    expect(within(dialog).getByRole('button', {name: '저장'})).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', {name: '닫기'}));
    fireEvent.click(screen.getByRole('button', {name: '관리 열기'}));
    fireEvent.click(await screen.findByRole('button', {name: 'AV 정보 편집'}));
    expect(screen.getByLabelText('품번')).toHaveValue('NEW-002');
    expect(screen.getByRole('button', {name: '저장'})).toBeDisabled();
  });
  it('reorders and removes by role, adds existing and new people, and sends new people only with the read revision', async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', {name: '둘째 배우 위로'}));
    fireEvent.click(within(dialog).getByRole('button', {name: '첫 배우 연결 제거'}));
    fireEvent.change(within(dialog).getByLabelText('인물 이름 검색'), {target: {value: '既存'}});
    fireEvent.click(within(dialog).getByRole('button', {name: /기존 인물 ·/}));
    fireEvent.change(within(dialog).getByLabelText('역할'), {target: {value: 'director'}});
    fireEvent.change(within(dialog).getByLabelText('인물 이름 검색'), {target: {value: ' 새 감독 '}});
    fireEvent.click(within(dialog).getByRole('button', {name: '새 인물로 추가'}));
    fireEvent.change(within(dialog).getByLabelText('새 감독 작품 내 표기'), {target: {value: ' 감독 표기 '}});
    save(dialog);
    await waitFor(() => expect(readCommands()[0]?.attempts).toBe(1));
    expect(readCommands()).toHaveLength(1);
    const command = readCommands()[0].command;
    expect(command.commandType).toBe('setAvCredits');
    if (command.commandType !== 'setAvCredits') throw new Error('wrong command');
    expect(command.expectedRevision).toBe(7);
    expect(command.people).toEqual([{personId: expect.stringMatching(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/), displayName: '새 감독', nameJa: null}]);
    expect(command.credits).toEqual(expect.arrayContaining([
      {personId:'actor-2',role:'performer',order:0,creditName:'별명'}, {personId:'actor-known',role:'performer',order:1,creditName:null},
      {personId:'director-1',role:'director',order:0,creditName:null}, {personId:command.people[0].personId,role:'director',order:1,creditName:'감독 표기'},
    ]));
    expect(JSON.parse(screen.getByTestId('shown').textContent!).people.map((person: {name:string}) => person.name)).toEqual(['둘째 배우','기존 인물','감독 이름','새 감독']);
  });
  it('rejects duplicate person/role with the PC wording', async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('인물 이름 검색'), {target: {value: '첫 배우'}});
    fireEvent.click(within(dialog).getByRole('button', {name: /첫 배우 ·/}));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('이미 같은 역할로 연결된 인물입니다.');
    expect(readCommands()).toEqual([]);
  });
  it('keeps details and credits together, delivering revision CAS before field CAS', async () => {
    let revision = 7;
    send = body => {
      if (body.commandType === 'setAvCredits') expect(body.expectedRevision).toBe(revision);
      revision++; return {};
    };
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('품번'), {target: {value: 'BOTH-001'}});
    fireEvent.click(within(dialog).getByRole('button', {name: '둘째 배우 위로'}));
    save(dialog);
    await waitFor(() => expect(readCommands().map(row => row.state)).toEqual(['accepted','accepted']));
    expect(readCommands().map(row => row.command.commandType)).toEqual(['setAvCredits','setAvDetails']);
    expect(readCommands().every(row => row.receipts?.length === 1)).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'AV 정보 편집'})).toBeNull());
    expect(JSON.parse(screen.getByTestId('shown').textContent!)).toMatchObject({productCode:'BOTH-001', people:[{id:'actor-2'},{id:'actor-1'},{id:'director-1'}]});
  });
  it('routes a details conflict through AuthorityQueue and reconfirms against the returned fields', async () => {
    send = () => new ApiError('충돌', 409, {detail:{code:'revisionConflict',current:{work:{name:item.name,fields:{},entityRevision:8,details:{av:{...item.av,productCode:'REMOTE-001'}}}}}});
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('품번'), {target:{value:'MY-001'}}); save(dialog);
    await screen.findByText('충돌');
    const oldId = readCommands()[0].command.operationId;
    fireEvent.click(within(dialog).getByRole('button', {name:'닫기'}));
    fireEvent.click(screen.getByRole('button', {name:'확인'}));
    const retry = await screen.findByRole('dialog', {name:'AV 정보 편집'});
    expect(within(retry).getByLabelText('품번')).toHaveValue('MY-001');
    send = () => ({}); save(retry);
    await waitFor(() => expect(readCommands()[0]?.state).toBe('accepted'));
    expect(readCommands()[0].command).toMatchObject({changes:{productCode:'MY-001'},expected:{productCode:'REMOTE-001'}});
    expect(readCommands()[0].command.operationId).not.toBe(oldId);
  });
  it('allows a credits conflict to be resolved while a dependent details command waits', async () => {
    send = body => body.commandType === 'setAvCredits' ? new ApiError('충돌',409,{detail:{code:'revisionConflict',current:{work:{name:item.name,fields:{},entityRevision:8,avCredits:avCredits(item.av!.people)}}}}) : {};
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', {name:'둘째 배우 위로'}));
    fireEvent.change(within(dialog).getByLabelText('품번'), {target:{value:'NEXT-001'}}); save(dialog);
    await waitFor(() => expect(readCommands().map(row=>row.state)).toEqual(['conflict','pending']));
    fireEvent.click(within(dialog).getByRole('button', {name:'닫기'}));
    fireEvent.click(screen.getByRole('button', {name:'확인'}));
    const retry = await screen.findByRole('dialog', {name:'AV 정보 편집'});
    expect(within(retry).getByRole('button',{name:'저장'})).toBeEnabled();
    send = () => ({}); save(retry);
    await waitFor(() => expect(readCommands().map(row=>row.state)).toEqual(['accepted','accepted']));
    expect(readCommands()[0].command).toMatchObject({commandType:'setAvCredits',expectedRevision:8,people:[]});
  });
  it.each(['game','manga','movie'] as const)('hides the AV entry for %s', async type => {
    render(<Harness work={{...item,type,av:null}}/>);
    await screen.findByRole('dialog',{name:'작품 관리'});
    expect(screen.queryByRole('button',{name:'AV 정보 편집'})).toBeNull();
  });
  it('blocks an invalid date before persistence', async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('출시일'),{target:{value:'2025-02-29'}}); save(dialog);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(AV_INPUT_ERROR);
    expect(readCommands()).toEqual([]);
  });
});

describe('shared AV limits before enqueue', () => {
  it('accepts the limits and rejects oversized text, genres, names, aliases and credit lists', () => {
    for (const field of AV_DETAIL_FIELDS.filter(field=>field.maxLength && field.key!=='releaseDate')) {
      expect(()=>validateAvDetails({[field.key]:'あ'.repeat(field.maxLength!)})).not.toThrow();
      expect(()=>validateAvDetails({[field.key]:'あ'.repeat(field.maxLength!+1)})).toThrow(AV_INPUT_ERROR);
    }
    expect(()=>validateAvDetails({genres:Array(limits.genres).fill('a'.repeat(limits.genreLength))})).not.toThrow();
    expect(()=>validateAvDetails({genres:Array(limits.genres+1).fill('a')})).toThrow(AV_INPUT_ERROR);
    expect(()=>validateAvDetails({genres:['a'.repeat(limits.genreLength+1)]})).toThrow(AV_INPUT_ERROR);
    const credit = {personId:'new',role:'performer' as const,order:0,creditName:'a'.repeat(limits.creditName)};
    const person = {personId:'new',displayName:'a'.repeat(limits.personName),nameJa:null};
    expect(()=>validateAvCredits([credit],[person],7)).not.toThrow();
    expect(()=>validateAvCredits([{...credit,creditName:credit.creditName+'a'}],[person],7)).toThrow(AV_INPUT_ERROR);
    expect(()=>validateAvCredits([credit],[{...person,displayName:person.displayName+'a'}],7)).toThrow(AV_INPUT_ERROR);
    expect(()=>validateAvCredits(Array.from({length:limits.credits+1},(_,order)=>({...credit,personId:`p-${order}`,order})),[],7)).toThrow(AV_INPUT_ERROR);
  });
  it.each(['2025-02-29','2026-13-01','0000-01-01','2026-1-01'])('rejects invalid calendar date %s', date => expect(()=>validateAvDetails({releaseDate:date})).toThrow(AV_INPUT_ERROR));
  it('accepts leap dates and rejects unsafe identities, duplicate role/order and missing new person names', () => {
    expect(()=>validateAvDetails({releaseDate:'2024-02-29'})).not.toThrow();
    const credit = {personId:'person',role:'performer' as const,order:0,creditName:null};
    expect(()=>validateAvCredits([{...credit,personId:'bad/id'}],[],7)).toThrow(AV_INPUT_ERROR);
    expect(()=>validateAvCredits([credit,{...credit,personId:'other'}],[],7)).toThrow(AV_INPUT_ERROR);
    expect(()=>validateAvCredits([credit],[{personId:'person',displayName:' ',nameJa:null}],7)).toThrow(AV_INPUT_ERROR);
    expect(()=>validateAvCredits([credit],[],0)).toThrow(AV_INPUT_ERROR);
  });
});
