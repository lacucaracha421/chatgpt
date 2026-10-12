import {LoadingLine} from './TopBar';
import {useEffect,useRef,useState} from 'react';
import {RectangleStackIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {errorText,native} from './transport';
import {batches,manyFailures,type ManyReply} from './batchCommands';
import {flattenMembershipAlbums,type AlbumMembershipState} from './AlbumMembershipEditor';

type Progress = {done:number;total:number};

export function AlbumBatchSheet({assetIds,open,onClose,onComplete,onPartial}:{assetIds:string[];open:boolean;onClose():void;onComplete():void;onPartial?(failedIds:string[]):void}) {
  const [state,setState]=useState<AlbumMembershipState|null>(null);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(false);
  const [progress,setProgress]=useState<Progress|null>(null);
  const [error,setError]=useState('');
  const [confirmation,setConfirmation]=useState('');
  const [remaining,setRemaining]=useState<string[]|null>(null);
  const generation=useRef(0);
  const firstAssetId=assetIds[0]??'';

  useEffect(()=>{
    generation.current++;
    const current=generation.current;
    if(!open||!firstAssetId){setState(null);setLoading(false);setBusy(false);setProgress(null);setError('');setConfirmation('');setRemaining(null);return;}
    const controller=new AbortController();
    setState(null);setLoading(true);setBusy(false);setProgress(null);setError('');setConfirmation('');setRemaining(null);
    void native<AlbumMembershipState>('albumMemberships',{assetId:firstAssetId},controller.signal).then(next=>{
      if(current===generation.current&&!controller.signal.aborted){setState(next);setLoading(false);}
    },reason=>{
      if(current===generation.current&&!controller.signal.aborted){setError(errorText(reason));setLoading(false);}
    });
    return()=>{generation.current++;controller.abort();};
  },[firstAssetId,open]);

  const addToAlbum=async(albumId:string,albumName:string)=>{
    const targets=remaining??assetIds;
    if(!state?.adopted||busy||confirmation||targets.length===0)return;
    setError('');
    setProgress({done:0,total:targets.length});
    setBusy(true);
    const failed:string[]=[];
    let firstProblem='',done=0;
    // One native call per 100 Assets; each Asset keeps its own outcome.
    for(const chunk of batches(targets)){
      let problems:(string|null)[];
      try{
        problems=manyFailures(chunk,await native<ManyReply>('albumMembershipSetMany',{albumId,assetIds:chunk,desiredState:true}),'앨범에 추가하지 못했습니다.');
      }catch(reason){
        problems=chunk.map(()=>errorText(reason)||'앨범에 추가하지 못했습니다.');
      }
      chunk.forEach((assetId,index)=>{
        if(problems[index]===null)return;
        failed.push(assetId);
        if(!firstProblem)firstProblem=problems[index]!;
      });
      done+=chunk.length;
      setProgress({done,total:targets.length});
    }
    setBusy(false);
    if(failed.length){
      // Only the failures stay selected and are offered again; what was added is already queued.
      setRemaining(failed);
      setError(`${targets.length}개 중 ${targets.length-failed.length}개 추가, ${failed.length}개 실패. ${firstProblem}`);
      onPartial?.(failed);
      return;
    }
    setConfirmation(`${targets.length}장을 ${albumName}에 추가했습니다`);
    onComplete();
  };

  return <BottomSheet title="앨범에 추가" onClose={()=>{if(!busy)onClose();}}>
    <LoadingLine label={(loading)&&'앨범 목록을 불러오는 중'}/>
    {error&&<p className="error-message" role="alert">{error}</p>}
    {progress&&<p className="album-batch-progress" role="status">{progress.done}/{progress.total}</p>}
    {confirmation&&<p className="album-batch-confirmation" role="status">{confirmation}</p>}
    {state&&!state.adopted&&<p className="hint">앨범 동기화가 준비된 뒤 편집할 수 있습니다.</p>}
    {state?.adopted&&!confirmation&&<div className="album-batch-list" aria-busy={busy}>
      {flattenMembershipAlbums(state.albums).map(({album,depth})=><button type="button" className="album-batch-entry" key={album.id} style={{paddingLeft:12+depth*20}} disabled={busy} onClick={()=>void addToAlbum(album.id,album.name)}>
        <RectangleStackIcon aria-hidden="true"/><span>{album.name}</span>
      </button>)}
    </div>}
  </BottomSheet>;
}
