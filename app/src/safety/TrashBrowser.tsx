import { useCallback, useEffect, useRef, useState } from "react";
import { ASSET_PAGE_SIZE } from "../library/constants";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { TrashPage, TrashPolicy } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { TextField } from "../shared/ui/TextField";
import { Toast } from "../shared/ui/Toast";
import { Toggle } from "../shared/ui/Toggle";

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;

export function TrashBrowser() {
  const { gateway } = useLibrary();
  const [page, setPage] = useState<TrashPage | null>(null);
  const [policy, setPolicy] = useState<TrashPolicy | null>(null);
  const [retentionDays, setRetentionDays] = useState("");
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingMutation, setPendingMutation] = useState<"restore" | "policy" | "empty" | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const loadGenerationRef = useRef(0);
  const pendingMutationRef = useRef<"restore" | "policy" | "empty" | null>(null);

  const load = useCallback(() => {
    const generation = ++loadGenerationRef.current;
    setPageLoading(true);
    setPageError(null);
    setPolicyError(null);
    setPolicy(null);
    void gateway.listTrash({ after: null, limit: ASSET_PAGE_SIZE })
      .then((nextPage) => {
        if (generation === loadGenerationRef.current) setPage(nextPage);
      })
      .catch((error: unknown) => {
        if (generation === loadGenerationRef.current) setPageError(commandErrorMessage(error, "휴지통을 불러오지 못했습니다."));
      })
      .finally(() => {
        if (generation === loadGenerationRef.current) setPageLoading(false);
      });
    void gateway.getTrashPolicy()
      .then((nextPolicy) => {
        if (generation !== loadGenerationRef.current) return;
        setPolicy(nextPolicy);
        setRetentionDays(nextPolicy.retentionDays?.toString() ?? "");
      })
      .catch((error: unknown) => {
        if (generation === loadGenerationRef.current) setPolicyError(commandErrorMessage(error, "보존 기간을 불러오지 못했습니다."));
      })
      .finally(() => {
      });
  }, [gateway]);

  useEffect(() => {
    load();
    return () => { loadGenerationRef.current += 1; };
  }, [load]);

  function beginMutation(kind: "restore" | "policy" | "empty"): boolean {
    if (pendingMutationRef.current) return false;
    pendingMutationRef.current = kind;
    setPendingMutation(kind);
    return true;
  }

  function finishMutation() {
    pendingMutationRef.current = null;
    setPendingMutation(null);
  }

  async function restore(assetId: string) {
    if (!beginMutation("restore")) return;
    try {
      await gateway.restoreAsset(assetId);
      setMessage("자산을 복원했습니다.");
      load();
    } catch (error) {
      setMessage(commandErrorMessage(error, "자산을 복원하지 못했습니다."));
    } finally {
      finishMutation();
    }
  }

  async function setAutomaticDeletion(enabled: boolean) {
    if (!beginMutation("policy")) return;
    const nextPolicy = { retentionDays: enabled ? validRetentionDays(retentionDays) ?? 30 : null };
    try {
      await gateway.setTrashPolicy(nextPolicy);
      setPolicy(nextPolicy);
      setRetentionDays(nextPolicy.retentionDays?.toString() ?? "");
      load();
    } catch (error) {
      setMessage(commandErrorMessage(error, "자동 삭제 설정을 변경하지 못했습니다."));
    } finally {
      finishMutation();
    }
  }

  async function saveRetention() {
    const days = validRetentionDays(retentionDays);
    if (days === null || !beginMutation("policy")) return;
    try {
      await gateway.setTrashPolicy({ retentionDays: days });
      setPolicy({ retentionDays: days });
      setRetentionDays(days.toString());
      setMessage("보존 기간을 저장했습니다.");
      load();
    } catch (error) {
      setMessage(commandErrorMessage(error, "보존 기간을 저장하지 못했습니다."));
    } finally {
      finishMutation();
    }
  }

  async function emptyTrash() {
    if (!beginMutation("empty")) return;
    try {
      const result = await gateway.emptyTrash();
      const failedCount = result.failedAssetIds.length;
      setMessage(failedCount > 0
        ? `${result.deletedCount}개 삭제, ${failedCount}개 삭제 실패했습니다.`
        : `${result.deletedCount}개를 영구 삭제했습니다.`);
      setConfirmEmpty(false);
      load();
    } catch (error) {
      setMessage(commandErrorMessage(error, "휴지통을 비우지 못했습니다."));
    } finally {
      finishMutation();
    }
  }

  const automaticDeletion = policy !== null && policy.retentionDays !== null;
  const retentionError = automaticDeletion ? retentionErrorMessage(retentionDays) : undefined;
  const loadError = pageError ?? policyError;
  const mutationPending = pendingMutation !== null;

  return <section className="trash-browser" aria-label="휴지통">
    <ViewToolbar
      title="휴지통"
      children={<p>복원할 수 있는 자산을 보관합니다.</p>}
      actions={<Button variant="danger" onClick={() => setConfirmEmpty(true)} disabled={!page || page.totalCount === 0 || mutationPending}>휴지통 비우기</Button>}
    />
    <section className="trash-browser__policy" aria-label="보존 기간 설정">
      <Toggle checked={automaticDeletion} disabled={!policy || mutationPending} onChange={(event) => void setAutomaticDeletion(event.target.checked)}>자동 삭제</Toggle>
      {automaticDeletion && <div className="trash-browser__retention"><TextField label="보존 기간" type="number" min={MIN_RETENTION_DAYS} max={MAX_RETENTION_DAYS} value={retentionDays} error={retentionError} disabled={mutationPending} onChange={(event) => setRetentionDays(event.target.value)} /><Button onClick={() => void saveRetention()} disabled={Boolean(retentionError) || mutationPending}>저장</Button></div>}
    </section>
    {message && <Toast>{message}</Toast>}
    {loadError && <div className="trash-browser__load-error"><Toast>{loadError}</Toast><Button disabled={mutationPending} onClick={load}>다시 시도</Button></div>}
    {pageLoading && !page ? <Skeleton className="trash-browser__skeleton" label="휴지통을 불러오는 중" /> : pageError && !page ? <EmptyState title="휴지통을 불러오지 못했습니다." /> : !page || page.items.length === 0 ? <EmptyState title="휴지통이 비어 있습니다">삭제한 자산은 이곳에서 복원할 수 있습니다.</EmptyState> : <ul className="trash-browser__list">{page.items.map(({ asset, trashedAt, purgeAt }) => <li key={asset.id} className="trash-browser__item"><div><strong>{asset.title || asset.originalName}</strong><span>삭제: {localDate(trashedAt)}</span><span>{purgeAt ? `영구 삭제까지 ${remainingDays(purgeAt)}일` : "자동 삭제 안 함"}</span></div><Button disabled={mutationPending} onClick={() => void restore(asset.id)}>복원</Button></li>)}</ul>}
    {confirmEmpty && page && <Dialog open title="휴지통 비우기" onClose={() => setConfirmEmpty(false)}><p>휴지통의 자산 {page.totalCount}개 ({formatBytes(page.totalBytes)})를 영구 삭제합니다.</p><p>이 작업은 되돌릴 수 없습니다.</p><div className="ui-dialog__actions"><Button disabled={mutationPending} onClick={() => setConfirmEmpty(false)}>취소</Button><Button variant="danger" disabled={mutationPending} onClick={() => void emptyTrash()}>영구 삭제</Button></div></Dialog>}
  </section>;
}

function validRetentionDays(value: string): number | null {
  const days = Number(value);
  return Number.isInteger(days) && days >= MIN_RETENTION_DAYS && days <= MAX_RETENTION_DAYS ? days : null;
}

function retentionErrorMessage(value: string): string | undefined {
  return validRetentionDays(value) === null ? `보존 기간은 ${MIN_RETENTION_DAYS}일에서 ${MAX_RETENTION_DAYS}일 사이여야 합니다.` : undefined;
}

function remainingDays(purgeAt: string): number {
  const timestamp = new Date(purgeAt).getTime();
  if (Number.isNaN(timestamp)) return 0;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 86_400_000));
}

function localDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value / (1024 * 1024))} MB`;
}
