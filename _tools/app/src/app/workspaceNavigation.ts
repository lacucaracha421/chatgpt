import type { AssetView } from "../library/types";

export function backNavigationTab(view: AssetView): string {
  switch (view.kind) {
    // The 작가 hub is an asset quick view: back from it returns to the folder it was opened from.
    case "classification": case "albums": case "album":
    case "artists": case "creator": return "assets";
    case "collection": case "collections": return "collections";
    default: return view.kind;
  }
}

export function initialWorkspaceView(): AssetView {
  if (!__LAKOMICS_PREVIEW__) return { kind: "home" };
  switch (new URLSearchParams(window.location.search).get("view")) {
    case "assets": return { kind: "classification", classificationId: null };
    case "assets-folder": return { kind: "classification", classificationId: "class-reverse" };
    case "assets-parent": return { kind: "classification", classificationId: "class-game" };
    case "artists": return { kind: "artists" };
    case "artist": return { kind: "creator", creatorKey: "artist-1" };
    case "albums": return { kind: "albums" };
    case "collections": return { kind: "collections", typeFilter: "game", showcase: false };
    case "collection-detail": return { kind: "collection", collectionId: new URLSearchParams(window.location.search).get("id") ?? "game-1" };
    case "calendar": return { kind: "collections", typeFilter: "game", showcase: false, releaseCalendar: true };
    case "manga":
    case "manga-catalog": return { kind: "manga" };
    case "notes": return { kind: "notes" };
    case "settings": return { kind: "settings", section: "frequent" };
    default: return { kind: "home" };
  }
}

