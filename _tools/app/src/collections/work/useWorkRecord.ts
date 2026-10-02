import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../../library/LibraryContext";
import type { CollectionSummary, CollectionRecordEdit, CollectionWorkRecord } from "../../library/types";
import { defaultRecord } from "./WorkRecord";

export function useWorkRecord(collection: CollectionSummary | undefined) {
  const { gateway } = useLibrary();
  const [loaded, setLoaded] = useState<{ id: string; record: CollectionWorkRecord } | null>(null);
  const revision = useRef(0);
  const saves = useRef(Promise.resolve());
  const pending = useRef(0);
  const current = useRef(collection?.id); current.current = collection?.id;
  // Status/device edits can leave every summary field (including updatedAt) unchanged.
  // The shell supplies a fresh summary after the collections-changed event.
  useEffect(() => {
    if (!collection || !gateway.getCollectionWorkRecord) return;
    let active = true;
    const token = ++revision.current;
    void gateway.getCollectionWorkRecord(collection.id).then(record => { if (active && token === revision.current && pending.current === 0) setLoaded({ id: collection.id, record }); }, () => undefined);
    return () => { active = false; };
  }, [gateway, collection]);
  async function save(item: CollectionSummary, edit: CollectionRecordEdit) {
    if (!gateway.saveCollectionWorkRecord) throw new Error("개인 기록 저장 명령을 사용할 수 없습니다.");
    const write = gateway.saveCollectionWorkRecord;
    revision.current += 1; pending.current += 1;
    const operation = saves.current.then(() => write(item.id, edit));
    saves.current = operation.then(() => undefined, () => undefined);
    try {
      const record = await operation;
      if (current.current === item.id) setLoaded({ id: item.id, record });
      return record;
    } finally { pending.current -= 1; }
  }
  return { record: collection ? loaded?.id === collection.id ? loaded.record : defaultRecord(collection) : undefined, save };
}
