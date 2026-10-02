import {useEffect,useRef,useState} from 'react';
import {api,errorText} from './transport';
import {normalizeArtists,type LibraryArtist} from './artistsModel';
/** Local artist names for the retained root and gallery search, isolated by connection. */
export function useLibraryArtists(active:boolean,revision:number,scope?:string) {
  const [artists,setArtists]=useState<LibraryArtist[]>([]),[state,setState]=useState<'idle'|'loading'|'ready'|'empty'>('idle'),[error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const completed=useRef<string|null>(null);
  const [resultScope,setResultScope]=useState(scope);
  useEffect(()=>{
    const key=`${scope??''}:${revision}:${retry}`;
    if(!active||completed.current===key)return;
    const controller=new AbortController();
    setState(previous=>previous==='idle'?'loading':previous);setError('');
    void api<unknown>('/v1/library/artists',controller.signal).then(reply=>{
      if(controller.signal.aborted)return;
      const next=normalizeArtists(reply);completed.current=key;setResultScope(scope);setArtists(next);setState(next.length?'ready':'empty');
    }).catch(reason=>{if(!controller.signal.aborted){setError(errorText(reason));setState(previous=>previous==='loading'?'empty':previous);}});
    return()=>controller.abort();
  },[active,revision,retry,scope]);
  return {artists:resultScope===scope?artists:[],state,error,retry:()=>setRetry(value=>value+1)};
}
