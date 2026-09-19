import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ClassificationIndex} from './ClassificationIndex';
import type {CharacterIndex} from './characterModel';
import type {Classification,View} from './types';

const revision='a'.repeat(64);
const characterNode=(kind:'series'|'group'|'character',sourceId:string,name:string,parentId:string|null)=>({id:`${kind}:${sourceId}`,kind,sourceId,seriesId:'s',parentId,name,description:'',thumbnailAssetId:null,manualOnly:false,excluded:false});
const characters:CharacterIndex={version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,publishedAt:'2026',
  nodes:[characterNode('series','s','Series',null),characterNode('group','g','Group','series:s'),characterNode('character','c','Character','group:g')],
  scopes:[{nodeId:'series:s',filter:'all',totalCount:2,sourceCount:2},{nodeId:'group:g',filter:'all',totalCount:2,sourceCount:2},{nodeId:'character:c',filter:'all',totalCount:2,sourceCount:2}]};

const view:View={tab:'library',title:'전체'};
const onSelect=vi.fn();
function renderIndex(items:Classification[],collapsed=new Set<string>(),setCollapsed=vi.fn()) {
  render(<ClassificationIndex items={items} characters={characters} view={view} onSelect={onSelect} collapsed={collapsed} setCollapsed={setCollapsed}/>);
}
afterEach(()=>{cleanup();onSelect.mockReset();});

it('marks character folders, group folders and plain classifications with distinct icons',()=>{
  renderIndex([{id:'plain',name:'Plain folder',parent_id:null,asset_count:3}]);
  const iconFor=(name:string)=>screen.getByText(name).closest('button')!.querySelector('svg');
  const character=iconFor('Character'),group=iconFor('Group'),series=iconFor('Series'),plain=iconFor('Plain folder');
  expect(character?.getAttribute('data-icon')).toBe('character');
  expect(group?.getAttribute('data-icon')).toBe('character-group');
  // A series row is a character-backed folder, but not a character or group.
  expect(series?.getAttribute('data-icon')).toBeNull();
  expect(series?.getAttribute('data-testid')).toBe('classification-icon');
  // A plain classification keeps the configured tag/folder icon.
  expect(plain?.getAttribute('data-testid')).toBe('classification-icon');
  expect(new Set([character?.outerHTML,group?.outerHTML,plain?.outerHTML]).size).toBe(3);
});

it('selects the character node for a character folder and the classification otherwise',()=>{
  renderIndex([{id:'plain',name:'Plain folder',parent_id:null,asset_count:3}]);
  fireEvent.click(screen.getByText('Character').closest('button')!);
  expect(onSelect).toHaveBeenCalledWith({tab:'library',characters:true,characterNode:'character:c',title:'Character'});
  onSelect.mockReset();
  fireEvent.click(screen.getByText('Plain folder').closest('button')!);
  expect(onSelect).toHaveBeenCalledWith({tab:'library',classification:'plain',title:'Plain folder'});
});

it('keeps the hierarchy line and expander outside the selected row fill',()=>{
  const current:View={tab:'library',title:'Series',characters:true,characterNode:'series:s'};
  render(<ClassificationIndex items={[]} characters={characters} view={current} onSelect={onSelect} collapsed={new Set()} setCollapsed={vi.fn()}/>);
  const row=screen.getByText('Series').closest('.tree-row')!;
  expect(row.classList.contains('selected')).toBe(true);
  // The highlight is painted on the file button, so the row's own expander and the
  // sibling hierarchy line stay uncovered by the selected fill.
  expect(row.querySelector('.tree-select')!.getAttribute('aria-current')).toBe('page');
  expect(row.querySelector('.tree-expander')).not.toBeNull();
});
