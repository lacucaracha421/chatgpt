import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CollectionSummary } from "../../library/types";
import { useLibrary } from "../../library/LibraryContext";
import { workArtworkThumbnailUrl } from "../../assets/mediaUrl";
import { MangaSpineFace } from "../work/MangaBook";
import { stripPosition } from "../work/coverStrip";
import { useShelfFaces, type ShelfPending } from "./useShelfFaces";
import { useSpineArtworkRevision } from "../launchBoxSpines";
import { avGateway } from "../avClient";
import { CASE_PLASTIC, CaseSpine, spineInsertClass, workCasePlatform, type CaseData } from "./CollectionCase";
import { readShelfInfo, rememberedShelfInfo, sameShelfInfo, shelfInfoKey, type ShelfInfo } from "./shelfCaseInfo";
import { beginNativePhase } from "../../shared/nativePerf";
import { collectionCoverSourceRef } from "../collectionPerf";
import "./LightCase.css";

type AvShelfArt = { front: string | null; spine: string | null };
// Like shelfCaseInfo's memory, keep the artwork choice available on a remount;
// a warm image must not wait for another metadata IPC before it can be shown.
const rememberedAvArt = new Map<string, AvShelfArt>();

export function CollectionShelfCase({ collection, front, privacy, active, selected }: { collection: CollectionSummary; front: string | null; privacy: boolean; active: boolean; selected: boolean }) {
  const { gateway, library } = useLibrary();
  const root = library?.root ?? "";
  const spineRevision = useSpineArtworkRevision(gateway, root, collection.id);
  const key = shelfInfoKey(root, collection.id);
  const [shelf, setShelf] = useState<{ key: string; info: ShelfInfo } | null>(null);
  const [shelfSettled, setShelfSettled] = useState<string | null>(null);
  const info = shelf?.key === key ? shelf.info : rememberedShelfInfo(key);
  const drawn = useRef(info); drawn.current = info;
  // A game reads its owned device even off the shelf; a film's spine is read only for the shelf.
  const wanted = collection.type === "game" || (collection.type === "movie" && active && !privacy);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    // An unchanged re-read leaves the case as drawn, so a remounted shelf is not drawn a second time.
    readShelfInfo(gateway, root, collection.id).then(next => {
      if (!current) return;
      if (!sameShelfInfo(drawn.current, next)) setShelf({ key, info: next });
      setShelfSettled(key);
    }, () => { if (current) setShelfSettled(key); });
    return () => { current = false; };
  }, [wanted, key, root, collection.id, collection.updatedAt, gateway, spineRevision]);
  const avKey = JSON.stringify([root, collection.id, collection.updatedAt]);
  const [avArt, setAvArt] = useState<{ key: string; info: AvShelfArt } | null>(null);
  const [avSettled, setAvSettled] = useState<string | null>(null);
  useEffect(() => {
    if (collection.type !== "av" || !active || privacy) return;
    let current = true;
    const phase = beginNativePhase("collections.ipc.get_av_cover_set");
    void avGateway.getCoverSet(collection.id).then(covers => {
      phase?.mark("arrived");
      const url = (id: string | null) => id ? `${workArtworkThumbnailUrl(id)}?v=${encodeURIComponent(covers.revision)}` : null;
      if (current) {
        const info = { front: url(covers.frontId), spine: url(covers.spineId) };
        rememberedAvArt.delete(avKey); rememberedAvArt.set(avKey, info);
        if (rememberedAvArt.size > 2048) rememberedAvArt.delete(rememberedAvArt.keys().next().value!);
        setAvArt({ key: avKey, info }); setAvSettled(avKey);
      }
    }, () => { phase?.mark("failed"); if (current) setAvSettled(avKey); } /* Existing front artwork and the platform template remain available. */).finally(() => phase?.cancel());
    return () => { current = false; };
  }, [active, privacy, collection.id, collection.type, avKey]);
  const av = avArt?.key === avKey ? avArt.info : rememberedAvArt.get(avKey);
  const spine = collection.type === "manga" ? null : collection.type === "av" ? av?.spine ?? null : info?.spineArtworkId ? workArtworkThumbnailUrl(info.spineArtworkId) : null;
  const data: CaseData = { title: collection.name, author: collection.author, publisher: collection.publisher, platform: workCasePlatform(collection.type, collection.platforms, collection.type === "game" ? info?.ownedPlatform : null), front: av?.front ?? front, spine, privacy };
  const spinePending = !privacy && (collection.type === "av" ? active && !av && avSettled !== avKey : wanted && !info && shelfSettled !== key);
  return <LightCase data={data} selected={selected} spinePending={spinePending} />;
}

