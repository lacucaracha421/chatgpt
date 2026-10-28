import type { CollectionSummary, CollectionType, LibraryGateway } from "../library/types";
import { latestTrashedCollection } from "./collectionEditFields";

/** Use the trash UI's authority command and wait for its confirmed local projection. */
export async function restoreCollectionByName(gateway: LibraryGateway, type: CollectionType, name: string): Promise<CollectionSummary> {
  if (!gateway.listCollectionTrash || !gateway.restoreCollectionWork) throw new Error("컬렉션 복원을 사용할 수 없습니다.");
  const page = await gateway.listCollectionTrash();
  const item = latestTrashedCollection(page.items, type, name);
  if (!item) throw new Error("휴지통의 컬렉션을 찾지 못했습니다. 다시 확인해 주세요.");
  await gateway.restoreCollectionWork(item.workId, item.entityRevision, page.libraryId, page.epoch);
  const deadline = Date.now() + 30_000;
  do {
    const restored = (await gateway.listCollections()).find(work => work.id === item.workId);
    if (restored) return restored;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error("복원을 기다리고 있어요. 동기화 상태를 확인한 뒤 다시 시도해 주세요.");
}
