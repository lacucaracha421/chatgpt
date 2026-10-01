import { useEffect, useState } from "react";
import { useLibrary } from "../../library/LibraryContext";
import type { CollectionCoverFocus, CollectionVolume } from "../../library/types";

export function useCoverFocus(collectionId: string | null, volumes: CollectionVolume[] | null) {
  const { gateway } = useLibrary();
  const [stored, setStored] = useState<{ id: string; rows: CollectionCoverFocus[] } | null>(null);
  const [retry, setRetry] = useState(0);
  const coverKey = volumes?.map(volume => `${volume.id}/${volume.coverArtworkId ?? ""}`).join("|") ?? "";
  useEffect(() => {
    if (!collectionId || !volumes || !gateway.listCollectionCoverFocus) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let busyRetries = 0;
    const id = collectionId;
    const put = (focus: CollectionCoverFocus) => { if (active) setStored(current => ({ id, rows: [...(current?.id === id ? current.rows.filter(row => row.volumeId !== focus.volumeId) : []), focus] })); };
    async function run() {
      if (!active || !gateway.startCollectionCoverFocus) return;
      try {
        const result = await gateway.startCollectionCoverFocus(id, put);
        // Screen-local continuation. A failing batch waits for explicit retry/reopen,
        // so a missing runtime/bad cover never creates an endless detector loop.
        if (active && ((result.busy && busyRetries++ < 20) || (!result.busy && result.processed === 16 && result.failed === 0))) timer = setTimeout(() => void run(), result.busy ? 1500 : 200);
      } catch { /* The centre crop stays usable, including when runtime is not configured. */ }
    }
    void gateway.listCollectionCoverFocus(id).then(rows => { if (active) { setStored({ id, rows }); void run(); } }, () => { if (active) void run(); });
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [gateway, collectionId, coverKey, retry]);
  return { focuses: stored?.id === collectionId ? stored.rows : [], retry: () => setRetry(value => value + 1) };
}
