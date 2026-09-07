import {PRIMARY,initialState,predict,evaluation,transact,undo,validateSession} from './review-engine.mjs';
import {envelope,migrate} from './review-migrate.mjs';
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number.isFinite(n)?n.toFixed(3):'없음';
let data,session,key,view=PRIMARY,tab='tentative',selected=new Set(),visible=[],folderMode='character',renameId=null,returnToCorrection=false;
let stableKey,busy=false;
const verify=new URLSearchParams(location.search).get('verify')==='1';
const thumb=id=>data.items[id].thumbnail??`thumbs/${id}.jpg`;
const state=()=>session.state;
const character=id=>state().characters.find(c=>c.id===id);
const className=id=>character(id)?.name??'미분류';
const seriesName=id=>state().series.find(s=>s.id===id)?.name??'';
const isRef=id=>state().characters.some(c=>c.refs.includes(id));
const statusName=r=>({tentative:'검토 대기',confirmed:'확정',inbox:'검토함',held:'보류'}[r.status]);
const reasonName=reason=>({negative:'반례에 더 가까움',far:'가까운 참조 부족',ambiguous:'캐릭터 후보가 비슷함',rejected:'아님으로 확인',held:'판단 보류',corrected:'사용자가 수정'}[reason]??'참조와 유사');
function save(){try{localStorage.setItem(key,JSON.stringify(session));localStorage.setItem(stableKey,JSON.stringify(envelope(data,session)));$('storageError').hidden=true;}catch{$('storageError').hidden=false;$('storageError').textContent='브라우저에 저장하지 못했습니다. 새로고침 전에 검토 기록을 파일로 저장해주세요.';}}
function commit(action,label,clear=true){
 try{const previous=state();session=transact(session,data,action,label);
  const changed=state().records.filter((r,i)=>!['confirmed','held'].includes(previous.records[i].status)&&!['confirmed','held'].includes(r.status)&&(r.status!==previous.records[i].status||r.classId!==previous.records[i].classId)).length;
  if(clear)selected.clear();save();render();$('notice').textContent=label+(changed?` · 미확인 ${changed}장의 배정 갱신`:'');return true;
 }catch(e){$('notice').textContent=e.message;return false;}
}
function scopeRecords(){
 const s=state();let records;
 if(view==='new')records=s.records.filter(r=>session.appendBatch?.ids.includes(r.id));
 else if(view==='inbox'||view==='held')records=s.records.filter(r=>r.status===view);
 else if(view==='pending')records=s.records.filter(r=>r.status==='tentative');
 else records=s.records.filter(r=>r.classId===view&&r.status===tab);
 const mode=$('filter').value;
 if(mode==='wrong')records=records.filter(r=>r.classId===PRIMARY&&!data.items[r.id].positive);
 if(mode==='missed')records=records.filter(r=>r.classId!==PRIMARY&&data.items[r.id].positive);
 const dist=r=>predict(s,data,r.id).candidates.find(c=>c.classId===(r.classId??PRIMARY))?.positive??Infinity;
 return records.sort((a,b)=>{const x=dist(a),y=dist(b);return (x===y?0:$('sort').value==='close'?x-y:y-x)||a.id-b.id;});
}
function renderSelection(){
 const records=[...selected].map(id=>state().records[id]);
 $('selectionCount').textContent=`${records.length}장 선택`;
 $('selectAll').checked=visible.length>0&&visible.every(r=>selected.has(r.id));
 $('selectAll').indeterminate=selected.size>0&&!$('selectAll').checked;
 $('approve').disabled=!records.length||records.some(r=>r.status!=='tentative');
 $('correct').disabled=!records.length;
 $('reject').disabled=!records.length||records.some(r=>r.status!=='tentative');
 $('hold').disabled=!records.length||records.some(r=>r.status==='confirmed'||r.status==='held');
 $('resume').hidden=view!=='held';$('resume').disabled=!records.length;
 $('approveAll').hidden=!visible.length||visible.some(r=>r.status!=='tentative');
 $('approveAll').textContent=`표시된 ${visible.length}장 모두 승인`;
 for(const el of document.querySelectorAll('[data-select]')){el.checked=selected.has(Number(el.dataset.select));el.closest('.card').classList.toggle('selected',el.checked);}
}
function render(){
 const s=state();if(!['inbox','held','pending','new'].includes(view)&&!character(view))view=PRIMARY;
 const count=(status,id)=>s.records.filter(r=>r.status===status&&(!id||r.classId===id)).length;
 $('folders').innerHTML=`<button class="folder global" data-view="pending" aria-current="${view==='pending'}">검토 대기 전체 <b>${count('tentative')}</b></button><button class="folder" data-view="inbox" aria-current="${view==='inbox'}">검토함 <b>${count('inbox')}</b></button><button class="folder" data-view="held" aria-current="${view==='held'}">보류 <b>${count('held')}</b></button>`+s.series.map(series=>`<div class="series"><span>${esc(series.name)}</span><button class="compact" data-rename="${esc(series.id)}" aria-label="${esc(series.name)} 이름 변경">이름</button></div>`+s.characters.filter(c=>c.seriesId===series.id).map(c=>`<button class="folder" data-view="${esc(c.id)}" aria-current="${view===c.id}"><span>${esc(c.name)}</span><span>${count('tentative',c.id)} / ${count('confirmed',c.id)}</span></button>`).join('')).join('');
 if(session.appendBatch)$('folders').insertAdjacentHTML('afterbegin',`<button class="folder" data-view="new" aria-current="${view==='new'}">최근 추가분 <b>${session.appendBatch.ids.length}</b></button>`);
 $('evidenceSummary').innerHTML=s.characters.map(c=>`<p><b>${esc(c.name)}</b> · 참조 ${c.refs.length} · 반례 ${s.records.filter(r=>r.rejected.includes(c.id)).length}</p>`+c.refs.map(id=>`<button class="compact" data-preview="${id}" aria-label="참조 ${id+1} 확인"><img src="${thumb(id)}" alt="참조 ${id+1}"></button>`).join('')).join('');
 const current=character(view);
 $('viewTitle').textContent=current?current.name:{inbox:'검토함',held:'보류',pending:'검토 대기 전체',new:'최근 추가분'}[view];
 $('viewSubtitle').textContent=current?`${seriesName(current.seriesId)} · 참조 ${current.refs.length}장 · 반례 ${s.records.filter(r=>r.rejected.includes(view)).length}장`:
   view==='held'?'아님으로 확인하거나 판단을 미룬 이미지입니다. 자동 재계산에서 보호합니다.':'캐릭터 폴더에 임시 배정되지 않은 이미지는 검토함에서 지정할 수 있습니다.';
 $('tabs').innerHTML=current?`<button data-tab="tentative" class="${tab==='tentative'?'active':''}">검토 대기 ${count('tentative',view)}</button><button data-tab="confirmed" class="${tab==='confirmed'?'active':''}">확정 ${count('confirmed',view)}</button>`:'';
 $('metrics').innerHTML=[['tentative','검토 대기'],['confirmed','확정 · 참조 포함'],['inbox','검토함'],['held','보류']].map(([status,label])=>`<div class="metric"><strong>${count(status)}</strong><span>${label}</span></div>`).join('');
 const batch=session.appendBatch;$('batchReport').hidden=!batch;
 if(batch){const e=batch.initial;$('batchReport').innerHTML=`<h3>최근 추가 ${batch.ids.length}장 · 검토 전 고정 결과</h3><p>평가 대상 ${e.total}장 / 에이메스 ${e.positives}장</p><div class="eval-row"><span>발견 <b>${e.before.tp} → ${e.after.tp}</b></span><span>오탐 <b>${e.before.fp} → ${e.after.fp}</b></span><span>놓침 <b>${e.before.fn} → ${e.after.fn}</b></span></div><p class="muted">추가 직전의 참조와 반례를 적용한 결과입니다. 이후 검토해도 이 숫자는 바뀌지 않습니다. 참조·반례의 감지된 유사 원본은 제외합니다.</p>`;}
 const e=evaluation(s,data),negatives=s.records.filter(r=>r.rejected.length).length;
 $('feedbackCount').textContent=`반례 ${negatives}장 · 비교 대상 ${e.total}장`;
 $('evaluation').innerHTML=e.total?`<div class="eval-row"><span>에이메스 발견 <b>${e.before.tp} → ${e.after.tp} / ${e.positives}</b></span><span>오탐 <b>${e.before.fp} → ${e.after.fp}</b></span><span>놓침 <b>${e.before.fn} → ${e.after.fn}</b></span></div>`:'<p>검토하지 않은 평가 이미지가 남아 있지 않습니다.</p>';
 $('threshold').value=s.threshold.toFixed(6);
 visible=scopeRecords();selected=new Set([...selected].filter(id=>visible.some(r=>r.id===id)));
 $('scope').textContent=`현재 위치에서 ${visible.length}장 표시 · 선택/일괄 승인은 이 범위에만 적용${$('filter').value!=='all'?' · 정답 기준 필터 사용 중':''}`;
 $('grid').innerHTML=visible.map(r=>{
  const x=data.items[r.id],p=predict(s,data,r.id),candidate=p.candidates.find(c=>c.classId===(r.classId??PRIMARY));
  const truth=$('truth').checked?`<div class="badge ${!x.positive?'wrong':''}">실험 정답: ${x.positive?'에이메스':'에이메스 아님'}</div>`:'';
  return `<article class="card ${selected.has(r.id)?'selected':''}"><div class="cardhead"><label><input type="checkbox" data-select="${r.id}" aria-label="이미지 ${r.id+1} 선택">#${r.id+1}</label><span>${statusName(r)}</span></div><button class="preview" data-preview="${r.id}" aria-label="이미지 ${r.id+1}와 추천 근거 보기"><img loading="lazy" src="${thumb(r.id)}" alt="이미지 ${r.id+1}"></button><div class="caption"><div class="badge">${r.classId?esc(className(r.classId)):esc(reasonName(r.reason))}</div>${truth}<div class="muted">참조 거리 ${fmt(candidate?.positive)}${Number.isFinite(candidate?.negative)?` · 반례 ${fmt(candidate.negative)}`:''}</div><div class="filename" title="${esc(x.name)}">${esc(x.name)}</div>${r.status==='confirmed'?`<button class="refbutton" data-ref="${r.id}">${isRef(r.id)?'★ 참조 해제':'☆ 참조로 등록'}</button>`:''}</div></article>`;
 }).join('')||'<div class="empty">이 위치와 조건에 해당하는 이미지가 없습니다.</div>';
 $('undo').disabled=!session.history.length;$('undo').title=session.history.at(-1)?.label??'';
 $('history').innerHTML=session.history.slice(-10).reverse().map(h=>`<li>${esc(h.label)}</li>`).join('');renderSelection();
}
function openFolder(mode='character',id=null){folderMode=mode;renameId=id;$('folderError').textContent='';$('folderTitle').textContent=mode==='character'?'캐릭터 폴더 만들기':mode==='rename'?'시리즈 이름 변경':'시리즈 만들기';$('seriesField').hidden=mode!=='character';$('folderSeries').innerHTML=state().series.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');$('folderName').value=mode==='rename'?seriesName(id):'';$('folderDialog').showModal();$('folderName').focus();}
function openCorrection(preselect){$('correctError').textContent='';$('correctCount').textContent=`선택한 ${selected.size}장의 정답 위치를 지정합니다.`;$('destination').innerHTML=state().characters.map(c=>`<option value="${esc(c.id)}">${esc(seriesName(c.seriesId))} / ${esc(c.name)}</option>`).join('');if(preselect)$('destination').value=preselect;$('correctDialog').showModal();}
function showImage(id){
 const r=state().records[id],p=predict(state(),data,id),c=p.candidates.find(c=>c.classId===(r.classId??PRIMARY));
 const negativeIds=state().records.filter(r=>r.rejected.includes(c?.classId)).map(r=>r.id);
 const neg=negativeIds.length?negativeIds.reduce((a,b)=>data.distances[id][a]<=data.distances[id][b]?a:b):null;
 const figure=(imageId,label)=>imageId===null||imageId===undefined?`<figure><figcaption>${label}: 없음</figcaption></figure>`:`<figure><img src="${thumb(imageId)}" alt="${label}"><figcaption>${label} · #${imageId+1}</figcaption></figure>`;
 $('imageTitle').textContent=`이미지 #${id+1} · ${statusName(r)}`;
 $('imageEvidence').innerHTML=`<p class="muted">${esc(data.items[id].name)}</p><p>${esc(className(c?.classId))} 참조 거리 ${fmt(c?.positive)} · 반례 거리 ${fmt(c?.negative)}</p><div class="evidence-grid">${figure(id,'검토 이미지')}${figure(c?.nearest,'가장 가까운 참조')}${figure(neg,'가장 가까운 반례')}</div>`;$('imageDialog').showModal();
}
document.addEventListener('click',event=>{
 const t=event.target;
 const close=t.closest('[data-close]');if(close){$(close.dataset.close).close();return;}
 const folder=t.closest('[data-view]');if(folder){view=folder.dataset.view;tab='tentative';$('filter').value='all';selected.clear();render();return;}
 const tabButton=t.closest('[data-tab]');if(tabButton){tab=tabButton.dataset.tab;$('filter').value='all';selected.clear();render();return;}
 const rename=t.closest('[data-rename]');if(rename){returnToCorrection=false;openFolder('rename',rename.dataset.rename);return;}
 const preview=t.closest('[data-preview]');if(preview){showImage(Number(preview.dataset.preview));return;}
 const ref=t.closest('[data-ref]');if(ref){const id=Number(ref.dataset.ref),enabled=!isRef(id);commit({type:'reference',ids:[id],enabled},`#${id+1} ${enabled?'참조 등록':'참조 해제'}`);}
});
document.addEventListener('change',event=>{if(event.target.matches('[data-select]')){const id=Number(event.target.dataset.select);if(event.target.checked)selected.add(id);else selected.delete(id);renderSelection();}});
$('newSeries').onclick=()=>{returnToCorrection=false;openFolder('series');};
$('newCharacter').onclick=()=>{returnToCorrection=false;openFolder();};
$('folderForm').onsubmit=event=>{event.preventDefault();const id=crypto.randomUUID(),action=folderMode==='character'?{type:'createCharacter',id,name:$('folderName').value,seriesId:$('folderSeries').value}:folderMode==='rename'?{type:'renameSeries',id:renameId,name:$('folderName').value}:{type:'createSeries',id,name:$('folderName').value};
 if(commit(action,`${$('folderName').value.trim()} ${folderMode==='rename'?'이름 변경':'폴더 생성'}`,false)){$('folderDialog').close();if(returnToCorrection){returnToCorrection=false;openCorrection(id);}}else $('folderError').textContent=$('notice').textContent;
};
$('correct').onclick=()=>openCorrection();
$('createFromCorrection').onclick=()=>{$('correctDialog').close();returnToCorrection=true;openFolder();};
$('correctForm').onsubmit=event=>{event.preventDefault();const id=$('destination').value;if(commit({type:'correct',ids:[...selected],classId:id},`${selected.size}장 → ${className(id)}로 수정·확정`))$('correctDialog').close();else $('correctError').textContent=$('notice').textContent;};
$('selectAll').onchange=()=>{selected=$('selectAll').checked?new Set(visible.map(r=>r.id)):new Set();renderSelection();};
$('approve').onclick=()=>commit({type:'approve',ids:[...selected]},`${selected.size}장 승인`);
$('approveAll').onclick=()=>commit({type:'approve',ids:visible.map(r=>r.id)},`표시된 ${visible.length}장 일괄 승인`);
$('reject').onclick=()=>commit({type:'reject',ids:[...selected]},`${selected.size}장 캐릭터 아님으로 확인`);
$('hold').onclick=()=>commit({type:'hold',ids:[...selected]},`${selected.size}장 판단 보류`);
$('resume').onclick=()=>commit({type:'resume',ids:[...selected]},`${selected.size}장 다시 검토`);
$('recompute').onclick=()=>commit({type:'recompute'},'미확인 후보 재계산');
$('applyThreshold').onclick=()=>commit({type:'threshold',value:Number($('threshold').value)},'거리 기준선 변경');
$('undo').onclick=()=>{const label=session.history.at(-1)?.label;session=undo(session);selected.clear();save();render();$('notice').textContent=`되돌림: ${label}`;};
$('restart').onclick=()=>{if(commit({type:'reset'},'실험 초기화')){view=PRIMARY;tab='tentative';$('filter').value='all';$('truth').checked=false;render();}};
for(const id of ['filter','sort','truth'])$(id).onchange=()=>{selected.clear();render();};
$('export').onclick=()=>{const payload={dataset:data.items.map(x=>({id:x.id,path:x.path,sha256:x.sha256})),model:data.model,session,evaluation:evaluation(state(),data),scope:'virtual folders only; no original file moves'};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='aimes-review-session.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
async function keys(){
 const signature=JSON.stringify({model:data.model,files:data.items.map(x=>[x.path,x.sha256])});
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(signature));
 key='character-review-v1-'+[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')+(verify?'-verification':'');
 stableKey='character-review-latest-v1:'+data.sourceRoot+(verify?':verification':'');
 $('datasetSummary').textContent=`에이메스 ${data.items.filter(x=>x.positive).length}장 · 비교 ${data.items.filter(x=>!x.positive).length}장 · 원본을 옮기지 않는 독립 실험`;
}
async function api(path,payload){
 const r=await fetch(path,payload?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{});
 if(!r.ok){let message=`추가 분석 연결 오류 (${r.status})`;try{message=(await r.json()).error??message;}catch{}throw Error(message);}
 return r.json();
}
function lockUI(value){busy=value;$('app').inert=value;for(const id of ['append','restart','export'])$(id).disabled=value||(id==='append'&&verify);$('appendStatus').hidden=false;}
async function finishAppend(saved,job){
 while(job.phase==='running'){$('appendStatus').textContent=job.message??'새 이미지를 분석하고 있습니다…';await new Promise(resolve=>setTimeout(resolve,1000));const updated=await api('/api/append');if(updated.id!==job.id)throw Error('분석 작업이 변경되었습니다. 새로고침해 저장 기록을 확인해주세요.');job=updated;}
 if(job.phase!=='completed')throw Error(job.message??'분석이 완료되지 않았습니다.');
 const response=await fetch('data.json');if(!response.ok)throw Error('새 결과를 불러오지 못했습니다.');
 const next=await response.json(),connected=migrate(saved,next);
 data=next;session=connected.session;await keys();save();selected.clear();
 if(connected.newIds.length){view='new';$('filter').value='all';}
 render();
 try{await api('/api/checkpoint',envelope(data,session));}catch(e){$('storageError').hidden=false;$('storageError').textContent='브라우저에는 저장했지만 파일 백업에 실패했습니다: '+e.message;}
 $('appendStatus').textContent=connected.newIds.length?`새 이미지 ${connected.newIds.length}장을 연결했습니다. 기존 참조·반례·확정 분류를 유지했습니다.`:'새로운 이미지가 없습니다. 기존 검토 기록은 그대로입니다.';
 if(job.result.missingRetained)$('appendStatus').textContent+=` 폴더에서 사라진 기존 ${job.result.missingRetained}장은 기록과 캐시를 유지했습니다.`;
 if(job.result.skipped.length)$('appendStatus').textContent+=` 읽지 못하거나 지원하지 않는 파일 ${job.result.skipped.length}개는 제외했습니다.`;
}
$('append').onclick=async()=>{
 if(busy||verify)return;
 save();const saved=envelope(data,session);lockUI(true);
 try{const job=await api('/api/append',saved);await finishAppend(saved,job);}catch(e){$('appendStatus').textContent='추가 분석을 완료하지 못했습니다: '+e.message;}
 finally{lockUI(false);render();}
};
async function start(){
 const response=await fetch('data.json');if(!response.ok)throw Error(`결과 파일 ${response.status}`);data=await response.json();await keys();
 session={state:initialState(data),history:[]};
 const raw=localStorage.getItem(key);
 if(raw){const loaded=JSON.parse(raw);if(!validateSession(loaded,data)||loaded.history.length>40||loaded.history.some(h=>!validateSession({state:h.state,history:[]},data)))throw Error('저장 기록이 손상되어 덮어쓰지 않았습니다.');session=loaded;$('notice').textContent='저장된 검토 작업을 이어서 불러왔습니다.';}
 else{
  const stable=localStorage.getItem(stableKey);let saved=stable?JSON.parse(stable):null;
  if(!saved&&!verify){try{saved=await api('/api/checkpoint');}catch{}}
  if(saved){session=migrate(saved,data).session;$('notice').textContent='기존 참조·반례·검토 기록을 새 자료에 연결했습니다.';}
 }
 save();$('loading').hidden=true;$('app').hidden=false;$('append').disabled=verify;render();
 if(!verify){let job;try{job=await api('/api/append');}catch{}
  if(job?.phase==='running'){lockUI(true);try{await finishAppend(envelope(data,session),job);}catch(e){$('appendStatus').textContent=e.message;}finally{lockUI(false);render();}}
 }
}
start().catch(e=>{$('loading').textContent='실험을 열지 못했습니다: '+e.message;});
