import { invoke } from "@tauri-apps/api/core";
import { nativeMediaUrl } from "../assets/mediaUrl";

export type AvLinkStatus = "queued" | "fetching" | "found" | "not_found" | "error" | "dismissed" | "applied";
export interface AvLinkInboxItem {
  id: string; requestId: string; productCode: string; normalizedCode: string | null;
  sourceUrl: string | null; receivedAt: string; status: AvLinkStatus; attempts: number;
  lastError: string | null; fetchedAt: string | null; collectionId: string | null; collectionName: string | null;
}
export interface AvLinkMovie {
  normalized_id: string; title: string; date: string | null; makers: string[]; labels: string[];
  series: string[]; actresses: { name: string; image_url: string | null }[]; directors: string[];
  genres: string[]; cover_image_url: string; thumbnail_image_url: string | null; volume: unknown;
}
export interface AvLinkFields {
  title_ja?: string | null; release_date?: string | null; maker?: string | null;
  label?: string | null; series?: string | null; genres?: string[] | null;
}
export interface AvLinkCoverSet { frontId: string | null; spineId: string | null; backId: string | null; revision: string }
export interface AvLinkPersonMatch {
  name_ja: string; name_ko: string | null; wikidata_id: string | null; fanza_actress_id: string | null;
  personId: string | null; displayName: string | null; matchBy: string | null; alreadyLinked: boolean;
}
export interface AvLinkCurrentCollection {
  collectionId: string; name: string; productCode: string | null; fields: AvLinkFields; covers: AvLinkCoverSet;
  people: { id: string; displayName: string; role: "performer" | "director"; order: number; creditName: string | null }[];
}
/** Split coordinates are integer pixels in the original jacket: back | spine | front.
 * For a portrait candidate x1=x2=0, so only front has pixels. useSpine is false
 * outside the 1–12% estimate; the UI may explicitly choose a nonempty spine.
 */
export interface AvLinkCandidate {
  inbox: AvLinkInboxItem; metadata: AvLinkMovie; fields: AvLinkFields;
  jacketUrl: string; jacketWidth: number; jacketHeight: number;
  defaultSplit: { x1: number; x2: number; isWrap: boolean; useSpine: boolean };
  current: AvLinkCurrentCollection | null; performers: AvLinkPersonMatch[]; directors: AvLinkPersonMatch[];
}
export type AvLinkPersonChoice =
  | { name_ja: string; action: "link"; personId: string }
  | { name_ja: string; action: "new"; displayName: string };
export type AvLinkSurfaceChoice = "candidate" | "keep" | "clear";
/** Omitted/null fields are kept; empty strings clear text, [] clears genres.
 * Existing destinations require current.covers.revision. Existing credits remain;
 * selected new credits are appended in the given order.
 */
export type AvLinkApplyRequest = (
  | { collectionId: string; expectedRevision: string; newCollectionName?: never }
  | { newCollectionName: string; collectionId?: never; expectedRevision?: never }
) & {
  split: { x1: number; x2: number };
  surfaces: { front: AvLinkSurfaceChoice; spine: AvLinkSurfaceChoice; back: AvLinkSurfaceChoice };
  fields: AvLinkFields; performers: AvLinkPersonChoice[]; directors: AvLinkPersonChoice[];
};
export interface AvLinkApplyResult { collectionId: string; covers: AvLinkCoverSet }

export const avLinkClient = {
  listInbox: () => invoke<AvLinkInboxItem[]>("list_av_link_inbox"),
  pendingCount: () => invoke<number>("av_link_pending_count"),
  /** collectionId previews an explicitly chosen destination, including its revision. */
  getCandidate: async (inboxId: string, collectionId?: string): Promise<AvLinkCandidate> => {
    const result = await invoke<AvLinkCandidate>("get_av_link_candidate", { inboxId, collectionId });
    return { ...result, jacketUrl: nativeMediaUrl(result.jacketUrl) };
  },
  retry: (inboxId: string) => invoke<void>("retry_av_link", { inboxId }),
  fixCode: (inboxId: string, code: string) => invoke<void>("fix_av_link_code", { inboxId, code }),
  dismiss: (inboxId: string) => invoke<void>("dismiss_av_link", { inboxId }),
  apply: (inboxId: string, request: AvLinkApplyRequest) => invoke<AvLinkApplyResult>("apply_av_link", { inboxId, request }),
};
