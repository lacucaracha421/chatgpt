import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CollectionSummary } from "../../library/types";
import { useLibrary } from "../../library/LibraryContext";
import { workArtworkThumbnailUrl } from "../../assets/mediaUrl";
import { MangaSpineFace } from "../work/MangaBook";
import { stripPosition } from "../work/coverStrip";
import { StableImage } from "../../shared/ui/StableImage";
import { useSpineArtworkRevision } from "../launchBoxSpines";
import { avGateway } from "../avClient";
import { CASE_PLASTIC, CaseSpine, spineInsertClass, workCasePlatform, type CaseData } from "./CollectionCase";
import { readShelfInfo, rememberedShelfInfo, sameShelfInfo, shelfInfoKey, type ShelfInfo } from "./shelfCaseInfo";
import "./LightCase.css";

export function CollectionShelfCase({ collection, front, privacy, active, selected }: { collection: CollectionSummary; front: string | null; privacy: boolean; active: boolean; selected: boolean }) {
  const { gateway, library } = useLibrary();
  const root = library?.root ?? "";
  const spineRevision = useSpineArtworkRevision(gateway, root, collection.id);
  const key = shelfInfoKey(root, collection.id);
  const [shelf, setShelf] = useState<{ key: string; info: ShelfInfo } | null>(null);
  const info = shelf?.key === key ? shelf.info : rememberedShelfInfo(key);
  const drawn = useRef(info); drawn.current = info;
  // A game reads its owned device even off the shelf; a film's spine is read only for the shelf.
  const wanted = collection.type === "game" || (collection.type === "movie" && active && !privacy);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    // An unchanged re-read leaves the case as drawn, so a remounted shelf is not drawn a second time.
    readShelfInfo(gateway, root, collection.id).then(next => { if (current && !sameShelfInfo(drawn.current, next)) setShelf({ key, info: next }); }, () => undefined);
    return () => { current = false; };
  }, [wanted, key, root, collection.id, collection.updatedAt, gateway, spineRevision]);
  const [avArt, setAvArt] = useState<{ id: string; front: string | null; spine: string | null } | null>(null);
  useEffect(() => {
    if (collection.type !== "av" || !active || privacy) return;
    let current = true;
    void avGateway.getCoverSet(collection.id).then(covers => {
      const url = (id: string | null) => id ? `${workArtworkThumbnailUrl(id)}?v=${encodeURIComponent(covers.revision)}` : null;
      if (current) setAvArt({ id: collection.id, front: url(covers.frontId), spine: url(covers.spineId) });
    }, () => undefined /* Existing front artwork and the platform template remain available. */);
    return () => { current = false; };
  }, [active, privacy, collection.id, collection.type, collection.updatedAt]);
  const av = avArt?.id === collection.id ? avArt : null;
  const spine = collection.type === "manga" ? null : collection.type === "av" ? av?.spine ?? null : info?.spineArtworkId ? workArtworkThumbnailUrl(info.spineArtworkId) : null;
  const data: CaseData = { title: collection.name, author: collection.author, publisher: collection.publisher, platform: workCasePlatform(collection.type, collection.platforms, collection.type === "game" ? info?.ownedPlatform : null), front: av?.front ?? front, spine, privacy };
  return <LightCase data={data} selected={selected} />;
}

/** Client-independent shelf object; only its data adapter reads local artwork. */
/** Selection is the lift alone (PC and tablet): no outline or check; the owning button shows keyboard focus. */
export function LightCase({ data, selected }: { data: CaseData; selected: boolean }) {
  return data.platform === "book" ? <ShelfBookCase key={data.privacy ? "private" : "public"} data={data} selected={selected} /> : <ShelfMaterialCase data={data} selected={selected} />;
}

