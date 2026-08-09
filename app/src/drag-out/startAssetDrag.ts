import { invoke } from "@tauri-apps/api/core";

export type StartAssetDrag = (assetIds: string[]) => Promise<void>;

export const startAssetDrag: StartAssetDrag = (assetIds) =>
  invoke("start_asset_drag", { assetIds });
