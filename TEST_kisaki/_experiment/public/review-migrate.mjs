import {clone,predict,evaluation,validateSession} from './review-engine.mjs';

export function envelope(data,session){return {model:data.model,items:data.items.map(x=>({id:x.id,path:x.path,sha256:x.sha256})),session};}

// Identity = bytes, not a filename or array index. Removed evidence must not vanish.
export function migrate(saved,next){
 if(JSON.stringify(saved.model)!==JSON.stringify(next.model))throw Error('모델이 달라 기존 참조를 연결할 수 없습니다.');
 if(!validateSession(saved.session,saved)||saved.session.history.some(h=>!validateSession({state:h.state,history:[]},saved)))throw Error('기존 검토 기록 형식을 확인해주세요.');
 const mapping=new Map(),claimed=new Set();
 for(const old of saved.items){
  const matches=next.items.filter(x=>x.sha256===old.sha256&&!claimed.has(x.id));
  const item=matches.find(x=>x.path===old.path)??matches[0];
  if(!item)throw Error('기존 이미지가 빠져 있습니다. 교체 분석 대신 추가 분석을 사용해주세요. 기존 기록은 유지됩니다.');
  mapping.set(old.id,item.id);claimed.add(item.id);
 }
 const newIds=next.items.filter(x=>!claimed.has(x.id)).map(x=>x.id);
 function convert(state){
  const s=clone(state),records=Array(next.items.length);
  s.characters=s.characters.map(c=>({...c,refs:c.refs.map(id=>mapping.get(id))}));
  for(const r of s.records)records[mapping.get(r.id)]={...r,id:mapping.get(r.id)};
  for(const id of newIds)records[id]={id,status:'inbox',classId:null,rejected:[],seed:false,reason:null};
  s.records=records;
  for(const id of newIds){const p=predict(s,next,id);records[id].classId=p.classId;records[id].status=p.classId?'tentative':'inbox';records[id].reason=p.reason;}
  return s;
 }
 const result={...clone(saved.session),state:convert(saved.session.state),history:saved.session.history.map(h=>({...h,state:convert(h.state)}))};
 if(result.appendBatch)result.appendBatch.ids=result.appendBatch.ids.map(id=>mapping.get(id));
 if(newIds.length)result.appendBatch={ids:newIds,createdAt:new Date().toISOString(),initial:evaluation(result.state,next,newIds)};
 if(!validateSession(result,next))throw Error('검토 기록 연결에 실패했습니다.');
 return {session:result,newIds};
}