function LightCaseFrame({ data, selected, ratio, children }: { data: CaseData; selected: boolean; ratio: number; children: ReactNode }) {
  return <span className={`collection-light-case${data.platform === "book" ? " collection-light-case--book" : ""}`} data-front={selected || undefined} style={{ "--case-ratio": ratio, "--plastic": CASE_PLASTIC[data.platform], "--gloss": selected ? "50%" : "84%" } as CSSProperties}>
    <span className="cs-box">{children}<span className="cs-top" /></span>
  </span>;
}

function ShelfMaterialCase({ data, selected }: { data: CaseData; selected: boolean }) {
  const [ratio, setRatio] = useState(.71);
  return <LightCaseFrame data={data} selected={selected} ratio={ratio}>
    <span className="cs-front"><span className="ins">
      {!data.privacy && data.front ? <StableImage src={data.front} alt={data.title} draggable={false} onLoad={event => {
        const image = event.currentTarget;
        if (image.naturalWidth && image.naturalHeight) setRatio(Math.max(.4, Math.min(1.4, image.naturalWidth / image.naturalHeight)));
      }} /> : <span className="case-mask" />}
    </span></span>
    <span className="cs-spine"><span className={spineInsertClass(data)}><CaseSpine decorative data={data} /></span></span>
  </LightCaseFrame>;
}

/** Keep both decoded elements until their replacements are ready; no per-book effects or measurement. */
function ShelfBookCase({ data, selected }: { data: CaseData; selected: boolean }) {
  const [slots, setSlots] = useState<[string | null, string | null]>([data.front, null]);
  const [painted, setPainted] = useState<0 | 1 | null>(null);
  const wanted = useRef(data.front); wanted.current = data.front;
  const versions = useRef([0, 0]);
  const loaded = useRef<({ src: string; faces: Set<string>; ratio: number } | null)[]>([null, null]);
  const ratio = painted !== null ? loaded.current[painted]?.ratio ?? .71 : .71;
  if (data.front && (painted === null || slots[painted] !== data.front)) {
    const next = painted === 0 ? 1 : 0;
    if (slots[next] === data.front && loaded.current[next]?.src === data.front && loaded.current[next]?.faces.size === 2) setPainted(next);
    else if (slots[next] !== data.front) {
      versions.current[next] += 1;
      loaded.current[next] = null;
      setSlots(current => next === 0 ? [data.front, current[1]] : [current[0], data.front]);
    }
  }
  function cover(face: "front" | "strip") {
    return !data.front ? null : slots.map((src, index) => {
      const version = versions.current[index];
      return src && <img key={index} src={src} alt={face === "front" ? data.title : ""} draggable={false}
      aria-hidden={face === "strip" || painted !== index || undefined}
      style={{ ...(face === "strip" ? { objectPosition: `${stripPosition(data.coverFocus ?? null, ratio, .08)}% 30%` } : {}),
        ...(painted === index ? {} : { position: "absolute", visibility: "hidden", pointerEvents: "none" }) }}
      onLoad={async event => {
        const image = event.currentTarget;
        try { await image.decode?.(); } catch { return; }
        if (!image.isConnected || versions.current[index] !== version || wanted.current !== src || image.getAttribute("src") !== src) return;
        if (loaded.current[index]?.src !== src) loaded.current[index] = { src, faces: new Set(), ratio };
        const ready = loaded.current[index]!;
        ready.faces.add(face);
        if (face === "front" && image.naturalWidth && image.naturalHeight) ready.ratio = image.naturalWidth / image.naturalHeight;
        if (ready.faces.size === 2) setPainted(index as 0 | 1);
      }} />;
    });
  }
  return <LightCaseFrame data={data} selected={selected} ratio={Math.max(.4, Math.min(1.4, ratio))}>
    <span className="cs-front"><span className="ins">{data.privacy || !data.front ? <span className="case-mask" /> : cover("front")}</span></span>
    <span className="cs-spine"><span className="ins">{data.privacy ? <span className="case-mask" /> : <MangaSpineFace title={data.title} author={data.author} volumeNumber={data.volumeNumber} illustration={cover("strip")} />}</span></span>
  </LightCaseFrame>;
}
