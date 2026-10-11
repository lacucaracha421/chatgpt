import { invoke } from "@tauri-apps/api/core";

export type FolderGroupPreview = {
  folderId: string; folderName: string;
  seriesId: string | null; seriesName: string | null;
  groupName: string; groupId: string | null;
  characterAssetCount: number; unassignedAssetCount: number; otherAssetCount: number;
  parentName: string | null; refusal: string | null; token: string;
};
export type FolderGroupResult = { seriesId: string; groupId: string };

export const folderGroupApi = {
  preview: (folderId: string): Promise<FolderGroupPreview> => invoke("character_folder_group_preview", { folderId }),
  apply: (folderId: string, token: string): Promise<FolderGroupResult> => invoke("tidy_character_folder_into_group", { folderId, token }),
  folderExclusions: (): Promise<string[]> => invoke("character_folder_exclusions"),
};
