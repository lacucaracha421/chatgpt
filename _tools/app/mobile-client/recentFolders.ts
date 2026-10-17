import {useEffect,useMemo,useRef} from 'react';
import {useRecentFolderCore,type RecentChipFolder,type RecentFoldersCore} from '../src/assets/recentFolders';
import {entryView,type Entry} from './libraryModel';
import type {View} from './types';

/**
 * The tablet's recent folders (FOLDER-NAV-001). What counts, the order, the 8-entry limit and the
 * storage rules are the PC's shared core; this file only says which tablet places are folders and
 * where a chip leads. The tablet keeps its own history per library; nothing is synced.
 */
export type TabletRecentFolder=RecentChipFolder&{view:View};
export type TabletRecentFolders=RecentFoldersCore<TabletRecentFolder>&{
  /** Records the folder the user is in, e.g. when an image is opened there. */
  recordCurrent():void;
};

const GROUP_PREFIX='character-group:';
const NO_PINS:string[]=[];
export const recentFoldersKey=(scope:string)=>`lakomics.mobile.assetRecentFolders:${encodeURIComponent(scope)}`;

/** Images filed into a folder from the batch sheet or the viewer (the PC records the same moves). */
export const FOLDER_FILLED_EVENT='lakomics-folder-filled';
export const announceFolderFilled=(classificationId:string)=>window.dispatchEvent(new CustomEvent(FOLDER_FILLED_EVENT,{detail:{classificationId}}));

/** A character or 기타 inside a group is listed as the group's row. */
const inGroup=(entry:Entry,byId:Map<string,Entry>)=>entry.characterKind==='character'&&!!entry.parent_id?.startsWith(GROUP_PREFIX)&&byId.has(entry.parent_id);

/** Every place that can be remembered, keyed by the id the history stores. */
export function tabletRecentCatalog(entries:Entry[]):Map<string,TabletRecentFolder>{
  const byId=new Map(entries.map(entry=>[entry.id,entry]));
  const pathOf=(entry:Entry)=>{
    const names=[entry.name],seen=new Set([entry.id]);
    for(let parent=entry.parent_id?byId.get(entry.parent_id):undefined;parent&&!seen.has(parent.id);parent=parent.parent_id?byId.get(parent.parent_id):undefined){seen.add(parent.id);names.unshift(parent.name);}
    return names.join(' › ');
  };
  const catalog=new Map<string,TabletRecentFolder>();
  for(const entry of entries){
    if(inGroup(entry,byId))continue;
    const group=entry.characterKind==='group';
    catalog.set(entry.id,{
      id:entry.id,name:entry.name,parentName:entry.parent_id?byId.get(entry.parent_id)?.name??'':'',path:pathOf(entry),group,
      folder:{kind:entry.kind??'tag',iconKey:entry.characterKind==='character'?'user':entry.icon_key??null,colorKey:entry.color_key??null},
      view:entryView(entry),
    });
  }
  return catalog;
}

/**
 * The remembered folder a view is in, or null for places that never count: the root, 모든 자산,
 * 미분류, albums, searches by description and the revisit lists. Inside the character browser the
 * place is the browser's own location (`focusedNode`), not the view that opened it.
 */
export function tabletRecentFolderId(view:View,focusedNode:string|null|undefined,entries:Entry[]):string|null{
  if(view.tab!=='library'||view.root||view.album||view.unclassified||view.revisit||view.description)return null;
  const entry=view.characters
    ?focusedNode?entries.find(item=>item.characterNode===focusedNode):undefined
    :view.classification?entries.find(item=>item.id===view.classification):undefined;
  if(!entry)return null;
  return inGroup(entry,new Map(entries.map(item=>[item.id,item])))?entry.parent_id!:entry.id;
}

export function useTabletRecentFolders({scope,view,focusedNode,entries,ready,onOpen}:{scope:string;view:View;focusedNode:string|null|undefined;entries:Entry[];ready:boolean;onOpen(view:View):void}):TabletRecentFolders{
  const catalog=useMemo(()=>tabletRecentCatalog(entries),[entries]);
  const currentId=useMemo(()=>tabletRecentFolderId(view,focusedNode,entries),[view,focusedNode,entries]);
  // The character index can arrive after the folder list: saved character rows wait for it.
  const charactersLoaded=useRef(false);
  if(!charactersLoaded.current&&entries.some(entry=>entry.characterKind))charactersLoaded.current=true;
  const core=useRecentFolderCore({
    libraryRoot:scope,storageKey:recentFoldersKey,currentId,catalog,pinnedIds:NO_PINS,ready,
    isLateId:id=>!charactersLoaded.current&&(id.startsWith(GROUP_PREFIX)||id.startsWith('character:')),
    onOpen:folder=>onOpen(folder.view),
  });
  const {record}=core;
  useEffect(()=>{
    const filled=(event:Event)=>{const id=(event as CustomEvent<{classificationId?:string}>).detail?.classificationId;if(id)record(id);};
    window.addEventListener(FOLDER_FILLED_EVENT,filled);
    return()=>window.removeEventListener(FOLDER_FILLED_EVENT,filled);
  },[record]);
  return {...core,recordCurrent:()=>record()};
}
