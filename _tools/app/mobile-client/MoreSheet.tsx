import {createContext,useCallback,useContext} from 'react';
import {EllipsisHorizontalIcon, InboxIcon, Square2StackIcon, TrashIcon} from '@heroicons/react/24/outline';
import {MORE_LABELS, NAVIGATION_GROUP_LABELS, type NavigationEntry} from '../src/shared/findEntries';
import {AREA_ICONS} from '../src/shared/ui/areaIcons';
import {BottomSheet} from './BottomSheet';
import {screenReady} from './perf';
import {CountBadge, IconButton,SectionLabel} from './ui';
import './moreSheet.css';

export function MoreButton({count, onOpen}: {count: number; onOpen(): void}) {
  return <span className="header-action-badge"><IconButton label="더보기" icon={EllipsisHorizontalIcon} onClick={onOpen}/>
    {count > 0 && <CountBadge variant="corner" className="header-badge" aria-hidden="true" value={count} max={99}/>}</span>;
}

export type MoreOptions = {
  reviewCount: number; unsortedCount: number | null; unseen: number; trashCount: number; vaultPresent: boolean;
  exchangeActivity?: string;
  onReview(): void; onUnsorted(): void; onExchange(): void; onVault(): void; onArtists(): void; onTrash(): void; onSettings(): void;
};
export type ScreenMenuEntry=NavigationEntry&{disabled?:boolean;hint?:string|null;danger?:boolean;keepOpen?:boolean};
export type ScreenMenu={title:string;entries:ScreenMenuEntry[]};
export const MoreContext=createContext<{options:MoreOptions;open(menu?:ScreenMenu):void}|null>(null);
function MoreEntryList({entries,heading,onRun}:{entries:ScreenMenuEntry[];heading:string;onRun():void}) {
  if(!entries.length)return null;
  return <nav className="more-panel__navigation" aria-label={heading}><SectionLabel className="workspace-section-label" title={heading}/>{entries.map(entry=><button key={entry.id} type="button" className={`workspace-index-link${entry.danger?' is-danger':''}`} disabled={entry.disabled} aria-label={entry.count===undefined?undefined:`${entry.label} ${entry.count.toLocaleString()}개`} aria-description={entry.hint??entry.activity} onClick={()=>{if(!entry.keepOpen)onRun();entry.run();}}>
    <span className="more-panel__icon" aria-hidden="true">{entry.icon}</span><span className="more-panel__label">{entry.label}{entry.hint&&<small>{entry.hint}</small>}</span>{entry.count!==undefined&&<span className="more-panel__count">{entry.count.toLocaleString()}</span>}{entry.activity&&<span className="more-panel__activity" aria-hidden="true"/>}
  </button>)}</nav>;
}

export function tabletMoreEntries(options: MoreOptions): NavigationEntry[] {
  const queue = (count: number | null) => (count ?? 0) > 0 ? 'queue' as const : 'go' as const;
  const count = (value: number | null) => value !== null && value > 0 ? value : undefined;
  return [
    {id:'review', group:queue(options.reviewCount), label:MORE_LABELS.review, icon:<Square2StackIcon/>, count:count(options.reviewCount), run:options.onReview},
    {id:'unsorted', group:queue(options.unsortedCount), label:MORE_LABELS.unsorted, icon:<InboxIcon/>, count:count(options.unsortedCount), run:options.onUnsorted},
    {id:'exchange', group:queue(options.unseen), label:MORE_LABELS.exchange, icon:<AREA_ICONS.exchange/>, count:count(options.unseen), activity:options.exchangeActivity, run:options.onExchange},
    ...(options.vaultPresent ? [{id:'private_vault', group:'go' as const, label:MORE_LABELS.private_vault, icon:<AREA_ICONS.private_vault/>, run:options.onVault}] : []),
    {id:'artists', group:'go', label:MORE_LABELS.artists, icon:<AREA_ICONS.artists/>, run:options.onArtists},
    {id:'trash', group:'go', label:MORE_LABELS.trash, icon:<TrashIcon/>, count:count(options.trashCount), run:options.onTrash},
    {id:'settings', group:'go', label:MORE_LABELS.settings, icon:<AREA_ICONS.settings/>, run:options.onSettings},
  ];
}

export function MoreSheet({onClose, screenEntries=[],screenTitle,screenHint,screenError, ...options}: Partial<MoreOptions> & {onClose(): void;screenEntries?:ScreenMenuEntry[];screenTitle?:string;screenHint?:string;screenError?:string}) {
  const more=useContext(MoreContext);
  const entries = options.onReview ? tabletMoreEntries(options as MoreOptions) : more ? tabletMoreEntries(more.options) : [];
  // The sheet renders in the dialog's portal, outside the app root, and after this component's own
  // commit; its content reports itself shown as it attaches, so More's screen timing can complete.
  const shown = useCallback((element: HTMLDivElement | null) => { if (element) screenReady('more', element); }, []);
  return <BottomSheet title={screenEntries.length?screenTitle??'더보기':'더보기'} onClose={onClose}><div className="tablet-more" ref={shown}>
    <MoreEntryList entries={screenEntries} heading={screenTitle??'이 화면'} onRun={onClose}/>{screenHint&&<p className="hint">{screenHint}</p>}{screenError&&<p role="alert" className="collection-manage-failure">{screenError}</p>}
    <MoreEntryList entries={entries.filter(entry => entry.group === 'queue')} heading={NAVIGATION_GROUP_LABELS.queue} onRun={onClose}/>
    <MoreEntryList entries={entries.filter(entry => entry.group === 'go')} heading={NAVIGATION_GROUP_LABELS.go} onRun={onClose}/>
  </div></BottomSheet>;
}
