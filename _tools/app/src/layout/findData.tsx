import { useEffect, useMemo, useState } from "react";
import { thumbnailUrl } from "../assets/mediaUrl";
import type { ArtistSummary } from "../artists/types";
import { useOptionalLibrary } from "../library/LibraryContext";
import type { AssetView, CollectionSummary } from "../library/types";
import { notesStore, type Note } from "../notes/store";
import { AREA_ICONS } from "../shared/ui/areaIcons";
import type { NavigationEntry } from "./navigationEntries";

import {FIND_WORK_TYPE_LABEL} from "../shared/findEntries";
/** Only project titles; never copy note bodies, fields, labels or checklist content into the index. */
export function noteTitleEntries(notes: Pick<Note, "id" | "title" | "type" | "deleted">[], onNavigate: (view: AssetView) => void): NavigationEntry[] {
  return notes.filter(note => !note.deleted && note.type !== "ledger-month").map(note => ({
    id: `note-${note.id}`, group: "note", label: note.title.trim() || "제목 없는 메모", icon: <AREA_ICONS.notes />,
    run: () => onNavigate({ kind: "notes", noteId: note.id }),
  }));
}
export function workEntries(works: CollectionSummary[], onNavigate: (view: AssetView) => void): NavigationEntry[] {
  return works.map(work => ({
    id: `work-${work.id}`, group: "work", label: work.name, keywords: work.originalTitle ? [work.originalTitle] : [],
    context: FIND_WORK_TYPE_LABEL[work.type], icon: <AREA_ICONS.collections />, thumbnail: work.coverAssetId ? thumbnailUrl(work.coverAssetId) : undefined,
    run: () => onNavigate({ kind: "collection", collectionId: work.id }),
  }));
}
export function artistEntries(artists: ArtistSummary[], onNavigate: (view: AssetView) => void): NavigationEntry[] {
  return artists.filter(artist => !artist.hidden).map(artist => ({
    id: `artist-${artist.id}`, group: "artist", label: artist.label,
    keywords: [artist.displayName ?? "", artist.sourceName ?? "", ...artist.keys],
    context: `에셋 ${artist.assetCount.toLocaleString("ko-KR")}장`, icon: <AREA_ICONS.artists />, avatar: true,
    thumbnail: artist.coverAssetIds[0] ? thumbnailUrl(artist.coverAssetIds[0]) : undefined,
    run: () => onNavigate({ kind: "creator", creatorKey: artist.id }),
  }));
}

/** Local PC reads once per open session. No query-dependent calls and no Notes sync/unlock. */
export function useFindData(open: boolean, works: CollectionSummary[], onNavigate: (view: AssetView) => void) {
  const library = useOptionalLibrary();
  const gateway = library?.gateway.artists;
  const root = library?.library?.root;
  const [artists, setArtists] = useState<{ root: string; items: ArtistSummary[] } | null>(null);
  const [notes, setNotes] = useState<{ root: string; items: Pick<Note, "id" | "title" | "type" | "deleted">[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !root) return;
    let active = true;
    setLoading(true);
    setError(null);
    const store = notesStore(root);
    const project = () => {
      if (!active) return;
      const state = store.snapshot();
      setNotes({ root, items: (state.unlocked ? state.notes : []).map(({ id, title, type, deleted }) => ({ id, title, type, deleted })) });
    };
    const unsubscribe = store.subscribe(project);
    project();
    const loadArtists = async () => {
      if (!gateway) return;
      const all: ArtistSummary[] = [];
      let offset = 0;
      while (active) {
        const page = await gateway.list({ bucket: "all", sort: "name", offset, limit: 500 });
        all.push(...page.artists);
        offset += page.artists.length;
        if (!page.artists.length || offset >= page.total) break;
      }
      if (active) setArtists({ root, items: all });
    };
    void Promise.allSettled([loadArtists(), store.load()]).then(results => {
      if (!active) return;
      project();
      setLoading(false);
      if (results.some(result => result.status === "rejected") || store.snapshot().error) setError("일부 이름을 불러오지 못했습니다. 찾기를 다시 열어 주세요.");
    });
    return () => { active = false; unsubscribe(); };
    // Navigation is resolved by the current App callback; typing must never restart these reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, gateway, root]);
  return {
    entries: useMemo(() => [...workEntries(works, onNavigate), ...artistEntries(artists && artists.root === root ? artists.items : [], onNavigate),
      ...noteTitleEntries(notes && notes.root === root ? notes.items : [], onNavigate)], [works, artists, notes, root, onNavigate]),
    loading, error, recentKey: root ?? "workspace",
  };
}
