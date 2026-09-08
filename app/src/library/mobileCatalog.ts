import {invoke} from '@tauri-apps/api/core';
export type MobileCatalogPublishResult = {publicationRevision:string;publishedAt:string;works:number;bytes:number};
/** Explicit user action; independent of automatic library/capture sync. */
export function publishMobileCatalog():Promise<MobileCatalogPublishResult> {
  return invoke<MobileCatalogPublishResult>('push_cloud_catalog');
}
