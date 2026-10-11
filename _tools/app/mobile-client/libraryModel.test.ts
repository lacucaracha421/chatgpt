import {expect,it} from 'vitest';
import type {CharacterIndex} from './characterModel';
import {mergeLibraryEntries,ancestorsOf,searchLibraryEntries,entryView,folderCardCount} from './libraryModel';
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
 const korean=[{id:'k',name:'서리 은하',parent_id:null,asset_count:1},{id:'o',name:'별빛',parent_id:null,asset_count:1}];
 expect(searchLibraryEntries(korean,'ㅅㄹ').map(e=>e.id)).toEqual(['k']);
 expect(searchLibraryEntries(korean,'설').map(e=>e.id)).toEqual(['k']);
 expect(searchLibraryEntries(korean,'').map(e=>e.id)).toEqual(['k','o']);
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

it('shows the subtree total on a folder card, a series own character count, and the direct count without subtree counts',()=>{
 const entries=mergeLibraryEntries([{id:'games',name:'게임',parent_id:null,asset_count:10,total_asset_count:40},{id:'s',name:'Series',parent_id:'games',asset_count:99,total_asset_count:77},{id:'old',name:'옛',parent_id:null,asset_count:3}],characters);
 const count=(id:string)=>folderCardCount(entries.find(entry=>entry.id===id)!);
 expect(count('games')).toBe(40);
 // The merged series carries the character index's count; the server's subtree total does not override it.
 expect(count('s')).toBe(2);
 expect(count('old')).toBe(3);
 // The direct count itself is never repurposed.
 expect(entries.find(entry=>entry.id==='games')!.asset_count).toBe(10);
});
it('lists a 기타 as just 기타, after its sibling characters, without treating it as a character folder',()=>{
 const extras={...characterNode('character','x','Group 기타','group:g'),role:'extras' as const};
 const entries=mergeLibraryEntries([{id:'folder-x',name:'Group 기타',parent_id:'s',asset_count:1}],{...characters,nodes:[...characters.nodes.slice(0,2),extras,characters.nodes[2]]});
 const group=entries.filter(e=>e.parent_id==='character-group:g');
 expect(group.map(e=>e.name)).toEqual(['Character','기타']);
 expect(group[1]).toMatchObject({characterExtras:true,characterKind:'character'});
 // A folder that merely shares the stored name is not hidden as the 기타's linked folder.
 expect(entries.some(e=>e.id==='folder-x')).toBe(true);
});
it('lists a series group before its arranged folders in the classification list',()=>{
 const folders=[{id:'s',name:'Series',parent_id:null,asset_count:9},{id:'f1',name:'Zeta',parent_id:'s',asset_count:1},{id:'f2',name:'Alpha',parent_id:'s',asset_count:1}];
 const entries=mergeLibraryEntries(folders,{...characters,navigationOrder:['s','f1','f2']});
 expect(entries.filter(e=>e.parent_id==='s').map(e=>e.id)).toEqual(['character-group:g','f1','f2']);
});
it('lists a series\' groups in the published group order, and by name for a snapshot without group entries',()=>{
 const withGroups={...characters,nodes:[characters.nodes[0],characterNode('group','h','Hares','series:s'),characterNode('group','g','Group','series:s'),characterNode('group','i','Interns','series:s')]};
 const folders=[{id:'s',name:'Series',parent_id:null,asset_count:9},{id:'f1',name:'Zeta',parent_id:'s',asset_count:1}];
 const under=(index:CharacterIndex)=>mergeLibraryEntries(folders,index).filter(e=>e.parent_id==='s').map(e=>e.id);
 // Old snapshot: groups first, by name, then the folders.
 expect(under({...withGroups,navigationOrder:['s','f1']})).toEqual(['character-group:g','character-group:h','character-group:i','f1']);
 // New snapshot: the PC's group order, still before the folders; other entries of the order are untouched.
 expect(under({...withGroups,navigationOrder:['s','f1','group:i','group:g','group:h']})).toEqual(['character-group:i','character-group:g','character-group:h','f1']);
 // A group the order does not list yet follows the listed ones.
 expect(under({...withGroups,navigationOrder:['group:i','group:h']})).toEqual(['character-group:i','character-group:h','character-group:g','f1']);
});
