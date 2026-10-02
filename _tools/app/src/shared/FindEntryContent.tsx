import type {ReactNode} from 'react';
import type {NavigationEntry} from './findEntries';
import {matchedSpans} from './findModel';
import './findEntry.css';

/** The name, match marks and quiet media are the same in both find surfaces. */
export function FindEntryContent({entry,query,privacy,media}:{entry:NavigationEntry;query:string;privacy:boolean;media?:ReactNode}) {
  return <>
    {!privacy&&<span className="find-entry__media" aria-hidden="true">{media??(entry.thumbnail?<img className={entry.avatar?'find-entry__avatar':undefined} src={entry.thumbnail} alt="" loading="lazy" decoding="async"/>:entry.icon)}</span>}
    <span className="find-entry__text"><span className="find-entry__label">{matchedSpans(entry.label,query).map((span,index)=>span.matched?<mark key={index}>{span.text}</mark>:span.text)}</span>
      {entry.context&&<span className="find-entry__meta">{entry.context}</span>}
    </span>
    {entry.activity&&<span className="find-entry__meta">{entry.activity}</span>}
    {entry.count!==undefined&&<span className="find-entry__meta">{entry.count.toLocaleString('ko-KR')}</span>}
  </>;
}
