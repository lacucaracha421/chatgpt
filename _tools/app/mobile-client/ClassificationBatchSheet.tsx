import {LoadingLine} from './TopBar';
import {useEffect,useRef,useState} from 'react';
import {BottomSheet} from './BottomSheet';
import {Button} from './ui';
import {ClassificationAssignmentChoices,type ClassificationAssignmentState} from './ClassificationAssignmentEditor';
import {errorText,native} from './transport';
import {viewerEditEvent} from './listGeneration';
import './ClassificationBatchSheet.css';

// Both replica reads and durable intent writes use at most four native requests at once.
async function forEachBounded<T>(items:T[],visit:(item:T)=>Promise<void>) {
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
    while(next<items.length)await visit(items[next++]);
  }));
}
type AssetState={assetId:string;state?:ClassificationAssignmentState;error?:string};

export function ClassificationBatchSheet({assetIds,onClose,onBusyChange,onComplete}:{assetIds:string[];onClose():void;onBusyChange(busy:boolean):void;onComplete(message:string):void}) {
  const [states,setStates]=useState<AssetState[]|null>(null);
  const [selectedId,setSelectedId]=useState<string|null|undefined>();
  const [progress,setProgress]=useState<number|null>(null);
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState('');
  const alive=useRef(false),saving=useRef(false);
  useEffect(()=>{
    alive.current=true;
    const controller=new AbortController();
    const loaded:AssetState[]=new Array(assetIds.length);
    void forEachBounded(assetIds.map((assetId,index)=>({assetId,index})),async({assetId,index})=>{
      if(controller.signal.aborted)return;
      try{
        const state=await native<ClassificationAssignmentState>('classificationAssignmentState',{assetId},controller.signal);
        loaded[index]={assetId,state};
      }catch(reason){loaded[index]={assetId,error:errorText(reason)};}
    }).then(()=>{if(!controller.signal.aborted)setStates(loaded);});
    return()=>{alive.current=false;controller.abort();onBusyChange(false);};
  },[assetIds]);
  const eligible=states?.filter(item=>item.state?.adopted&&!item.state.blocked)??[];
  const unavailable=states?.filter(item=>!item.state?.adopted||item.state.blocked)??[];
  const tree=eligible[0]?.state?.classifications;
  const replaced=selectedId===undefined?0:eligible.filter(item=>item.state?.classificationId!=null&&item.state.classificationId!==selectedId).length;
  const pending=eligible.filter(item=>item.state?.pending).length;
  const apply=async()=>{
    if(saving.current||selectedId===undefined||!eligible.length||result)return;
    saving.current=true;setBusy(true);onBusyChange(true);setProgress(0);
    let done=0,success=0,failed=unavailable.length,pendingWrites=0;
    const failures=unavailable.map(item=>item.error||item.state?.conflictMessage||'분류 동기화가 준비된 뒤 편집할 수 있습니다.');
    await forEachBounded(eligible,async({assetId})=>{
      // Do not start another write after a connection/navigation change unmounts the sheet.
      if(!alive.current){failed++;return;}
      try{
        const next=await native<ClassificationAssignmentState>('classificationAssignmentSet',{assetId,classificationId:selectedId});
        if(!next.adopted||next.blocked)throw new Error(next.conflictMessage||'분류 변경을 적용할 수 없습니다.');
        success++;if(next.pending)pendingWrites++;
      }catch(reason){failed++;failures.push(errorText(reason));}
      finally{done++;if(alive.current)setProgress(done);}
    });
    if(success)window.dispatchEvent(viewerEditEvent());
    saving.current=false;
    if(!alive.current)return;
    setBusy(false);onBusyChange(false);
    const message=`${success}/${assetIds.length}개 분류 변경${failed?` · ${failed}개 실패`:''}${pendingWrites?` · ${pendingWrites}개 저장 대기`:''}`;
    setResult(failures.length?`${message}. ${failures[0]}`:message);
    onComplete(message);
  };
  return <BottomSheet title={`분류 변경 (${assetIds.length}개)`} onClose={()=>{if(!saving.current)onClose();}}>
    <div className="classification-batch-sheet classification-assignment-editor">
      <LoadingLine label={(!states)&&'분류 상태를 불러오는 중'}/>
      {!!unavailable.length&&<p className="error-message" role="alert">{unavailable.length}개는 변경할 수 없습니다. {unavailable[0].error||unavailable[0].state?.conflictMessage||'분류 동기화가 준비된 뒤 편집할 수 있습니다.'}</p>}
      {!!pending&&!result&&<p className="hint">{pending}개 저장 대기 · 변경하면 대기 중인 분류도 바뀝니다.</p>}
      {tree&&!result&&<>
        <ClassificationAssignmentChoices classifications={tree} selectedId={selectedId} disabled={busy} onSelect={setSelectedId}/>
        {!!replaced&&<p className="hint" role="status">{replaced}개의 현재 분류가 선택한 분류로 대체됩니다.</p>}
        <Button variant="primary" disabled={busy||selectedId===undefined} onClick={()=>void apply()}>적용</Button>
      </>}
      {progress!==null&&<p role="status">{progress}/{eligible.length}개 처리</p>}
      {result&&<p role="status">{result}</p>}
    </div>
  </BottomSheet>;
}
