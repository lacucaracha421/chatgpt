import {Fragment,useCallback,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {ChevronRightIcon,PhotoIcon,RectangleStackIcon,UserIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {Dialog,DialogDescription,IconButton,SectionLabel} from './ui';
import {PinSolidIcon} from '../src/shared/ui/PinIcon';
import {ClassificationIcon,classificationColor} from '../src/classification/classificationAppearance';
import {displayCount} from '../src/shared/displayDate';
import {useLongPress} from '../src/shared/useLongPress';
import {hasDuplicateRecentName} from '../src/assets/recentFolders';
import {useAndroidBack} from './cards/useAndroidBack';
import {ActionSheet} from './ActionSheet';
import {CharacterGlyph,characterKindOf} from './FolderCards';
import {entryView,folderCardCount,type Entry} from './libraryModel';
import type {TabletRecentFolder} from './recentFolders';
import type {View} from './types';
import '../src/assets/recentFolders.css';
import './folderDrawer.css';

/** The PC quick views the tablet can open. */
export type DrawerQuick='all'|'albums'|'artists';

type TreeNode={id:string;parentId:string|null;name:string;icon:ReactNode;color?:string;count?:number;onOpen():void;onActions?():void};

/** The ids to keep open for `currentId`: its ancestors and itself, where they have children. */
function pathIds(nodes:readonly TreeNode[],currentId:string|null):string[]{
  const byId=new Map(nodes.map(node=>[node.id,node])),hasKids=new Set(nodes.flatMap(node=>node.parentId?[node.parentId]:[]));
  const path:string[]=[],seen=new Set<string>();
  for(let node=currentId?byId.get(currentId):undefined;node&&!seen.has(node.id);node=node.parentId?byId.get(node.parentId):undefined){
    seen.add(node.id);
    if(hasKids.has(node.id))path.push(node.id);
  }
  return path;
}

/** A branch that eases open and shut; one first opened after the drawer is up starts closed so it can ease. */
function Branch({open,animate,children}:{open:boolean;animate:boolean;children:ReactNode}){
  const [shown,setShown]=useState(open&&!animate);
  useLayoutEffect(()=>{
    if(open===shown)return;
    if(!open){setShown(false);return;}
    const frame=requestAnimationFrame(()=>setShown(true));
    return()=>cancelAnimationFrame(frame);
  },[open,shown]);
  return <div className="folder-drawer__branch" data-open={shown} inert={!shown||undefined}><div>{children}</div></div>;
}

function Row({node,depth,current,hasKids,open,onToggle}:{node:TreeNode;depth:number;current:boolean;hasKids:boolean;open:boolean;onToggle():void}){
  const press=useLongPress({enabled:!!node.onActions,onLongPress:()=>node.onActions?.()});
  return <div className={`tree-row${current?' selected':''}`} style={{paddingLeft:depth*16}} data-drawer-current={current||undefined}>
    {hasKids?<button type="button" className="tree-expander" aria-expanded={open} aria-label={`${node.name} ${open?'접기':'펼치기'}`} onClick={onToggle}><ChevronRightIcon aria-hidden="true"/></button>:<span className="tree-leaf"/>}
    <button type="button" className="tree-select" aria-label={node.name} aria-current={current?'page':undefined} style={{'--folder-color':node.color} as CSSProperties} {...press.bind} onClick={press.click(node.onOpen)}>
      {node.icon}<span>{node.name}</span>{node.count!==undefined&&<span className="numeric">{displayCount(node.count)}</span>}
    </button>
  </div>;
}

/**
 * A tree with one open path (FOLDER-NAV-001): opening a branch shuts its open siblings and their
 * subtrees, shutting a branch shuts what is inside it, and the current place's path is open at the start.
 */
function AccordionTree({nodes,currentId}:{nodes:readonly TreeNode[];currentId:string|null}){
  const known=useMemo(()=>new Set(nodes.map(node=>node.id)),[nodes]);
  const kids=useMemo(()=>{
    const map=new Map<string|null,TreeNode[]>();
    for(const node of nodes){
      const parent=node.parentId&&known.has(node.parentId)&&node.parentId!==node.id?node.parentId:null;
      map.set(parent,[...(map.get(parent)??[]),node]);
    }
    return map;
  },[nodes,known]);
  const initial=useRef(pathIds(nodes,currentId));
  const [open,setOpen]=useState(()=>new Set(initial.current));
  const [mounted,setMounted]=useState(()=>new Set(initial.current));
  const parentOf=(id:string)=>{const parent=nodes.find(node=>node.id===id)?.parentId;return parent&&known.has(parent)?parent:null;};
  const subtree=(id:string):string[]=>[id,...(kids.get(id)??[]).flatMap(child=>subtree(child.id))];
  const toggle=(id:string)=>{
    const next=new Set(open);
    if(next.has(id))subtree(id).forEach(item=>next.delete(item));
    else{
      for(const sibling of kids.get(parentOf(id))??[])if(sibling.id!==id)subtree(sibling.id).forEach(item=>next.delete(item));
      next.add(id);
    }
    setOpen(next);setMounted(previous=>previous.has(id)?previous:new Set(previous).add(id));
  };
  const rows=(parent:string|null,depth:number):ReactNode=>(kids.get(parent)??[]).map(node=>{
    const children=kids.get(node.id)??[],isOpen=open.has(node.id);
    return <Fragment key={node.id}>
      <Row node={node} depth={depth} current={node.id===currentId} hasKids={children.length>0} open={isOpen} onToggle={()=>toggle(node.id)}/>
      {children.length>0&&mounted.has(node.id)&&<Branch open={isOpen} animate={!initial.current.includes(node.id)}>{rows(node.id,depth+1)}</Branch>}
    </Fragment>;
  });
  return <div className="classification-tree">{rows(null,0)}</div>;
}

function PinChip({entry,onOpen,onActions}:{entry:Entry;onOpen():void;onActions?():void}){
  const press=useLongPress({enabled:!!onActions,onLongPress:()=>onActions?.()});
  return <button type="button" className="folder-drawer__pin" aria-label={entry.name} {...press.bind} onClick={press.click(onOpen)}><PinSolidIcon/><span>{entry.name}</span></button>;
}

function RecentChip({folder,duplicate,onOpen,onActions}:{folder:TabletRecentFolder;duplicate:boolean;onOpen():void;onActions():void}){
  const press=useLongPress({onLongPress:onActions});
  return <button type="button" className="ui-button ui-button--quiet ui-button--md recent-folders__chip" aria-description={folder.path} style={{'--folder-color':classificationColor(folder.folder.colorKey)} as CSSProperties} {...press.bind} onClick={press.click(onOpen)}>
    {folder.group?<CharacterGlyph kind="group"/>:<ClassificationIcon kind={folder.folder.kind} iconKey={folder.folder.iconKey} testId={false}/>}
    <span>{duplicate&&folder.parentName&&<span className="recent-folders__parent">{folder.parentName} › </span>}{folder.name}</span>
  </button>;
}

const entryIcon=(entry:Entry)=>{
  const kind=characterKindOf(entry);
  return kind?<CharacterGlyph kind={kind}/>:<ClassificationIcon kind={entry.kind??'tag'} iconKey={entry.icon_key??null} testId={false}/>;
};

/**
 * The tablet's folder drawer (TABLET-STRUCT-001 B): the PC sidebar's content in the left full-height
 * panel, opened only by the ☰ button. 빠른 보기, 고정, 최근, the folder tree and the album tree in that
 * order; a tap opens the place (the owner closes the drawer), a long press opens the same action sheet
 * as the folder card or album row. Back, ✕ and the scrim close it.
 */
export function FolderDrawer({entries,currentFolderId,quickCurrent,pinnedIds,recent,onClose,onQuick,onOpenView,onOpenRecent,onRemoveRecent,onFolderActions}:{
  entries:readonly Entry[];currentFolderId:string|null;quickCurrent:DrawerQuick|null;
  pinnedIds:readonly string[];recent:readonly TabletRecentFolder[];onClose():void;onQuick(kind:DrawerQuick):void;onOpenView(view:View):void;onOpenRecent(folder:TabletRecentFolder):void;onRemoveRecent(id:string):void;
  /** Long press on a plain folder (absent until the tablet may edit folders). */onFolderActions?(entry:Entry):void;
}){
  useAndroidBack(onClose);
  const scroller=useRef<HTMLDivElement>(null);
  const [recentSheet,setRecentSheet]=useState<TabletRecentFolder|null>(null);
  const plainActions=useCallback((entry:Entry)=>onFolderActions&&!entry.characterNode?()=>onFolderActions(entry):undefined,[onFolderActions]);
  const folderNodes=useMemo<TreeNode[]>(()=>entries.map(entry=>({
    id:entry.id,parentId:entry.parent_id,name:entry.name,icon:entryIcon(entry),color:characterKindOf(entry)?undefined:classificationColor(entry.color_key??null),count:folderCardCount(entry),
    onOpen:()=>onOpenView(entryView(entry)),onActions:plainActions(entry),
  })),[entries,onOpenView,plainActions]);
  const byId=useMemo(()=>new Map(entries.map(entry=>[entry.id,entry])),[entries]);
  const pins=pinnedIds.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);
  const roots=entries.filter(entry=>!entry.parent_id||!byId.has(entry.parent_id)).length;
  // The current place is in view when the drawer opens.
  useLayoutEffect(()=>{
    const host=scroller.current,row=host?.querySelector<HTMLElement>('[data-drawer-current]');
    if(!host||!row)return;
    const delta=row.getBoundingClientRect().top-host.getBoundingClientRect().top;
    if(delta<48||delta>host.clientHeight-96)host.scrollTop+=delta-host.clientHeight*.35;
  },[]);
  const quick=(kind:DrawerQuick,label:string,Icon:typeof PhotoIcon)=>{
    const current=quickCurrent===kind;
    return <button type="button" className="folder-drawer__link" aria-current={current?'page':undefined} onClick={()=>onQuick(kind)}><Icon aria-hidden="true"/><span>{label}</span></button>;
  };
  return <Dialog open title="폴더 서랍" headingClassName="sr-only" onClose={onClose}>
    <DialogDescription className="sr-only">폴더와 앨범 사이를 이동합니다. 길게 누르면 작업 메뉴가 열립니다.</DialogDescription>
    <div className="classification-index folder-drawer">
      <div className="dialog-header"><span>에셋</span><IconButton label="서랍 닫기" icon={XMarkIcon} onClick={onClose}/></div>
      <div className="folder-drawer__scroll" ref={scroller}>
        <SectionLabel title="빠른 보기"/>
        <nav className="folder-drawer__quick" aria-label="빠른 보기">
          {quick('all','모든 자산',PhotoIcon)}
          {quick('albums','앨범',RectangleStackIcon)}
          {quick('artists','작가',UserIcon)}
        </nav>
        {pins.length>0&&<div className="folder-drawer__late">
          <SectionLabel title="고정"/>
          <div className="folder-drawer__pins" role="group" aria-label="고정한 폴더">{pins.map(entry=><PinChip key={entry.id} entry={entry} onOpen={()=>onOpenView(entryView(entry))} onActions={plainActions(entry)}/>)}</div>
        </div>}
        {recent.length>0&&<>
          <SectionLabel title="최근"/>
          <div className="recent-row" role="group" aria-label="최근 폴더">{recent.map(folder=><RecentChip key={folder.id} folder={folder} duplicate={hasDuplicateRecentName(recent,folder)} onOpen={()=>onOpenRecent(folder)} onActions={()=>setRecentSheet(folder)}/>)}</div>
        </>}
        <SectionLabel title="폴더" count={roots}/>
        {entries.length>0?<AccordionTree nodes={folderNodes} currentId={currentFolderId}/>:<p className="hint">아직 게시된 분류가 없습니다.</p>}
      </div>
    </div>
    {recentSheet&&<ActionSheet onClose={()=>setRecentSheet(null)} target={{name:recentSheet.name,meta:recentSheet.path,color:classificationColor(recentSheet.folder.colorKey),thumb:<ClassificationIcon kind={recentSheet.folder.kind} iconKey={recentSheet.folder.iconKey} testId={false}/>}}
      items={[{id:'remove-recent',label:'최근에서 빼기',icon:'remove',run:()=>onRemoveRecent(recentSheet.id)}]}/>}
  </Dialog>;
}
