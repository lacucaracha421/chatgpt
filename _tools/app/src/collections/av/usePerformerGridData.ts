import { useEffect, useState } from 'react';
import type { CollectionSummary, LibraryGateway } from '../../library/types';
import type { AvCreditPerson, AvGateway } from '../avTypes';
import { derivePerformerEntries, type PerformerEntry } from './performerGridModel';

type GridRead = {root:string;entries:PerformerEntry<AvCreditPerson & {favorite:boolean}>[]};
const remembered = new Map<string,GridRead>();
export function usePerformerGridData(api:AvGateway,gateway:LibraryGateway,root:string,works:CollectionSummary[],enabled:boolean) {
  const [read,setRead] = useState<GridRead|null>(()=>remembered.get(root)??null);
  const [error,setError] = useState('');
  const [attempt,setAttempt] = useState(0);
  useEffect(()=>{
    if(!enabled||!api.listPerformerCredits)return;
    setError('');
    let active=true;
    void Promise.all([api.listPerformerCredits(),gateway.listAvFavorites?.()??Promise.resolve([])]).then(([index,favorites])=>{
      const favoriteIds=new Set(favorites.map(person=>person.id));
      const people=new Map(index.people.map(person=>[person.id,{...person,favorite:favoriteIds.has(person.id)}]));
      const credits=new Map<string,(AvCreditPerson & {favorite:boolean})[]>();
      for(const credit of index.credits){const person=people.get(credit.personId);if(person)credits.set(credit.collectionId,[...(credits.get(credit.collectionId)??[]),person]);}
      const next={root,entries:derivePerformerEntries(works.filter(work=>work.type==='av'),work=>credits.get(work.id))};
      if(active){remembered.set(root,next);setRead(next);setError('');}
    },()=>{if(active)setError('배우 목록을 불러오지 못했습니다.');});
    return()=>{active=false;};
  },[api,gateway,root,works,enabled,attempt]);
  return {entries:(read?.root===root?read:remembered.get(root))?.entries,error,retry:()=>setAttempt(value=>value+1)};
}
