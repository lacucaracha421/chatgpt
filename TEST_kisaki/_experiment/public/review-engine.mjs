// Standalone experiment. No filenames or evaluation labels are read by predict().
export const clone = value => structuredClone(value);
export const PRIMARY = 'aimes';
const findChar = (s, id) => s.characters.find(c => c.id === id);
const distance = (d, id, refs) => refs.length ? Math.min(...refs.map(r => d.distances[id][r])) : Infinity;

export function predict(s, d, id, feedback = true) {
  const candidates = s.characters.map(c => {
    const positive = distance(d, id, c.refs);
    const negatives = feedback ? s.records.filter(r => r.rejected.includes(c.id)).map(r => r.id) : [];
    const negative = distance(d, id, negatives);
    const nearest = c.refs.length ? c.refs.reduce((a, b) => d.distances[id][a] <= d.distances[id][b] ? a : b) : null;
    return {classId:c.id, positive, negative, nearest,
      veto:negative <= positive, eligible:positive <= s.threshold && negative > positive};
  }).sort((a,b) => a.positive-b.positive || a.classId.localeCompare(b.classId));
  const viable = candidates.filter(c => c.eligible);
  const best = viable[0];
  if (!best) return {classId:null, candidates, reason:candidates.some(c=>c.positive<=s.threshold&&c.veto)?'negative':'far'};
  if (viable[1] && viable[1].positive-best.positive < s.ambiguityMargin)
    return {classId:null,candidates,reason:'ambiguous'};
  return {classId:best.classId,candidates,reason:'match'};
}

export function recompute(s, d) {
  for (const r of s.records) {
    if (r.status === 'confirmed' || r.status === 'held') continue;
    const prediction = predict(s,d,r.id);
    r.classId = prediction.classId;
    r.status = r.classId ? 'tentative' : 'inbox';
    r.reason = prediction.reason;
  }
  return s;
}

export function initialState(d) {
  const refs = [...d.referencePool];
  return recompute({version:1, series:[{id:'series-1',name:'시리즈 미지정'}],
    characters:[{id:PRIMARY,seriesId:'series-1',name:'에이메스',refs}],
    threshold:d.threshold,ambiguityMargin:.02,
    records:d.items.map(x=>({id:x.id,status:refs.includes(x.id)?'confirmed':'inbox',
      classId:refs.includes(x.id)?PRIMARY:null,rejected:[],seed:refs.includes(x.id),reason:null}))},d);
}

function idsFor(s, action) {
  if (!Array.isArray(action.ids) || !action.ids.length) throw Error('이미지를 먼저 선택해주세요.');
  return [...new Set(action.ids)].map(id=>{
    const r=s.records.find(r=>r.id===id);
    if(!r) throw Error('선택한 이미지를 찾을 수 없습니다.');
    return r;
  });
}
function name(value) {
  const result=String(value??'').trim();
  if(!result || result.length>80) throw Error('이름은 1~80자로 입력해주세요.');
  return result;
}
export function applyAction(state,d,action) {
  const s=clone(state);
  if(action.type==='createSeries') {
    const value=name(action.name);
    if(s.series.some(x=>x.name===value)||s.series.some(x=>x.id===action.id)) throw Error('이미 있는 시리즈입니다.');
    s.series.push({id:action.id,name:value});
  } else if(action.type==='createCharacter') {
    const value=name(action.name);
    if(!s.series.some(x=>x.id===action.seriesId)) throw Error('시리즈를 선택해주세요.');
    if(s.characters.some(x=>x.id===action.id || x.seriesId===action.seriesId&&x.name===value)) throw Error('이미 있는 캐릭터입니다.');
    s.characters.push({id:action.id,seriesId:action.seriesId,name:value,refs:[]});
  } else if(action.type==='renameSeries') {
    const series=s.series.find(x=>x.id===action.id), value=name(action.name);
    if(!series) throw Error('시리즈를 찾을 수 없습니다.');
    if(s.series.some(x=>x.id!==series.id&&x.name===value)) throw Error('이미 있는 시리즈입니다.');
    series.name=value;
  } else if(action.type==='threshold') {
    if(!Number.isFinite(action.value)||action.value<0||action.value>.6) throw Error('거리 기준선 범위를 확인해주세요.');
    s.threshold=action.value;
  } else if(action.type==='reset') return initialState(d);
  else if(action.type==='recompute') { /* Confirmed and held records stay protected. */ }
  else {
    const records=idsFor(s,action);
    if(action.type==='approve') {
      if(records.some(r=>r.status!=='tentative'||!r.classId)) throw Error('검토 대기의 캐릭터 후보만 승인할 수 있습니다.');
      for(const r of records) r.status='confirmed';
    } else if(action.type==='correct') {
      const dest=findChar(s,action.classId);
      if(!dest) throw Error('이동할 캐릭터를 선택해주세요.');
      for(const r of records) {
        if(r.classId && r.classId!==dest.id && !r.rejected.includes(r.classId)) r.rejected.push(r.classId);
        r.rejected=r.rejected.filter(id=>id!==dest.id);
        for(const c of s.characters) if(c.id!==dest.id) c.refs=c.refs.filter(id=>id!==r.id);
        r.classId=dest.id;r.status='confirmed';r.seed=false;r.reason='corrected';
      }
    } else if(action.type==='reject') {
      if(records.some(r=>r.status!=='tentative'||!r.classId)) throw Error('캐릭터 후보를 선택해주세요.');
      for(const r of records) {
        if(!r.rejected.includes(r.classId))r.rejected.push(r.classId);
        r.classId=null;r.status='held';r.reason='rejected';
      }
    } else if(action.type==='hold') {
      if(records.some(r=>r.status==='confirmed')) throw Error('확정 이미지는 보류 대신 분류 수정을 사용해주세요.');
      for(const r of records){r.status='held';r.classId=null;r.reason='held';}
    } else if(action.type==='resume') {
      if(records.some(r=>r.status!=='held')) throw Error('보류 이미지만 다시 검토할 수 있습니다.');
      for(const r of records){r.status='inbox';r.classId=null;r.reason=null;}
    } else if(action.type==='reference') {
      if(records.some(r=>r.status!=='confirmed'||!r.classId)) throw Error('분류를 확정한 뒤 참조로 등록해주세요.');
      for(const r of records) {
        const c=findChar(s,r.classId);
        if(action.enabled){if(!c.refs.includes(r.id))c.refs.push(r.id);}
        else c.refs=c.refs.filter(id=>id!==r.id);
      }
    } else throw Error('지원하지 않는 작업입니다.');
  }
  return recompute(s,d);
}

