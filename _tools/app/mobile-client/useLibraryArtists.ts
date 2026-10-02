import {useEffect,useRef,useState} from 'react';
import {api,errorText} from './transport';
import {normalizeArtists,type LibraryArtist} from './artistsModel';
/** Owned by the retained asset root, shared by its grid and search. */
export function useLibraryArtists(active:boolean,revision:number) {
  const [artists,setArtists]=useState<LibraryArtist[]>([]),[state,setState]=useState<'idle'|'loading'|'ready'|'empty'>('idle'),[error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const completed=useRef<string|null>(null);
  useEffect(()=>{
    const key=`${revision}:${retry}`;
    if(!active||completed.current===key)return;
    const controller=new AbortController();
    setState(previous=>previous==='idle'?'loading':previous);setError('');
    void api<unknown>('/v1/library/artists',controller.signal).then(reply=>{
      if(controller.signal.aborted)return;
      const next=normalizeArtists(reply);completed.current=key;setArtists(next);setState(next.length?'ready':'empty');
    }).catch(reason=>{if(!controller.signal.aborted){setError(errorText(reason));setState(previous=>previous==='loading'?'empty':previous);}});
    return()=>controller.abort();
  },[active,revision,retry]);
  return {artists,state,error,retry:()=>setRetry(value=>value+1)};
}
