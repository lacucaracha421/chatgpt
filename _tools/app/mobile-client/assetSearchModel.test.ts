import {assetMasked} from '../src/shared/privacy/contentMask';
import {characterCovers} from './FolderCards';
import type {CharacterIndex} from './characterModel';
import {expect,it,vi} from 'vitest';
import {assetSuggestions,addSearchChip,chipName,searchChip,searchView,invalidSearchChoices,removeViewSearch,type AssetSuggestion} from './assetSearchModel';
import {assetSearchChoiceHint,assetSearchSelectionKey,type AssetSearchName} from '../src/assets/assetSearch';
import {pagePath,viewKey} from './model';
import {assetTocPath} from './assetToc';
import {characterPath} from './characterModel';
import {EMPTY_FILTERS} from './assetFilters';
const tag=(id:string):AssetSuggestion=>({kind:'tag',id,name:`태그 ${id}`});
const folder=(id:string):AssetSuggestion=>({kind:'folder',id,name:`폴더 ${id}`,view:{tab:'library',classification:id,title:id}});
const artist=(id:string):AssetSuggestion=>({kind:'artist',id,name:id,artist:{id,label:id,keys:[],assetCount:1,recentCount:0,pinned:false,hidden:false,main:false,coverAssetIds:[]}});
const album:AssetSuggestion={kind:'album',id:'album',name:'앨범',view:{tab:'library',title:'앨범',album:{id:'album',libraryId:'library',epoch:3}}};
const character:AssetSuggestion={kind:'character',id:'c',name:'캐릭터',view:{tab:'library',title:'캐릭터',characters:true,characterNode:'character:c'}};
it('stacks eight tags and folders independently, refuses duplicates/ninth choices, and replaces the artist',()=>{
 let chips=[searchChip(artist('artist:a'))];
 for(let i=0;i<8;i++){chips=addSearchChip(chips,tag(`${i}`));chips=addSearchChip(chips,folder(`${i}`));}
 expect(chips).toHaveLength(17);
 expect(addSearchChip(chips,tag('9'))).toEqual(chips);expect(addSearchChip(chips,folder('9'))).toEqual(chips);
 expect(addSearchChip(chips,tag('0'))).toEqual(chips);
 expect(assetSearchChoiceHint(chips.map(chipName),tag('9'))).toBe('태그는 최대 8개입니다.');
 expect(assetSearchChoiceHint(chips.map(chipName),folder('9'))).toBe('폴더는 최대 8개입니다.');
 chips=addSearchChip(chips,artist('artist:b'));
 expect(chips.map(chipName).filter(item=>item.kind==='artist').map(item=>item.id)).toEqual(['artist:b']);
});
it('replaces folder scopes with one album/character while retaining tags and artist, and restores folders by replacing that scope',()=>{
 let chips=[tag('long_hair'),artist('artist:a'),folder('a'),folder('b')].map(searchChip);
 chips=addSearchChip(chips,album);expect(chips.map(chipName).map(item=>item.kind)).toEqual(['tag','artist','album']);
 chips=addSearchChip(chips,character);expect(chips.map(chipName).map(item=>item.kind)).toEqual(['tag','artist','character']);
 chips=addSearchChip(chips,folder('a'));expect(chips.map(chipName).map(item=>item.kind)).toEqual(['tag','artist','folder']);
});
it('uses repeated AND ids in library page and TOC requests, with cursor identities bound to the chips',()=>{
 const view=searchView([tag('long_hair'),tag('glasses'),artist('artist:a'),folder('a'),folder('b')].map(searchChip));
 const page=new URL(pagePath(view,'next',EMPTY_FILTERS),'https://test');
 expect(page.pathname).toBe('/v1/library/assets');expect(page.searchParams.getAll('tag')).toEqual(['long_hair','glasses']);
 expect(page.searchParams.getAll('classification_id')).toEqual(['a','b']);expect(page.searchParams.getAll('artist')).toEqual(['artist:a']);expect(page.searchParams.get('cursor')).toBe('next');
 const toc=new URL(assetTocPath(view,EMPTY_FILTERS,540),'https://test');
 for(const key of ['tag','classification_id','artist'])expect(toc.searchParams.getAll(key)).toEqual(page.searchParams.getAll(key));
 expect(toc.searchParams.get('toc')).toBe('1');expect(toc.searchParams.has('limit')).toBe(false);
 expect(viewKey(view)).not.toBe(viewKey({...view,search:[]}));
 expect(viewKey(view)).toBe(viewKey({...view,search:[...view.search!].reverse()}));
});
it('sends only tags and artist with the album and character scope, including album TOC',()=>{
 const chips=[tag('a'),tag('b'),artist('artist:a'),folder('excluded')].map(searchChip);
 const view=searchView(addSearchChip(chips,album));
 for(const path of [pagePath(view,null),assetTocPath(view,EMPTY_FILTERS)]){
   const url=new URL(path,'https://test');expect(url.pathname).toBe('/v1/albums/assets');
   expect(url.searchParams.getAll('tag')).toEqual(['a','b']);expect(url.searchParams.get('artist')).toBe('artist:a');
   expect(url.searchParams.get('albumId')).toBe('album');expect(url.searchParams.get('epoch')).toBe('3');expect(url.searchParams.get('libraryId')).toBe('library');expect(url.searchParams.has('classification_id')).toBe(false);
 }
 const selected=searchView(addSearchChip(chips,character));
 const url=new URL(characterPath('character:c','all','rev','cursor',EMPTY_FILTERS,selected.search),'https://test');
 expect(url.pathname).toBe('/v1/library/characters/assets');expect(url.searchParams.getAll('tag')).toEqual(['a','b']);
 expect(url.searchParams.get('artist')).toBe('artist:a');expect(url.searchParams.has('classification_id')).toBe(false);expect(url.searchParams.get('revision')).toBe('rev');expect(url.searchParams.get('cursor')).toBe('cursor');
});
it('isolates 422 chips without dropping valid choices or treating offline errors as invalid ids',async()=>{
 const choices:AssetSearchName[]=[tag('good'),folder('stale'),artist('offline')];
 const read=vi.fn(async(item:AssetSearchName)=>{if(item.id==='stale')throw {status:422};if(item.id==='offline')throw Error('offline');return {};});
 const invalid=await invalidSearchChoices(choices,read,new AbortController().signal);
 expect(invalid).toEqual([choices[1]]);expect(read).toHaveBeenCalledTimes(3);
 const view=searchView(choices.map(item=>searchChip(item as AssetSuggestion)));
 expect(removeViewSearch(view,invalid).search).toEqual([choices[0],choices[2]]);
 const controller=new AbortController();controller.abort();expect(await invalidSearchChoices(choices,read,controller.signal)).toEqual([]);
 expect(assetSearchSelectionKey(removeViewSearch(view,choices).search)).toBe('');
 expect(removeViewSearch(searchView([searchChip(album),searchChip(tag('a'))]),[album]).album).toBeUndefined();
});

