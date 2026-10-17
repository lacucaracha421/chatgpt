import {LoadingLine} from './TopBar';
import {useEffect,useRef,useState} from 'react';
import {RectangleStackIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {errorText,native} from './transport';
import {batches,manyFailures,type ManyReply} from './batchCommands';
import {flattenMembershipAlbums,type AlbumMembershipState} from './AlbumMembershipEditor';
import {RecentDestinations,albumDestinationChips} from './RecentDestinations';
import {RECENT_DONE_MS} from './ClassificationAssignmentEditor';
import {announceAlbumFilled,useFrozenIds,useRecentDestinationIds} from './recentDestinationHistory';

type Progress = {done:number;total:number};
/** Beyond this many selected images the sheet does not check which albums already hold all of them. */
const CONTAINMENT_CHECK_LIMIT = 100;

export function AlbumBatchSheet({assetIds,open,onClose,onComplete,onPartial}:{assetIds:string[];open:boolean;onClose():void;onComplete():void;onPartial?(failedIds:string[]):void}) {
  const [state,setState]=useState<AlbumMembershipState|null>(null);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(false);
  const [progress,setProgress]=useState<Progress|null>(null);
  const [error,setError]=useState('');
  const [confirmation,setConfirmation]=useState('');
  const [remaining,setRemaining]=useState<string[]|null>(null);
  // A tap on a 최근 chip adds at once: its done state shows in place and the sheet closes itself, the selection stays.
  const recentIds=useFrozenIds(useRecentDestinationIds().albums,true);
  const [doneId,setDoneId]=useState<string|null>(null);
  const [chipStatus,setChipStatus]=useState('');
  const [holdingAll,setHoldingAll]=useState<ReadonlySet<string>>(new Set());
  const closeTimer=useRef<number|undefined>(undefined);
  useEffect(()=>()=>window.clearTimeout(closeTimer.current),[]);
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

  // Albums that already hold every selected image: known from each image's own memberships.
  useEffect(()=>{
    if(!state?.adopted){setHoldingAll(new Set());return;}
    const first=new Set(state.albums.filter(album=>album.desiredState).map(album=>album.id));
    if(assetIds.length<=1||assetIds.length>CONTAINMENT_CHECK_LIMIT||!first.size){setHoldingAll(assetIds.length===1?first:new Set());return;}
    const controller=new AbortController();
    let common=first;
    void Promise.all(assetIds.slice(1).map(assetId=>native<AlbumMembershipState>('albumMemberships',{assetId},controller.signal).then(other=>{
      const held=new Set(other.albums.filter(album=>album.desiredState).map(album=>album.id));
      common=new Set([...common].filter(id=>held.has(id)));
    }))).then(()=>{if(!controller.signal.aborted)setHoldingAll(common);},()=>{});
    return()=>controller.abort();
  },[state,assetIds]);

  const addToAlbum=async(albumId:string,albumName:string,viaChip=false)=>{
    const targets=remaining??assetIds;
    if(!state?.adopted||busy||confirmation||doneId||targets.length===0)return;
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
    if(failed.length<targets.length)announceAlbumFilled(albumId);
    if(failed.length){
      // Only the failures stay selected and are offered again; what was added is already queued.
      setRemaining(failed);
      setError(`${targets.length}개 중 ${targets.length-failed.length}개 추가, ${failed.length}개 실패. ${firstProblem}`);
      onPartial?.(failed);
      return;
    }
    if(viaChip){
      setDoneId(albumId);setChipStatus(`${targets.length}장을 ${albumName}에 추가했습니다`);
      closeTimer.current=window.setTimeout(onClose,RECENT_DONE_MS);
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
    {state?.adopted&&!confirmation&&<RecentDestinations chips={albumDestinationChips(recentIds,state.albums)} label="최근 앨범" doneId={doneId} status={chipStatus} disabledIds={holdingAll}
      onPick={chip=>void addToAlbum(chip.id,chip.name,true)}/>}
    {state?.adopted&&!confirmation&&<div className="album-batch-list" aria-busy={busy}>
      {flattenMembershipAlbums(state.albums).map(({album,depth})=><button type="button" className="album-batch-entry" key={album.id} style={{paddingLeft:12+depth*20}} disabled={busy||!!doneId} onClick={()=>void addToAlbum(album.id,album.name)}>
        <RectangleStackIcon aria-hidden="true"/><span>{album.name}</span>
      </button>)}
    </div>}
  </BottomSheet>;
}
