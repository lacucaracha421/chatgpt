import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {catalogCoverDecoded,catalogScreenTiming} from './catalogPerf';
let now:number,request:ReturnType<typeof vi.fn>;
function fixture(){
  const root=document.createElement('div');document.body.append(root);
  root.getBoundingClientRect=()=>({top:0,bottom:500,left:0,right:500} as DOMRect);
  const covers=Array.from({length:12},(_,i)=>{
    const host=document.createElement('span');host.dataset.catalogCover=String(i);root.append(host);
    host.getBoundingClientRect=()=>({height:200,width:100,top:i<10?100:700,bottom:i<10?300:900,left:0,right:100} as DOMRect);
    return host;
  });return {root,covers};
}
beforeEach(()=>{now=100;vi.spyOn(performance,'now').mockImplementation(()=>now);request=vi.fn();window.LakomicsNative={request,cancel:vi.fn(),perfEnabled:()=>true};});
afterEach(()=>{document.body.innerHTML='';delete window.LakomicsNative;vi.restoreAllMocks();});
it('logs one first/90% decoded summary for the initial visible cohort, excluding preloads',()=>{
  const {root,covers}=fixture(),stop=catalogScreenTiming(root);
  now=110;catalogCoverDecoded(covers[10]);expect(request).not.toHaveBeenCalled();
  now=120;catalogCoverDecoded(covers[0]);catalogCoverDecoded(covers[0]);
  now=300;for(let i=1;i<9;i++)catalogCoverDecoded(covers[i]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request.mock.calls[0][2])).toMatchObject({event:'catalog_screen',visible:10,loaded:9,firstCoverMs:20,visible90Ms:200,status:'ok'});
  catalogCoverDecoded(covers[9]);stop();expect(request).toHaveBeenCalledTimes(1);
});
it('reports incomplete cohorts on screen exit rather than fabricating a 90% time',()=>{
  const {root,covers}=fixture(),stop=catalogScreenTiming(root);
  now=150;catalogCoverDecoded(covers[0]);stop();
  expect(JSON.parse(request.mock.calls[0][2])).toMatchObject({status:'incomplete',firstCoverMs:50,visible90Ms:-1,loaded:1});
});
it('measures already decoded covers on re-entry and stays silent by default',()=>{
  const {root,covers}=fixture();for(const host of covers)host.dataset.catalogDecoded='true';
  catalogScreenTiming(root)();expect(JSON.parse(request.mock.calls[0][2])).toMatchObject({status:'ok',firstCoverMs:0,visible90Ms:0});
  request.mockClear();window.LakomicsNative!.perfEnabled=()=>false;
  const stop=catalogScreenTiming(root);catalogCoverDecoded(covers[0]);stop();expect(request).not.toHaveBeenCalled();
});