/** Client-independent shelf object; only its data adapter reads local artwork. */
/** Selection is the lift alone (PC and tablet): no outline or check; the owning button shows keyboard focus. */
export function LightCase({ data, selected, ...pending }: { data: CaseData; selected: boolean } & ShelfPending) {
  return <ShelfCaseFaces key={data.privacy ? "private" : "public"} data={data} selected={selected} {...pending} />;
}

function LightCaseFrame({ data, selected, ratio, ready, revealed, children }: { data: CaseData; selected: boolean; ratio: number; ready: boolean; revealed: boolean; children: ReactNode }) {
  const [previous, setPrevious] = useState(selected);
  const [settling, setSettling] = useState(false);
  if (previous !== selected) {
    setPrevious(selected);
    setSettling(!selected && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(false), 420);
    return () => clearTimeout(timer);
  }, [settling]);
  // Face loading is local to this case; a neutral case is already usable page content.
  // Do not mark it aria-busy: AreaSwitch uses that signal for unfinished page data.
  return <span className={`collection-light-case${data.platform === "book" ? " collection-light-case--book" : ""}`} data-ready={ready} data-revealed={revealed} data-front={selected || undefined} data-settling={settling || undefined} style={{ "--case-ratio": ratio, "--plastic": CASE_PLASTIC[data.platform], "--gloss": selected ? "50%" : "84%", ...(data.platform === "book" ? { "--spine-title-cells": Math.max(1, Array.from(data.title ?? "").length), "--spine-author-cells": Math.max(1, Array.from(data.author ?? "").length) } : {}) } as CSSProperties}>
    <span className="cs-box" onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === "transform") setSettling(false); }}>{children}<span className="cs-top" /></span>
  </span>;
}

function ShelfCaseFaces({ data, selected, ...pending }: { data: CaseData; selected: boolean } & ShelfPending) {
  const book = data.platform === "book";
  const images = useShelfFaces(data.privacy ? null : data.front, data.privacy ? null : book ? data.front : data.spine ?? null,
    data.privacy ? {} : { ...pending, spinePending: pending.spinePending || (book && pending.frontPending) });
  function cover(face: "front" | "spine") {
    return images.faces[face].slots.map((value, index) => {
      if (!value?.src) return null;
      const props = images.imageProps(face, value);
      return <img key={index} {...props} ref={image => { props.ref(image); if (face === "front") collectionCoverSourceRef(image); }} src={value.src}
        alt={face === "front" ? data.title : ""} draggable={false}
        style={{ ...props.style, ...(face === "spine" && book ? { objectPosition: `${stripPosition(data.coverFocus ?? null, images.ratio * .19, .08)}% 30%` } : {}) }} />;
    });
  }
  const spineShown = Boolean(images.faces.spine.shown);
  const spineData = { ...data, spine: images.faces.spine.shown?.src ?? null };
  return <LightCaseFrame data={data} selected={selected} ratio={images.ratio} ready={images.ready} revealed={images.revealed}>
    <span className="cs-front"><span className="ins">{data.privacy ? <span className="case-mask" /> : cover("front")}</span></span>
    <span className="cs-spine"><span className={book || !spineShown ? "ins" : spineInsertClass(spineData)}>
      {data.privacy ? <span className="case-mask" /> : book ? <span style={{ visibility: spineShown ? undefined : "hidden" }}>
        <MangaSpineFace shelf title={data.title} author={data.author} volumeNumber={data.volumeNumber} illustration={cover("spine")} />
      </span> : <>
        <span className="case-spine-art">{cover("spine")}</span>
        {spineShown && !spineData.spine && <CaseSpine decorative data={spineData} />}
      </>}
    </span></span>
  </LightCaseFrame>;
}
