import { useEffect, useState } from 'react';
import { api, errorText } from './transport';
import { collectionPath, personPath, personReply, type AvPerson, type CollectionPage, type CollectionPerson, type CollectionSummary } from './collectionModel';
import { derivePerformerEntries, type PerformerEntry } from '../src/collections/av/performerGridModel';
import { outboxConnection } from './outboxConnection';
import { selectionCrop } from './collectionCommandOutbox';

type Person = AvPerson & {favorite:boolean};
type Read = {key:string;entries:PerformerEntry<Person>[];works:CollectionSummary[];revision:string};
const remembered = new Map<string,Read>();
/** Complete work counts and profile facts commit together, never as partial performer cards. */
export function useTabletPerformerGrid(key:string,enabled:boolean,source:CollectionPage|null,refreshKey:unknown) {
  const [read,setRead] = useState<Read|null>(()=>remembered.get(key)??null);
  const [error,setError] = useState('');
  const [attempt,setAttempt] = useState(0);
  useEffect(()=>{
    if(!enabled)return;
    setError('');
    const controller=new AbortController(), connection=outboxConnection();
    void (async()=>{
      let page=source??await api<CollectionPage>(collectionPath('av','',false,null),controller.signal);
      if(!page.ready)throw new Error('PC 앱의 AV 컬렉션이 아직 공유되지 않았습니다.');
      const works=[...page.items], revision=page.revision??'';
      while(page.nextCursor){
        page=await api<CollectionPage>(collectionPath('av','',false,page.nextCursor),controller.signal);
        if((page.revision??'')!==revision)throw new Error('작품 목록이 변경되었습니다. 다시 불러와 주세요.');
        works.push(...page.items);
      }
      const credits=new Map<string,AvPerson>();
      for(const work of works)for(const person of work.av?.people??[])if(person.role==='performer')credits.set(person.id,person);
      // The plain work list carries name sources, but not complete profiles or favourites.
      // Reuse the existing person endpoint, with four requests in flight at most.
      const queue=[...credits.keys()], people=new Map<string,CollectionPerson>();
      await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{
        while(queue.length){
          const id=queue.shift()!;
          const reply=await api<unknown>(personPath(id),controller.signal,undefined,'GET',true);
          const person=personReply(reply,id,connection);
          if(!person)throw new Error('배우 프로필을 불러오지 못했습니다.');
          people.set(id,person);
        }
      }));
      const entries=derivePerformerEntries(works,work=>(work.av?.people??[]).filter(person=>person.role==='performer').map(person=>{
        const profile=people.get(person.id)!;
        const crop=selectionCrop(profile.portraitSelection)??(profile.portraitSelection===null?null:person.portraitCrop);
        return {...person,...profile,name:profile.displayName??person.name,portraitCrop:crop};
      }));
      const next={key,entries,works,revision};
      if(!controller.signal.aborted&&outboxConnection()===connection){remembered.set(key,next);setRead(next);setError('');}
    })().catch(reason=>{if(!controller.signal.aborted)setError(errorText(reason));});
    return()=>controller.abort();
  },[key,enabled,source,refreshKey,attempt]);
  return {data:read?.key===key?read:remembered.get(key),error,retry:()=>setAttempt(value=>value+1)};
}
