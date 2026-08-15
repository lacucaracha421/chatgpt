import { commandErrorMessage } from "../library/errorMessage";
import type { ClassificationEntry, IngestOutcome, LibraryGateway } from "../library/types";

export type MetadataImportWork = {
  kind: "metadata_import";
  id: string;
  folder: string;
  total: number;
  completed: number;
  added: number;
  foldersCreated: number;
  pathsReused: number;
  exactDuplicates: Array<{ fileName: string; existingAssetId: string }>;
  reviewPending: Array<{ fileName: string; reviewId: string }>;
  skipped: Array<{ fileName: string; message: string }>;
  failures: Array<{ fileName: string; message: string }>;
  status: "running" | "completed" | "failed";
};

export async function executeMetadataImport(
  gateway: LibraryGateway,
  folder: string,
  onProgress?: (work: MetadataImportWork) => void,
  workId: string = crypto.randomUUID(),
): Promise<MetadataImportWork> {
  if (!gateway.inspectMetadataImport) throw new Error("이 앱 버전은 메타데이터 폴더 가져오기를 지원하지 않습니다.");
  const plan = await gateway.inspectMetadataImport(folder);
  const entries = await gateway.listClassifications();
  const resolved = await ensureClassificationPaths(gateway, entries, plan.classificationPaths);
  const pathIds = resolved.pathIds;
  let work: MetadataImportWork = {
    kind: "metadata_import",
    id: workId,
    folder,
    total: plan.items.length,
    completed: 0,
    added: 0,
    foldersCreated: resolved.created,
    pathsReused: resolved.reused,
    exactDuplicates: [],
    reviewPending: [],
    skipped: plan.skipped.map((item) => ({ fileName: item.fileName, message: skipMessage(item.reason) })),
    failures: [],
    status: "running",
  };
  onProgress?.(work);

  for (const item of plan.items) {
    try {
      const classificationId = pathIds.get(pathKey(item.classificationPath));
      if (!classificationId) throw new Error("메타데이터 분류 경로를 만들지 못했습니다.");
      const outcome = await gateway.ingestMedia({
        sourcePath: item.sourcePath,
        classificationId,
        sourceUrl: item.sourceUrl,
        collectedAt: item.collectedAt,
        replaceDuplicateMetadata: true,
        importSource: "metadata_import",
        importBatchId: workId,
      });
      work = applyOutcome(work, item.fileName, outcome);
    } catch (error) {
      work = { ...work, failures: [...work.failures, { fileName: item.fileName, message: commandErrorMessage(error, "가져오지 못했습니다.") }] };
    }
    work = { ...work, completed: work.completed + 1 };
    onProgress?.(work);
  }
  work = { ...work, status: work.failures.length > 0 ? "failed" : "completed" };
  onProgress?.(work);
  return work;
}

async function ensureClassificationPaths(
  gateway: LibraryGateway,
  initial: ClassificationEntry[],
  paths: string[][],
): Promise<{ pathIds: Map<string, string>; created: number; reused: number }> {
  const entries = [...initial];
  const result = new Map<string, string>();
  let created = 0;
  let reused = 0;
  for (const path of paths) {
    let parentId: string | null = null;
    const traversed: string[] = [];
    for (const name of path) {
      traversed.push(name);
      let entry = entries.find((candidate) => candidate.parentId === parentId && candidate.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0);
      if (!entry) {
        entry = await gateway.createClassification({ kind: parentId === null ? "root" : "tag", name, parentId });
        entries.push(entry);
        created += 1;
      } else {
        reused += 1;
      }
      parentId = entry.id;
      result.set(pathKey(traversed), entry.id);
    }
  }
  return { pathIds: result, created, reused };
}

function pathKey(path: string[]): string {
  return path.map((part) => part.toLocaleLowerCase()).join("\0");
}

function applyOutcome(work: MetadataImportWork, fileName: string, outcome: IngestOutcome): MetadataImportWork {
  if (outcome.status === "added") return { ...work, added: work.added + 1 };
  if (outcome.status === "exact_duplicate") return { ...work, exactDuplicates: [...work.exactDuplicates, { fileName, existingAssetId: outcome.existingAssetId }] };
  return { ...work, reviewPending: [...work.reviewPending, { fileName, reviewId: outcome.reviewId }] };
}

function skipMessage(reason: "missing_file" | "invalid_source_url" | "invalid_collected_at"): string {
  if (reason === "missing_file") return "원본 파일이 없습니다.";
  if (reason === "invalid_source_url") return "출처 URL이 올바르지 않습니다.";
  return "수집 시각이 올바르지 않습니다.";
}