it('keeps current artist and character cover ratings in search and folder projections',()=>{
 const entries=[{id:'c',name:'Character',parent_id:null,asset_count:1,characterNode:'character:c'}];
 const characters={nodes:[{id:'character:c',thumbnailAssetId:'character-cover'}],contentRatings:{'character-cover':'g'}} as CharacterIndex;
 const safeArtist={id:'artist:a',label:'Artist',keys:[],assetCount:1,recentCount:0,pinned:false,hidden:false,main:false,coverAssetIds:[] as string[],coverContentRatings:{} as Record<string,'g'|'e'>};
 safeArtist.coverAssetIds=['artist-cover'];safeArtist.coverContentRatings={'artist-cover':'g'};
 const suggestions=assetSuggestions(entries,characters,null,[safeArtist]);
 expect(suggestions.map(item=>item.cover?.contentRating)).toEqual(['g','g']);
 for(const item of suggestions)expect(assetMasked(false,true,item.cover)).toBe(false);
 expect(characterCovers(entries[0],characters)[0].contentRating).toBe('g');
 characters.contentRatings={'character-cover':'e'};
 safeArtist.coverContentRatings={'artist-cover':'e'};
 for(const item of assetSuggestions(entries,characters,null,[safeArtist]))expect(assetMasked(false,true,item.cover)).toBe(true);
 delete characters.contentRatings;safeArtist.coverContentRatings={};
 for(const item of assetSuggestions(entries,characters,null,[safeArtist]))expect(assetMasked(false,true,item.cover)).toBe(true);
});
