// Offline diagnostic; never changes the browser session or source images.
import fs from 'node:fs';
import {initialState,applyAction,evaluation,predict} from './public/review-engine.mjs';
const data=JSON.parse(fs.readFileSync(new URL('./public/data.json',import.meta.url),'utf8'));
const initial=initialState(data);
const fp=initial.records.filter(r=>r.classId==='aimes'&&r.status==='tentative'&&!data.items[r.id].positive)
 .sort((a,b)=>predict(initial,data,a.id).candidates[0].positive-predict(initial,data,b.id).candidates[0].positive);
const runs=fp.map(r=>{
 const state=applyAction(initial,data,{type:'reject',ids:[r.id]});
 const {ids,...scores}=evaluation(state,data);
 return {rejectedId:r.id,name:data.items[r.id].name,...scores};
});
const {ids,...baseline}=evaluation(initial,data);
const report={baseline,oneRejectionRuns:runs,note:'Exploratory single-rejection diagnostics on previously inspected data. Each run starts fresh; taught image and duplicates excluded on both sides. No best run automatically selected or applied to user session.'};
fs.writeFileSync(new URL('./review-diagnostic.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
