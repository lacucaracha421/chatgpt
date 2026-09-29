import {useEffect,useRef,useState} from 'react';
import {FolderIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {errorText,native} from './transport';
import {flattenMembershipAlbums,type AlbumMembershipState} from './AlbumMembershipEditor';

type Progress = {done:number;total:number};

export function AlbumBatchSheet({assetIds,open,onClose,onComplete}:{assetIds:string[];open:boolean;onClose():void;onComplete():void}) {
  const [state,setState]=useState<AlbumMembershipState|null>(null);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(false);
  const [progress,setProgress]=useState<Progress|null>(null);
  const [error,setError]=useState('');
  const [confirmation,setConfirmation]=useState('');
  const generation=useRef(0);
  const firstAssetId=assetIds[0]??'';

  useEffect(()=>{
    generation.current++;
    const current=generation.current;
    if(!open||!firstAssetId){setState(null);setLoading(false);setBusy(false);setProgress(null);setError('');setConfirmation('');return;}
    const controller=new AbortController();
    setState(null);setLoading(true);setBusy(false);setProgress(null);setError('');setConfirmation('');
    void native<AlbumMembershipState>('albumMemberships',{assetId:firstAssetId},controller.signal).then(next=>{
      if(current===generation.current&&!controller.signal.aborted){setState(next);setLoading(false);}
    },reason=>{
      if(current===generation.current&&!controller.signal.aborted){setError(errorText(reason));setLoading(false);}
    });
    return()=>{generation.current++;controller.abort();};
  },[firstAssetId,open]);

  const addToAlbum=async(albumId:string,albumName:string)=>{
    if(!state?.adopted||busy||confirmation||assetIds.length===0)return;
    setError('');
    setProgress({done:0,total:assetIds.length});
    setBusy(true);
    for(const [index,assetId] of assetIds.entries()){
      try{
        await native<AlbumMembershipState>('albumMembershipSet',{assetId,albumId,desiredState:true});
        setProgress({done:index+1,total:assetIds.length});
      }catch(reason){
        setError(errorText(reason)||'앨범에 추가하지 못했습니다.');
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    setConfirmation(`${assetIds.length}장을 ${albumName}에 추가했습니다`);
    onComplete();
  };

  return <BottomSheet title="앨범에 추가" onClose={()=>{if(!busy)onClose();}}>
    {loading&&<div className="loading-line" role="status" aria-label="앨범 목록을 불러오는 중"/>}
    {error&&<p className="error-message" role="alert">{error}</p>}
    {progress&&<p className="album-batch-progress" role="status">{progress.done}/{progress.total}</p>}
    {confirmation&&<p className="album-batch-confirmation" role="status">{confirmation}</p>}
    {state&&!state.adopted&&<p className="hint">앨범 동기화가 준비된 뒤 편집할 수 있습니다.</p>}
    {state?.adopted&&!confirmation&&<div className="album-batch-list" aria-busy={busy}>
      {flattenMembershipAlbums(state.albums).map(({album,depth})=><button type="button" className="album-batch-entry" key={album.id} style={{paddingLeft:12+depth*20}} disabled={busy} onClick={()=>void addToAlbum(album.id,album.name)}>
        <FolderIcon aria-hidden="true"/><span>{album.name}</span>
      </button>)}
    </div>}
  </BottomSheet>;
}
