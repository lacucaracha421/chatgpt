import { invoke } from "@tauri-apps/api/core";
import type { AvGateway, LocalArtworkPreview } from "./avTypes";

export const avGateway: AvGateway = {
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
};
export function avError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "정보를 저장하지 못했습니다. 다시 시도해 주세요.";
}
