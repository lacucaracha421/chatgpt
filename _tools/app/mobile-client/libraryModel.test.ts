import {expect,it} from 'vitest';
import type {CharacterIndex} from './characterModel';
import {mergeLibraryEntries,ancestorsOf,searchLibraryEntries,entryView} from './libraryModel';
const revision='a'.repeat(64);
const characterNode=(kind:'series'|'group'|'character',sourceId:string,name:string,parentId:string|null)=>({id:`${kind}:${sourceId}`,kind,sourceId,seriesId:'s',parentId,name,description:'',thumbnailAssetId:null,manualOnly:false,excluded:false});
const characters:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,publishedAt:'2026',
  nodes:[characterNode('series','s','Series',null),characterNode('group','g','Group','series:s'),characterNode('character','c','Character','group:g')],
  scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2},{nodeId:'group:g',filter:'all',totalCount:2,sourceCount:2},{nodeId:'character:c',filter:'all',totalCount:2,sourceCount:2}]};

it('merges series into classifications and preserves character/group ancestry and counts',()=>{
 const entries=mergeLibraryEntries([{id:'games',name:'게임',parent_id:null,asset_count:10},{id:'s',name:'Series',parent_id:'games',asset_count:99}],characters);
 expect(entries.filter(e=>e.id==='s')).toHaveLength(1);
 expect(entries.find(e=>e.id==='s')).toMatchObject({parent_id:'games',characterNode:'series:s',asset_count:2});
 expect(ancestorsOf(entries,'character:c').map(e=>e.name)).toEqual(['게임','Series','Group']);
 expect(entryView(entries.find(e=>e.id==='character:c')!)).toMatchObject({characters:true,characterNode:'character:c'});
 expect(entryView(entries[0])).toMatchObject({classification:'games'});
});
it('searches all merged levels by case-insensitive name, including groups and characters',()=>{
 const entries=mergeLibraryEntries([],characters);
 expect(searchLibraryEntries(entries,'  group  ').map(e=>e.characterKind)).toEqual(['group']);
 expect(searchLibraryEntries(entries,'CHARACTER').map(e=>e.characterKind)).toEqual(['character']);
 expect(searchLibraryEntries(entries,'missing')).toEqual([]);
});
it('uses navigation order, roots orphan folders, ignores unpublished characters and bounds cyclic ancestors',()=>{
 const folders=[{id:'b',name:'B',parent_id:'missing',asset_count:1},{id:'a',name:'A',parent_id:null,asset_count:1}];
 expect(mergeLibraryEntries(folders,{...characters,ready:false,navigationOrder:['b','a']}).map(e=>e.id)).toEqual(['b','a']);
 expect(mergeLibraryEntries(folders)[1].parent_id).toBeNull();
 expect(ancestorsOf([{...folders[0],parent_id:'a'},{...folders[1],parent_id:'b'}],'b').length).toBeLessThanOrEqual(2);
});
it('shows a character once instead of also listing its same-named folder inside the series',()=>{
 const folders=[{id:'games',name:'게임',parent_id:null,asset_count:10},{id:'s',name:'Series',parent_id:'games',asset_count:99},
  {id:'folder-c',name:' character ',parent_id:'s',asset_count:114},{id:'folder-c-sub',name:'Sketches',parent_id:'folder-c',asset_count:3},
  {id:'elsewhere',name:'Character',parent_id:'games',asset_count:5}];
 const entries=mergeLibraryEntries(folders,characters);
 expect(searchLibraryEntries(entries,'character').map(e=>e.id).sort()).toEqual(['character:c','elsewhere']);
 // A sub-folder of the hidden folder stays reachable under the character entry.
 expect(entries.find(e=>e.id==='folder-c-sub')?.parent_id).toBe('character:c');
});
