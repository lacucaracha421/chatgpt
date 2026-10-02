import {useEffect,useState} from 'react';
import {api} from './transport';
import type {AssetSuggestion} from './assetSearchModel';

type TagReply={items:{kind:'tag';id:string;label:string;count:number}[]};
export function useTagSuggestions(text:string,endpoint:string,paused:boolean) {
  const [result,setResult]=useState<{endpoint:string;items:AssetSuggestion[]}>({endpoint,items:[]});
  const [pending,setPending]=useState(false);
  useEffect(()=>{
    const query=text.trim();
    if(paused||!query){setPending(false);return;}
    const controller=new AbortController();setPending(true);
    const timer=window.setTimeout(()=>{
      const params=new URLSearchParams({text:query.slice(0,200),limit:'10'});
      void api<TagReply>(`/v1/library/search/suggestions?${params}`,controller.signal,undefined,undefined,false,endpoint).then(reply=>{
        if(controller.signal.aborted)return;
        const items=(Array.isArray(reply?.items)?reply.items:[]).filter(item=>item.kind==='tag'&&typeof item.id==='string'&&typeof item.label==='string').map(item=>({kind:'tag' as const,id:item.id,name:item.label,count:item.count}));
        setResult({endpoint,items});
      }).catch(()=>{if(!controller.signal.aborted)setResult({endpoint,items:[]});})
        .finally(()=>{if(!controller.signal.aborted)setPending(false);});
    },200);
    return()=>{clearTimeout(timer);controller.abort();};
  },[text,endpoint,paused]);
  return {items:result.endpoint===endpoint?result.items:[],pending};
}
