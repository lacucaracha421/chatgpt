import {useEffect} from 'react';
import type {LibraryGateway} from '../library/types';
import {loadUiPreferences} from '../preferences/uiPreferences';
export function useMobilePublications(gateway:LibraryGateway,libraryRoot:string) {
  useEffect(()=>{
    if(!gateway.runDueMobilePublications)return;
    let stopped=false,running=false;
    const run=async()=>{if(stopped||running)return;running=true;try{await gateway.runDueMobilePublications!(loadUiPreferences().classificationOrderIds);}catch{/* Native keeps pending generations; retry on the next tick. */}finally{running=false;}};
    void run();const timer=setInterval(()=>void run(),10_000);window.addEventListener('online',run);
    return()=>{stopped=true;clearInterval(timer);window.removeEventListener('online',run);};
  },[gateway,libraryRoot]);
}
