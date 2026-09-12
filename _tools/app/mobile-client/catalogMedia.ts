import {native} from './transport';
import type {Ticket} from './types';

export type CatalogImageKind = 'cover'|'page';
export type CatalogImageRequest = {
  workId:string;
  revision:string;
  kind:CatalogImageKind;
  index:number;
  url:string;
};

let active=0;
const queue:(()=>void)[]=[];
const MAX_ACTIVE=4;

export function catalogImageTicket(request:CatalogImageRequest,signal:AbortSignal):Promise<Ticket>{
  return new Promise((resolve,reject)=>{
    let started=false,settled=false;
    const finish=()=>{
      if(settled)return;settled=true;signal.removeEventListener('abort',cancel);
      if(started){active--;while(active<MAX_ACTIVE&&queue.length)queue.shift()!();}
    };
    const cancel=()=>{
      const index=queue.indexOf(start);if(index>=0)queue.splice(index,1);
      finish();reject(new DOMException('Cancelled','AbortError'));
    };
    const start=()=>{
      if(signal.aborted){cancel();return;}started=true;active++;
      void native<Ticket>('catalogImage',request,signal).then(value=>{finish();resolve(value);},error=>{finish();reject(error);});
    };
    signal.addEventListener('abort',cancel,{once:true});
    if(active<MAX_ACTIVE)start();else queue.push(start);
  });
}
