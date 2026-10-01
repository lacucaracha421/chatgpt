import { useEffect, useState, type CSSProperties } from "react";
import type { CollectionSummary } from "../../library/types";
import { useLibrary } from "../../library/LibraryContext";
import { workArtworkThumbnailUrl } from "../../assets/mediaUrl";
import { StableImage } from "../../shared/ui/StableImage";
import { avGateway } from "../avClient";
import { CASE_PLASTIC, CaseSpine, casePlatform, type CaseData } from "./CollectionCase";
import "./LightCase.css";

export function CollectionShelfCase({ collection, front, privacy, active, selected }: { collection: CollectionSummary; front: string | null; privacy: boolean; active: boolean; selected: boolean }) {
  const { gateway } = useLibrary();
  const [art, setArt] = useState<{ front?: string | null; spine: string | null }>({ spine: null });
  useEffect(() => {
    if (!active || privacy) return;
    let current = true;
    const load = async () => {
      try {
        if (collection.type === "av") {
          const covers = await avGateway.getCoverSet(collection.id);
          const url = (id: string | null) => id ? `${workArtworkThumbnailUrl(id)}?v=${encodeURIComponent(covers.revision)}` : null;
          if (current) setArt({ front: url(covers.frontId), spine: url(covers.spineId) });
        } else if (typeof gateway.listCollectionWorkArtworks === "function") {
          const artworks = await gateway.listCollectionWorkArtworks(collection.id);
          const spines = artworks.filter(item => item.kind === "spine");
          const spine = spines.find(item => item.selected) ?? spines[0];
          if (current) setArt({ spine: spine ? workArtworkThumbnailUrl(spine.id) : null });
        }
      } catch { /* Existing front artwork and the platform template remain available. */ }
    };
    void load();
    return () => { current = false; };
  }, [active, privacy, collection.id, collection.type, collection.updatedAt, gateway]);
  const data: CaseData = { title: collection.name, publisher: collection.publisher, platform: collection.type === "av" ? "av" : collection.type === "movie" ? "film" : casePlatform(collection.platforms), front: art.front ?? front, spine: art.spine, privacy };
  return <LightCase data={data} selected={selected} />;
}

/** Client-independent shelf object; only its data adapter reads local artwork. */
export function LightCase({ data, selected }: { data: CaseData; selected: boolean }) {
  const [ratio, setRatio] = useState(.71);
  return <span className="collection-light-case" style={{ "--case-ratio": ratio, "--plastic": CASE_PLASTIC[data.platform] } as CSSProperties}>
    <span className="cs-box">
      <span className="cs-front ui-selectable-media" aria-selected={selected}>
        {!data.privacy && data.front ? <StableImage src={data.front} alt={data.title} draggable={false} onLoad={event => {
          const image = event.currentTarget;
          if (image.naturalWidth && image.naturalHeight) setRatio(Math.max(.4, Math.min(1.4, image.naturalWidth / image.naturalHeight)));
        }} /> : <span className="case-mask" />}
        {selected && <span className="ui-selection-check" aria-hidden="true" />}
      </span>
      <span className="cs-spine"><CaseSpine decorative data={data} real={data.spine ? <StableImage src={data.spine} alt="" draggable={false} /> : null} /></span>
      <span className="cs-top" />
    </span>
  </span>;
}
