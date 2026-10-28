import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { StarIcon } from '@heroicons/react/24/solid';
import { SectionLabel } from '../../shared/ui/SectionLabel';
import { Tabs } from '../../shared/ui/Tabs';
import { performerName } from './performerName';
import { displayDate } from '../../shared/displayDate';
import { PERFORMER_SORTS, performerAge, performerMeasurements, performerSortMissing, type GridPerson, type PerformerEntry, type PerformerSort } from './performerGridModel';
import './performerGrid.css';

export function PerformerViewSwitch({value,onChange}:{value:'works'|'performers';onChange(value:'works'|'performers'):void}) {
  return <div className="av-view-switch"><span className="av-view-switch__divider" aria-hidden="true"/><Tabs className="ui-tabs--inline" label="AV 보기" tabs={[{value:'works',label:'작품'},{value:'performers',label:'배우'}]} value={value} onChange={onChange}/></div>;
}
export function PerformerGrid<P extends GridPerson>({entries,sort,columns,renderPortrait,onOpen}:{entries:PerformerEntry<P>[];sort:PerformerSort;columns:number;renderPortrait(entry:PerformerEntry<P>):ReactNode;onOpen(id:string):void}) {
  const missing = entries.filter(entry=>performerSortMissing(entry,sort)).length;
  return <div className="performer-grid" role="group" aria-label="AV 배우 목록" data-key={sort === 'count' || sort === 'name' ? undefined : sort} style={{'--columns':columns} as CSSProperties}>
    {entries.map((entry,index)=>{
      const {person,workCount,latestDate} = entry, age = performerAge(person), size = performerMeasurements(person);
      const height = typeof person.profile?.heightCm==='number'?`${person.profile.heightCm}cm`:'';
      const first = <>{age&&<span className={sort==='age'?'is-key':undefined}>{age}</span>}{age&&height&&<span className="performer-card__sep"> · </span>}{height&&<span className={sort==='height'?'is-key':undefined}>{height}</span>}</>;
      const cup = typeof person.profile?.cup === 'string' ? person.profile.cup.trim() : '';
      const second = <>{size.bust&&(cup&&typeof person.profile?.bandIn==='number'?<>{size.bust.slice(0,size.bust.indexOf(' ('))} <span className={sort==='cup'?'is-key':undefined}>({cup})</span></>:<span className={sort==='cup'?'is-key':undefined}>{size.bust}</span>)}{size.waist&&` ${size.waist}`}{size.hip&&` ${size.hip}`}</>;
      return <Fragment key={person.id}>
        {missing>0&&index===entries.length-missing&&<SectionLabel className="performer-grid__missing" title={`${PERFORMER_SORTS.find(option=>option.value===sort)!.label} 정보 없음`} count={missing} unit="명"/>}
        <button type="button" className="performer-card" data-performer-id={person.id} data-scrubber-index={index} onClick={()=>onOpen(person.id)}>
          <span className="performer-card__portrait">{renderPortrait(entry)}</span>
          <span className="performer-card__text"><span className="performer-card__name"><b>{performerName(person).primary}</b>{person.favorite&&<StarIcon className="performer-card__favorite" aria-label="즐겨찾기한 배우"/>}<span className={`performer-card__count${sort==='count'?' is-key':''}`}>{workCount}편{sort==='recent'&&latestDate&&<> · <span className="is-key">{displayDate(latestDate)}</span></>}</span></span>
            <span className="performer-card__stats">{(age||height)&&<span>{first}</span>}{(size.bust||size.waist||size.hip)&&<span>{second}</span>}</span>
          </span>
        </button>
      </Fragment>;
    })}
  </div>;
}
