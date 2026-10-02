import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { executeMetadataImport, type MetadataImportWork } from "../ingestion/metadataImport";
import { commandErrorMessage } from "../library/errorMessage";
import type { LibraryGateway } from "../library/types";

export function useMetadataImport(gateway: LibraryGateway, refreshClassifications: () => Promise<void>, refreshReviewCount: () => Promise<void>, setAssetRefresh: Dispatch<SetStateAction<number>>) {
  const [metadataImportWorks, setMetadataImportWorks] = useState<MetadataImportWork[]>([]);
  const metadataImportRunningRef = useRef(false);
  const beginMetadataImport = useCallback(async (folder: string, existingWorkId?: string) => {
    if (metadataImportRunningRef.current) return false;
    metadataImportRunningRef.current = true;
    const workId = existingWorkId ?? crypto.randomUUID();
    const update = (work: MetadataImportWork) => setMetadataImportWorks((current) => {
      const previous = current.find((item) => item.id === work.id);
      // Reusing the workId preserves duplicate and review results from the previous attempt on failure.
      const withPrevious = previous && work.status === "failed"
        ? { ...work, total: previous.total, completed: previous.completed, added: previous.added, foldersCreated: previous.foldersCreated, pathsReused: previous.pathsReused, exactDuplicates: previous.exactDuplicates, reviewPending: previous.reviewPending, skipped: previous.skipped }
        : work;
      return current.some((item) => item.id === work.id)
        ? current.map((item) => item.id === work.id ? withPrevious : item)
        : [...current, withPrevious];
    });
    try {
      await executeMetadataImport(gateway, folder, update, workId);
      await refreshClassifications();
      setAssetRefresh((current) => current + 1);
      await refreshReviewCount();
      return true;
    } catch (error) {
      update({ kind: "metadata_import", id: workId, folder, total: 0, completed: 0, added: 0, foldersCreated: 0, pathsReused: 0, exactDuplicates: [], reviewPending: [], skipped: [], failures: [{ fileName: "폴더 검사", message: commandErrorMessage(error, "가져오기 폴더를 검사하지 못했습니다.") }], status: "failed" });
      return false;
    } finally {
      metadataImportRunningRef.current = false;
    }
  }, [gateway, refreshClassifications, refreshReviewCount]);
  return { metadataImportWorks, setMetadataImportWorks, beginMetadataImport };
}
