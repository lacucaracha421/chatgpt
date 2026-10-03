import { invoke } from "@tauri-apps/api/core";

export type StartAssetDrag = (assetIds: string[], masking?: {privacyMode:boolean;nsfwFilter:boolean}) => Promise<void>;

export const startAssetDrag: StartAssetDrag = (assetIds, masking) =>
  invoke("start_asset_drag", { assetIds, ...(masking ?? {}) });
