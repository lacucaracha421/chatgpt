import { libraryGateway } from "../library/client";
import { invoke } from "@tauri-apps/api/core";
import type { AvCommonsPreview, AvGateway, LocalArtworkPreview, PortraitRect } from "./avTypes";

export const avGateway: AvGateway = {
  getStashdbCredentialStatus: () => invoke("get_av_stashdb_status"),
  getStashdbProfileDetail: personId => invoke("get_av_stashdb_profile_detail", { personId }),
  previewStashdbImage: url => invoke("preview_av_stashdb_image", { url }),
  subscribeProfilesChanged: handler => libraryGateway.subscribeCollectionsChanged?.(handler) ?? (() => {}),
  getPerformerProfile: personId => invoke("get_av_performer_profile", { personId }),
  refreshPerformerProfile: (personId, force) => invoke("refresh_av_performer_profile", { personId, force }),
  searchPerformerProfile: personId => invoke("search_av_performer_profile", { personId }),
  choosePerformerProfile: (personId, stashdbId) => invoke("choose_av_performer_profile", { personId, stashdbId }),
  dismissPerformerProfile: personId => invoke("dismiss_av_performer_profile", { personId }),
  clearPerformerProfile: personId => invoke("clear_av_performer_profile", { personId }),
  previewStashdbPortrait: (personId, imageId) => invoke("preview_av_stashdb_portrait", { personId, imageId }),
  useStashdbPortrait: personId => invoke("use_av_stashdb_portrait", { personId }),
  getDetails: collectionId => invoke("get_av_details", { collectionId }),
  saveDetails: (collectionId, input) => invoke("save_av_details", { collectionId, input }),
  searchPeople: query => invoke("search_av_people", { query }),
  getCoverSet: collectionId => invoke("get_av_cover_set", { collectionId }),
  applyArtwork: (collectionId, input) => invoke("apply_av_artwork", { collectionId, input }),
  previewArtwork: async (path, surface) => {
    const wire = await invoke<Omit<LocalArtworkPreview, "thumbnailDataUrl"> & { thumbnailBytes: number[] }>("preview_av_artwork", { path, surface });
    let binary = "";
    for (let offset = 0; offset < wire.thumbnailBytes.length; offset += 8192) binary += String.fromCharCode(...wire.thumbnailBytes.slice(offset, offset + 8192));
    const { thumbnailBytes: _, ...preview } = wire;
    return { ...preview, thumbnailDataUrl: `data:image/png;base64,${btoa(binary)}` };
  },
  getRelated: collectionId => invoke("get_av_related", { collectionId }),
  refreshPersonProfileState: personId => invoke("get_av_person_profile_state", {personId, refresh: true}),
  getPersonProfileState: personId => invoke("get_av_person_profile_state", {personId}),
  setPersonProfileFields: (personId, changes, expected) => invoke("set_av_person_profile_fields", {personId, changes, expected}),
  resolvePersonProfileConflict: (personId, operationId, overwrite) => invoke("resolve_av_person_profile_conflict", {personId, operationId, overwrite}),
  getPerformer: personId => invoke("get_av_performer", { personId }),
  savePersonMemo: (personId, memo) => invoke("save_av_person_memo", { personId, memo }),
  listPortraitSources: personId => invoke("list_av_portrait_sources", { personId }),
  setPortraitCrop: (personId, artworkId, rect: PortraitRect) => invoke("set_av_portrait_crop", { personId, artworkId, rect }),
  previewCommonsPortrait: personId => invoke<AvCommonsPreview | null>("preview_av_commons_portrait", { personId }),
  useCommonsPortrait: personId => invoke("use_av_commons_portrait", { personId }),
  clearPortrait: personId => invoke("clear_av_portrait", { personId }),
};
export function avError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "정보를 저장하지 못했습니다. 다시 시도해 주세요.";
}
