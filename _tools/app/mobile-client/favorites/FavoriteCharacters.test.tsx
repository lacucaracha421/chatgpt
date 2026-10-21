import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
import type {CharacterIndex,CharacterNode} from '../characterModel';
import type {FavoriteCharacters as Document} from '../../src/library/types';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('../transport',()=>({api:mocks.api,native:vi.fn(),errorText:(reason:unknown)=>String(reason)}));
vi.mock('../media',()=>({loadThumbnail:vi.fn(async(asset:unknown)=>asset),prepareAssets:vi.fn(async(assets:unknown)=>assets)}));
vi.mock('../Overlay',()=>({Overlay:({open,covered,title,onClose,headerActions,children}:{open:boolean;covered:boolean;title:string;onClose():void;headerActions:ReactNode;children:ReactNode})=>open&&!covered?<section role="dialog" aria-label={title}><button onClick={onClose}>뒤로</button>{headerActions}{children}</section>:null}));
vi.mock('../BottomSheet',()=>({BottomSheet:({title,heading,children,onClose}:{title:string;heading:ReactNode;children:ReactNode;onClose():void})=><section role="dialog" aria-label={title}>{heading}{children}<button onClick={onClose}>닫기</button></section>}));
vi.mock('../Gallery',()=>({Gallery:()=>null}));
vi.mock('../Viewer',()=>({Viewer:()=>null}));
import {FavoriteCharacters} from './FavoriteCharacters';

const node=(id:string,seriesId='series'):CharacterNode=>({id:`character:${id}`,sourceId:id,kind:'character',seriesId,parentId:`series:${seriesId}`,name:id,description:'',thumbnailAssetId:null,manualOnly:false});
const index:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,ready:true,revision:'a'.repeat(64),publishedAt:null,capabilities:{read:true,write:false},nodes:[node('a'),node('b'),node('other','second'),{...node('series'),kind:'series',id:'series:series',name:'작품'}],scopes:[]};
const entry=(id:string)=>({characterId:id,coverAssetId:null,coverY:50,profile:{originalName:`original ${id}`},workIds:[],extraWorks:[]});
let document:Document;
beforeEach(()=>{
  document={version:1,revision:1,entries:[entry('a'),entry('other'),entry('deleted'),entry('b')]};
  mocks.api.mockReset();
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body?:unknown)=>{
    if(path==='/v1/library/favorite-characters')return body?{...document,revision:2}:document;
    if(path==='/v1/library/characters')return index;
    if(path.startsWith('/v1/library/classifications'))return {items:[{id:'box',name:'분류함1',parent_id:null,kind:'root',asset_count:0},{id:'series',name:'작품',parent_id:'box',kind:'work',asset_count:0},{id:'box2',name:'분류함2',parent_id:null,kind:'root',asset_count:0},{id:'second',name:'다른 작품',parent_id:'box2',kind:'work',asset_count:0}]};
    if(path.startsWith('/v1/library/characters/assets'))return {items:[{id:'art1',kind:'image'},{id:'art2',kind:'image'}],has_more:false,next_cursor:null,totalCount:2};
    throw new Error(path);
  });
});
afterEach(cleanup);
const mount=()=>{
  const backRef={current:null as (()=>boolean)|null},onOpenFolder=vi.fn();
  render(<FavoriteCharacters open active covered={false} onClose={vi.fn()} backRef={backRef} onOpenFolder={onOpenFolder} onOpenWork={vi.fn()} cover={()=>null}/>);
  return {backRef,onOpenFolder};
};
const posts=()=>mocks.api.mock.calls.filter(([, , body])=>body).map(([, , body])=>body);

it('adds several indexed characters in one command, leaving already-added rows disabled',async()=>{
  document={version:1,revision:1,entries:[entry('a')]};
  mount();
  await screen.findByRole('button',{name:'a · 작품'});
  fireEvent.click(screen.getByRole('button',{name:'캐릭터 추가'}));
  const sheet=await screen.findByRole('dialog',{name:'캐릭터 추가'});
  expect((within(sheet).getByRole('checkbox',{name:'a'}) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(within(sheet).getByRole('checkbox',{name:'b'}));
  fireEvent.click(within(sheet).getByRole('checkbox',{name:'other'}));
  fireEvent.click(within(sheet).getByRole('button',{name:'2명 추가'}));
  await waitFor(()=>expect(posts()).toEqual([{commands:[{op:'add',ids:['b','other']}]}]));
});

it('reorders only visible slots and returns from a character detail before closing the grid',async()=>{
  const {backRef}=mount();
  const card=await screen.findByRole('button',{name:'b · 작품'});
  expect(screen.queryByRole('button',{name:/deleted/})).toBeNull();
  fireEvent.click(screen.getByRole('radio',{name:/분류함1/}));
  fireEvent.keyDown(card,{key:'F10',shiftKey:true});
  fireEvent.click(screen.getByRole('button',{name:'맨 앞으로'}));
  await waitFor(()=>expect(posts()).toEqual([{commands:[{op:'order',ids:['b','other','deleted','a']}]}]));
  fireEvent.click(screen.getByRole('button',{name:'a · 작품'}));
  await screen.findByRole('dialog',{name:'a'});
  act(()=>{expect(backRef.current?.()).toBe(true);});
  expect(screen.getByRole('dialog',{name:'캐릭터'})).toBeTruthy();
});

it('holds the chosen portrait and crop until 바꾸기 sends one update',async()=>{
  mount();
  const card=await screen.findByRole('button',{name:'a · 작품'});
  fireEvent.keyDown(card,{key:'F10',shiftKey:true});
  fireEvent.click(screen.getByRole('button',{name:'대표 이미지 바꾸기'}));
  const sheet=screen.getByRole('dialog',{name:'대표 이미지 바꾸기'});
  await waitFor(()=>expect(within(sheet).getAllByRole('button',{name:'대표 이미지 선택'})).toHaveLength(2));
  fireEvent.click(within(sheet).getAllByRole('button',{name:'대표 이미지 선택'})[1]);
  fireEvent.change(within(sheet).getByRole('slider'),{target:{value:'73'}});
  expect(posts()).toEqual([]);
  fireEvent.click(within(sheet).getByRole('button',{name:'바꾸기'}));
  await waitFor(()=>expect(posts()).toEqual([{commands:[{op:'update',id:'a',set:{coverAssetId:'art2',coverY:73}}]}]));
});
