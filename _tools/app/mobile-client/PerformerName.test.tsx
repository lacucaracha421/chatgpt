import "@testing-library/jest-dom/vitest";
import {cleanup, render, screen, act} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
const mock=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mock.api}));
import {PerformerName} from './PerformerName';
import {loadedPerformerNames, rememberPersonNames, observePersonNameAuthority} from './personNameCache';
import {setOutboxConnection} from './outboxConnection';
afterEach(()=>{cleanup();mock.api.mockReset();});
it('renders the final source name on the first paint without a person request',()=>{
 setOutboxConnection('https://first-paint.example');
 render(<PerformerName person={{id:'p',name:'日本名',nameJa:'日本名',stashdbProfile:{name:'Roman Name'},profileOverrides:{}}}/>);
 expect(screen.getByText('Roman Name')).toBeVisible();expect(screen.getByText('日本名')).toBeVisible();expect(mock.api).not.toHaveBeenCalled();
});
it('uses Korean names and Japanese subtitles without extra source reads',()=>{
 render(<PerformerName person={{id:'p',name:'한국 이름',nameJa:'日本名',profile:{name:'Roman Name'}}}/>);expect(screen.getByText('한국 이름')).toBeVisible();expect(screen.getByText('日本名')).toBeVisible();expect(mock.api).not.toHaveBeenCalled();
});

it('shares one paged source read across lists and waits before exposing names',async()=>{
 setOutboxConnection('https://batch.example');
 const identity={libraryId:'a'.repeat(32),epoch:1};let finish:(value:unknown)=>void=()=>{};
 mock.api.mockImplementation((path:string)=>path.endsWith('/status')?Promise.resolve({...identity,active:true}):path.includes('section=works')?new Promise(resolve=>{finish=resolve;}):Promise.resolve({snapshotCursor:1}));
 const items=[{id:'work',type:'av' as const,name:'작품',showcase:false,av:{genres:[],people:[{id:'p',name:'日本名',nameJa:'日本名',role:'performer' as const,order:0}]}}];
 let published=false;const first=loadedPerformerNames(items).then(value=>{published=true;return value;}),second=loadedPerformerNames(items);
 await act(async()=>{await Promise.resolve();});expect(published).toBe(false);
 await act(async()=>finish({...identity,items:[{avPeople:[{personId:'p',entityRevision:2,stashdbProfile:{name:'Roman Name'},profileOverrides:{displayName:null}}]}],hasMore:false,nextAfter:null}));
 const loaded=await first;await second;
 expect(loaded[0].av?.people[0]).toMatchObject({stashdbProfile:{name:'Roman Name'},profileOverrides:{displayName:null}});
 render(<PerformerName person={loaded[0].av!.people[0]!}/>);expect(screen.getByText('Roman Name')).toBeVisible();
 expect(mock.api).toHaveBeenCalledTimes(3);expect(mock.api.mock.calls.some(([path])=>String(path).includes('/people/'))).toBe(false);
});
it('uses existing person reads and keeps the name cache scoped to the library and connection',()=>{
 setOutboxConnection('https://existing-read.example');observePersonNameAuthority({libraryId:'a',epoch:1});
 rememberPersonNames([{id:'p',entityRevision:2,stashdbProfile:{name:'Roman Name'},profileOverrides:{}}]);
 rememberPersonNames([{id:'p',entityRevision:1,stashdbProfile:{name:'Old Name'},profileOverrides:{}}]);
 const {rerender}=render(<PerformerName person={{id:'p',name:'日本名'}}/>);expect(screen.getByText('Roman Name')).toBeVisible();
 observePersonNameAuthority({libraryId:'a',epoch:2});rerender(<PerformerName person={{id:'p',name:'日本名'}}/>);expect(screen.getByText('日本名')).toBeVisible();
 rememberPersonNames([{id:'p',stashdbProfile:{name:'Epoch Name'},profileOverrides:{}}]);setOutboxConnection('https://other.example');rerender(<PerformerName person={{id:'p',name:'日本名'}}/>);expect(screen.queryByText('Epoch Name')).toBeNull();expect(mock.api).not.toHaveBeenCalled();
});

it('never caches a person reply from the previous connection',async()=>{
 const {personReply}=await import('./collectionModel');
 setOutboxConnection('https://current-read.example');
 personReply({person:{id:'p',stashdbProfile:{name:'Old Server Name'},profileOverrides:{}}},'p','https://previous-read.example');
 render(<PerformerName person={{id:'p',name:'日本名'}}/>);expect(screen.getByText('日本名')).toBeVisible();expect(screen.queryByText('Old Server Name')).toBeNull();
});

it('reads no authority baseline when the list items already carry their name source', async () => {
 setOutboxConnection('https://name-source-in-items.example');
 const person = {name: '日本名', nameJa: '日本名', role: 'performer' as const, order: 0};
 const items = [{id: 'work', type: 'av' as const, name: '작품', showcase: false, av: {genres: [], people: [
  {...person, id: 'p', stashdbProfile: {name: 'Roman Name'}, profileOverrides: {}, entityRevision: 3},
  {...person, id: 'q', name: '別名', nameJa: '別名', stashdbProfile: null, profileOverrides: {}, entityRevision: 1}]}}];
 const loaded = await loadedPerformerNames(items);
 expect(mock.api).not.toHaveBeenCalled();
 render(<><PerformerName person={loaded[0].av!.people[0]!}/><PerformerName person={loaded[0].av!.people[1]!}/></>);
 expect(screen.getByText('Roman Name')).toBeVisible();expect(screen.getByText('別名')).toBeVisible();
 await loadedPerformerNames(items);expect(mock.api).not.toHaveBeenCalled();
});
it('still lets a strictly newer remembered edit replace the source carried by an item', async () => {
 setOutboxConnection('https://newer-edit.example');
 const items = [{id: 'work', type: 'av' as const, name: '작품', showcase: false, av: {genres: [], people: [
  {id: 'p', name: '日本名', nameJa: '日本名', role: 'performer' as const, order: 0, stashdbProfile: {name: 'Roman Name'}, profileOverrides: {}, entityRevision: 3}]}}];
 await loadedPerformerNames(items);
 rememberPersonNames([{id: 'p', entityRevision: 4, stashdbProfile: {name: 'Edited Name'}, profileOverrides: {}}]);
 render(<PerformerName person={items[0].av.people[0]!}/>);
 expect(screen.getByText('Edited Name')).toBeVisible();expect(mock.api).not.toHaveBeenCalled();
});
