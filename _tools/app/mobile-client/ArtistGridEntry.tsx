import {useEffect, useRef, useState} from 'react';
import {api, errorText} from './transport';
import {normalizePage} from './model';
import {readyFirstScreen} from './firstScreen';
import {readScopedToc, withScopedToc, type ScopedAssetPage} from './scopedAssetToc';
import {preloadImages} from '../src/shared/motion/viewportImages';
import {mediaMasked} from './assetMask';
import {privacyMode} from './privacyMode';
import type {LibraryArtist} from './artistsModel';
import type {PageWire} from './types';

export type ArtistPage = ScopedAssetPage & {scope:string};
// The navigation callback takes an artist only. This short-lived, object-keyed handoff lets
// its detail mount with the prepared page without changing the Library/App contract.
const entries = new WeakMap<LibraryArtist, {page:ArtistPage; at:number}>();
export function preparedArtistPage(artist:LibraryArtist) {
  const entry=entries.get(artist);
  return entry && Date.now()-entry.at<60_000 ? entry.page : undefined;
}

export async function prepareArtistPage(page:ArtistPage, signal:AbortSignal) {
  const [items]=await Promise.all([
    readyFirstScreen(page.items,signal),
    preloadImages(page.items.slice(0,24).flatMap(asset=>asset.preview&&!mediaMasked(asset)?[asset.preview]:[])),
  ]);
  const prepared=new Map(items.map(asset=>[asset.id,asset]));
  return {...page,items,assetRanges:page.assetRanges?{...page.assetRanges,ranges:page.assetRanges.ranges.map(range=>({...range,items:range.items.map(asset=>prepared.get(asset.id)??asset)}))}:undefined};
}

/** Keep the painted list until the first real page and its bounded thumbnail batch are ready. */
export function useArtistEntry(paused:boolean, onOpen:(artist:LibraryArtist)=>void) {
  const request=useRef<AbortController|null>(null);
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const cancel=()=>{request.current?.abort();request.current=null;setPending(false);};
  useEffect(()=>{if(paused)cancel();return cancel;},[paused]);
  const open=async(artist:LibraryArtist)=>{
    if(paused||request.current)return;
    if(privacyMode()){onOpen(artist);return;}
    const controller=new AbortController();request.current=controller;setPending(true);setError('');
    const params=new URLSearchParams({artist:artist.id,sort:'newest',limit:'100'});
    const toc=new URLSearchParams(params);toc.delete('limit');toc.set('toc','1');toc.set('utcOffsetMinutes',String(-new Date().getTimezoneOffset()));
    try {
      const page=await withScopedToc(api<PageWire&{listGeneration?:string}>(`/v1/library/assets?${params}`,controller.signal)
        .then(raw=>({...normalizePage(raw),list_generation:raw.listGeneration,scope:`${artist.id}:newest:all`})),
        readScopedToc(`/v1/library/assets?${toc}`,controller.signal),'newest');
      const ready=privacyMode()?page:await prepareArtistPage(page,controller.signal);
      if(controller.signal.aborted)return;
      const selected={...artist};
      entries.set(selected,{page:ready,at:Date.now()});
      onOpen(selected);
    } catch(reason) {if(!controller.signal.aborted)setError(errorText(reason));}
    finally {if(request.current===controller){request.current=null;setPending(false);}}
  };
  return {open,pending,error,cancel};
}