// LIFO undo only: never undo an old batch across later user edits.
export function transact(session,d,action,label) {
  const next=applyAction(session.state,d,action);
  return {...session,state:next,history:[...session.history,{state:clone(session.state),label}].slice(-40)};
}
export function undo(session) {
  if(!session.history.length) return session;
  return {...session,state:clone(session.history.at(-1).state),history:session.history.slice(0,-1)};
}

export function evaluation(s,d,scope=null) {
  const trained = new Set(s.characters.flatMap(c=>c.refs));
  for(const r of s.records)if(r.rejected.length)trained.add(r.id);
  const excludedGroups=new Set([...trained].map(id=>d.items[id].duplicateGroup));
  const ids=s.records.filter(r=>(scope===null||scope.includes(r.id))&&r.status!=='confirmed'&&r.status!=='held'&&!excludedGroups.has(d.items[r.id].duplicateGroup)).map(r=>r.id);
  const counts=feedback=>{
    let tp=0,fp=0,fn=0;
    for(const id of ids){const isTarget=predict(s,d,id,feedback).classId===PRIMARY;
      if(d.items[id].positive){if(isTarget)tp++;else fn++;}else if(isTarget)fp++;
    }
    return {tp,fp,fn};
  };
  return {ids,total:ids.length,positives:ids.filter(id=>d.items[id].positive).length,
    before:counts(false),after:counts(true)};
}

export function validateSession(session,d) {
  const s=session?.state;
  if(s?.version!==1||!Array.isArray(s.series)||!Array.isArray(s.characters)||!Array.isArray(s.records)||s.records.length!==d.items.length||!Array.isArray(session.history))return false;
  const chars=new Set(s.characters.map(c=>c.id)),series=new Set(s.series.map(c=>c.id));
  if(!Number.isFinite(s.threshold)||s.threshold<0||s.threshold>.6||s.ambiguityMargin!==.02)return false;
  if(chars.size!==s.characters.length||series.size!==s.series.length)return false;
  if(!s.characters.every(c=>series.has(c.seriesId)&&typeof c.name==='string'&&Array.isArray(c.refs)&&c.refs.every(id=>s.records[id]?.status==='confirmed'&&s.records[id].classId===c.id)))return false;
  return s.records.every((r,i)=>r.id===i&&['inbox','tentative','confirmed','held'].includes(r.status)&&
    (r.classId===null||chars.has(r.classId))&&(['confirmed','tentative'].includes(r.status)?r.classId!==null:r.classId===null)&&
    Array.isArray(r.rejected)&&r.rejected.every(c=>chars.has(c)&&c!==r.classId));
}
