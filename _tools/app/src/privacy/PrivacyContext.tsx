import { createContext, useContext, useMemo, useEffect, useState, useCallback, type ReactNode } from "react";
import type { LibraryGateway } from "../library/types";
import { assetMasked, type ContentRating, type RatedAsset } from "../shared/privacy/contentMask";

type PrivacyContextValue = {
  privacyMode: boolean;
  setPrivacyMode: (privacyMode: boolean) => void;
  nsfwFilter: boolean;
  setNsfwFilter: (enabled: boolean) => void;
  ratings: ReadonlyMap<string, ContentRating | null>;
  requestRating: (id: string) => void;
};
const noop = () => undefined;
const PrivacyContext = createContext<PrivacyContextValue>({privacyMode:false,setPrivacyMode:noop,nsfwFilter:false,setNsfwFilter:noop,ratings:new Map(),requestRating:noop});
type PrivacyProviderProps = {
  privacyMode: boolean; setPrivacyMode: (privacyMode: boolean) => void;
  gateway?: Pick<LibraryGateway,"refreshAssets">; libraryKey?: string; ratingRevision?: number; nsfwFilter?: boolean; setNsfwFilter?: (enabled: boolean) => void; children: ReactNode;
};
export function PrivacyProvider({privacyMode,setPrivacyMode,nsfwFilter=false,setNsfwFilter=noop,ratingRevision=0,gateway,libraryKey:root,children}: PrivacyProviderProps) {
  const [revision, setRevision] = useState(0);
  // A fresh cache on each enable/library change prevents stale safe ratings flashing.
  const batch = useMemo(() => ({ratings:new Map<string,ContentRating|null>(),pending:new Set<string>(),timer:undefined as ReturnType<typeof setTimeout>|undefined,live:true}),[gateway,root,nsfwFilter,ratingRevision]);
  useEffect(() => {batch.live=true;return () => {batch.live=false;clearTimeout(batch.timer);};},[batch]);
  const requestRating = useCallback((id:string) => {
    if (!nsfwFilter || privacyMode || batch.ratings.has(id) || batch.pending.has(id)) return;
    batch.pending.add(id);
    if (batch.timer !== undefined) return;
    batch.timer=setTimeout(() => {
      batch.timer=undefined;
      const ids=[...batch.pending]; batch.pending.clear();
      // All visible preview cells share bounded existing summary reads, never per-tile IPC.
      for(let offset=0;offset<ids.length;offset+=500) {
        const chunk=ids.slice(offset,offset+500);
        for(const id of chunk) batch.ratings.set(id,null);
        const query={classificationId:null,albumId:null,collectionId:null,directOnly:false,unclassifiedOnly:false,mediaKind:null,aspectRatio:null,sort:'newest' as const,randomPivot:null,after:null,limit:500};
        void (gateway?.refreshAssets?.(query,chunk) ?? Promise.resolve([])).then(items => {
          if(!batch.live)return;
          for(const item of items) batch.ratings.set(item.id,item.media?.kind==='video'?null:item.contentRating??null);
          setRevision(value=>value+1);
        },()=>undefined);
      }
    },0);
  },[batch,gateway,nsfwFilter,privacyMode]);
  const value=useMemo(()=>({privacyMode,setPrivacyMode,nsfwFilter,setNsfwFilter,ratings:batch.ratings,requestRating}),[privacyMode,setPrivacyMode,nsfwFilter,setNsfwFilter,batch,requestRating,revision]);
  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}
export function usePrivacy(): PrivacyContextValue { return useContext(PrivacyContext); }
export function useAssetMask(asset?: RatedAsset | string | null, privacy=false): boolean {
  const context=usePrivacy();
  const id=typeof asset==='string'?asset:undefined;
  useEffect(()=>{if(id)context.requestRating(id);},[id,context.requestRating]);
  return assetMasked(privacy||context.privacyMode,context.nsfwFilter,id?{contentRating:context.ratings.get(id)}:typeof asset==='string'?null:asset);
}
export function useAssetMasks() {
  const {privacyMode,nsfwFilter}=usePrivacy();
  return (asset?:RatedAsset|null,privacy=false)=>assetMasked(privacy||privacyMode,nsfwFilter,asset);
}
