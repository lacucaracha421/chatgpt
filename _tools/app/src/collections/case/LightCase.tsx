import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CollectionSummary } from "../../library/types";
import { useLibrary } from "../../library/LibraryContext";
import { workArtworkThumbnailUrl } from "../../assets/mediaUrl";
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
  const data: CaseData = { title: collection.name, publisher: collection.publisher, platform: workCasePlatform(collection.type, collection.platforms, collection.type === "game" ? info?.ownedPlatform : null), front: av?.front ?? front, spine, privacy };
  return <LightCase data={data} selected={selected} />;
}

/** Client-independent shelf object; only its data adapter reads local artwork. */
/** Selection is the lift alone (PC and tablet): no outline or check; the owning button shows keyboard focus. */
export function LightCase({ data, selected }: { data: CaseData; selected: boolean }) {
  const [ratio, setRatio] = useState(.71);
  return <span className={`collection-light-case${data.platform === "book" ? " collection-light-case--book" : ""}`} data-front={selected || undefined} style={{ "--case-ratio": ratio, "--plastic": CASE_PLASTIC[data.platform], "--gloss": selected ? "50%" : "84%" } as CSSProperties}>
    <span className="cs-box">
      <span className="cs-front">
        <span className="ins">
          {!data.privacy && data.front ? <StableImage src={data.front} alt={data.title} draggable={false} onLoad={event => {
            const image = event.currentTarget;
            if (image.naturalWidth && image.naturalHeight) setRatio(Math.max(.4, Math.min(1.4, image.naturalWidth / image.naturalHeight)));
          }} /> : <span className="case-mask" />}
        </span>
      </span>
      <span className="cs-spine"><span className={spineInsertClass(data)}><CaseSpine decorative data={data} /></span></span>
      <span className="cs-top" />
    </span>
  </span>;
}
