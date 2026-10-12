import { useEffect, useRef, useState } from "react";
import type { AssetImageText, LibraryGateway } from "../../library/types";

type Entry = { text: AssetImageText | null; busy: boolean };

/** Keep the outgoing image's data while StableImage decodes its replacement. */
export function useImageText(assetId: string | null, gateway?: Pick<LibraryGateway, "assetImageText" | "refreshAssetImageText">) {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const cached = useRef(entries);
  cached.current = entries;
  useEffect(() => {
    if (!assetId || !gateway?.assetImageText) return;
    let active = true;
    const update = (text: AssetImageText | null, busy: boolean) => {
      if (!active) return;
      setEntries(previous => previous[assetId]?.text?.digest === text?.digest && previous[assetId]?.busy === busy
        ? previous : { ...previous, [assetId]: { text, busy } });
    };
    void (async () => {
      let local = cached.current[assetId]?.text ?? null;
      try { local = await gateway.assetImageText!(assetId); } catch { /* A refresh can still recover the text. */ }
      if (!active) return;
      // A missing local copy stays silent: most images have no text, so no busy label for them.
      update(local, false);
      if (!gateway.refreshAssetImageText) return;
      try {
        const refreshed = await gateway.refreshAssetImageText(assetId);
        update(refreshed?.digest === local?.digest ? local : refreshed, false);
      } catch { update(local, false); }
    })();
    return () => { active = false; };
  }, [assetId, gateway]);
  return { entries, pending: Boolean(assetId && gateway?.assetImageText && !entries[assetId]) };
}
