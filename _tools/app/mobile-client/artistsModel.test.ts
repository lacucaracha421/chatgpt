import {describe,expect,it} from 'vitest';
import {normalizeArtists, orderedArtists, sortArtists,type LibraryArtist} from './artistsModel';

const artist=(id:string,name:string,overrides:Partial<LibraryArtist>={}):LibraryArtist=>({
  id,label:name,displayName:name,sourceName:name,keys:[],assetCount:0,recentCount:0,
  firstSavedAt:null,lastSavedAt:null,lastOpenedAt:null,pinned:false,hidden:false,main:false,coverAssetIds:[],...overrides,
});

describe('sortArtists',()=>{
  it('keeps hidden artists available only when requested for the hidden list',()=>{
    const reply={artists:[artist('shown','보임'),artist('hidden','숨김',{hidden:true})]};
    expect(normalizeArtists(reply).map(row=>row.id)).toEqual(['shown']);
    expect(normalizeArtists(reply,true).map(row=>row.id)).toEqual(['shown','hidden']);
  });
  it('puts pinned artists first in the hub order',()=>{
    expect(orderedArtists([artist('new','새로',{lastSavedAt:'2026-10-01'}),artist('pin','고정',{pinned:true})]).map(row=>row.id)).toEqual(['pin','new']);
  });
  const items=[
    artist('missing','나무'),
    artist('old','가을',{assetCount:2,lastSavedAt:'2026-01-01T00:00:00Z'}),
    artist('new','겨울',{assetCount:8,lastSavedAt:'2026-09-01T00:00:00Z'}),
    artist('pinned','여름',{pinned:true,assetCount:1,lastSavedAt:null}),
  ];

  it('keeps pinned artists first and sorts recent saves with missing dates last',()=>{
    expect(sortArtists(items,'recent').map(item=>item.id)).toEqual(['pinned','new','old','missing']);
  });

  it('sorts by count and uses the Korean artist name as the tie break',()=>{
    const tied=[artist('b','나',{assetCount:4}),artist('a','가',{assetCount:4}),artist('p','다',{pinned:true,assetCount:1})];
    expect(sortArtists(tied,'count').map(item=>item.id)).toEqual(['p','a','b']);
    expect(sortArtists(items,'name').map(item=>item.id)).toEqual(['pinned','old','new','missing']);
  });
});
