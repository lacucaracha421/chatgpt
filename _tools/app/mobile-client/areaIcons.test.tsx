import {readFileSync} from 'node:fs';
import {isValidElement} from 'react';
import {expect,it} from 'vitest';
import {AREA_ICONS} from '../src/shared/ui/areaIcons';
import {artistEntries,noteTitleEntries,workEntries} from '../src/layout/findData';
import {tabletFindEntries} from './findData';
import type {LibraryArtist} from './artistsModel';
import type {Note} from '../src/notes/store';

const iconOf=(entry:{icon?:unknown})=>isValidElement(entry.icon)?entry.icon.type:null;
const source=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');

it('gives each area one icon from the shared map on both clients (DESIGN "Icons and rows")',()=>{
  expect(AREA_ICONS).toMatchObject({home:expect.anything(),assets:expect.anything(),collections:expect.anything(),manga:expect.anything(),notes:expect.anything(),private_vault:expect.anything(),exchange:expect.anything(),artists:expect.anything(),settings:expect.anything()});
  expect(new Set(Object.values(AREA_ICONS)).size).toBe(Object.keys(AREA_ICONS).length);
});

it('uses the shared area icons in the tablet and PC 찾기 entries',()=>{
  const artist:LibraryArtist={id:'a',label:'작가',displayName:null,sourceName:null,keys:[],assetCount:1,recentCount:0,pinned:false,hidden:false,main:true,coverAssetIds:[]};
  const note={id:'n',title:'메모',type:'text',deleted:false} as Note;
  const tablet=tabletFindEntries({works:[{item:{id:'w',name:'작품',type:'game',showcase:false},revision:'r'}],artists:[artist],notes:[note],folders:[],albums:null,navigate:()=>{}});
  const tabletIcon=(id:string)=>iconOf(tablet.find(entry=>entry.id===id)!);
  expect(tabletIcon('screen-home')).toBe(AREA_ICONS.home);
  expect(tabletIcon('screen-assets')).toBe(AREA_ICONS.assets);
  expect(tabletIcon('screen-collections')).toBe(AREA_ICONS.collections);
  expect(tabletIcon('screen-catalog')).toBe(AREA_ICONS.manga);
  expect(tabletIcon('screen-notes')).toBe(AREA_ICONS.notes);
  expect(tabletIcon('screen-settings')).toBe(AREA_ICONS.settings);
  expect(tabletIcon('work-w')).toBe(AREA_ICONS.collections);
  expect(tabletIcon('artist-a')).toBe(AREA_ICONS.artists);
  expect(tabletIcon('note-n')).toBe(AREA_ICONS.notes);

  const navigate=()=>{};
  expect(iconOf(noteTitleEntries([note],navigate)[0])).toBe(AREA_ICONS.notes);
  expect(iconOf(workEntries([{id:'w',name:'작품',type:'game',showcase:false} as never],navigate)[0])).toBe(AREA_ICONS.collections);
  expect(iconOf(artistEntries([{id:'a',label:'작가',displayName:null,sourceName:null,keys:[],assetCount:1,coverAssetIds:[],hidden:false} as never],navigate)[0])).toBe(AREA_ICONS.artists);
});

it('draws the PC rail and the tablet bottom navigation from the shared map',()=>{
  const rail=source('../src/layout/WorkspaceNavigation.tsx'),nav=source('./App.tsx');
  for(const key of ['home','assets','collections','manga','notes','exchange','private_vault'])expect(rail).toContain(`AREA_ICONS.${key}`);
  for(const key of ['home','assets','collections','manga','notes','private_vault','exchange','settings'])expect(nav).toContain(`AREA_ICONS.${key}`);
  // No area glyph is picked locally any more.
  expect(rail).not.toMatch(/ArchiveIcons/);
});
