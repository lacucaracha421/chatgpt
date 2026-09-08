import {Channel, invoke} from '@tauri-apps/api/core';
export type MobileCatalogPublishResult = {publicationRevision:string;publishedAt:string;works:number;bytes:number};
/** Explicit user action; independent of automatic library/capture sync. */
export function publishMobileCatalog(onProgress?: (progress: import("./publicationJobs").PublishProgress) => void):Promise<MobileCatalogPublishResult> {
  const channel = new Channel<import("./publicationJobs").PublishProgress>();
  channel.onmessage = (value) => onProgress?.(value);
  return invoke<MobileCatalogPublishResult>('push_cloud_catalog', { onProgress: channel });
}
