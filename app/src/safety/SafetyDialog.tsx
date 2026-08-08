import { useCallback, useEffect, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { useLibrary } from "../library/LibraryContext";
import type { MetadataBackup } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";

type SafetyDialogProps = {
  open: boolean;
  restoring: boolean;
  onClose: () => void;
  onRestore: (backupId: string) => Promise<void>;
};

export function SafetyDialog({ open, restoring, onClose, onRestore }: SafetyDialogProps) {
  const { gateway } = useLibrary();
  const [backups, setBackups] = useState<MetadataBackup[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const generationRef = useRef(0);
  const restorePendingRef = useRef(false);
  const pending = restoring || submitting;

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setBackups(null);
    setError(null);
    void gateway.listMetadataBackups()
      .then((nextBackups) => {
        if (generation === generationRef.current) setBackups(nextBackups);
      })
      .catch((loadError: unknown) => {
        if (generation === generationRef.current) {
          setError(commandErrorMessage(loadError, "백업 목록을 불러오지 못했습니다."));
        }
      });
  }, [gateway]);

  useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      setConfirmingId(null);
      return;
    }
    load();
    return () => { generationRef.current += 1; };
  }, [load, open]);

  async function restore() {
    if (!confirmingId || restorePendingRef.current) return;
    restorePendingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onRestore(confirmingId);
    } catch (restoreError) {
      setError(commandErrorMessage(restoreError, "백업을 복구하지 못했습니다."));
    } finally {
      restorePendingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={confirmingId ? "백업 복구" : "라이브러리 안전 설정"}
      closeDisabled={pending}
      onClose={onClose}
    >
      {confirmingId ? (
        <div className="safety-dialog__confirmation">
          <p>현재 상태를 별도로 보존한 뒤 선택한 시점으로 관리 정보를 복구합니다.</p>
          {error && <Toast>{error}</Toast>}
          <div className="ui-dialog__actions">
            <Button disabled={pending} onClick={() => setConfirmingId(null)}>취소</Button>
            <Button variant="primary" disabled={pending} onClick={() => void restore()}>
              {pending ? "복구 중…" : "복구 시작"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="safety-dialog__content">
          <p>라이브러리 관리 정보의 자동 백업을 선택해 복구할 수 있습니다.</p>
          {error && <div className="safety-dialog__error"><Toast>{error}</Toast><Button onClick={load}>다시 시도</Button></div>}
          {!backups && !error ? (
            <Skeleton className="safety-dialog__skeleton" label="백업 목록을 불러오는 중" />
          ) : backups?.length === 0 ? (
            <p>사용할 수 있는 백업이 없습니다.</p>
          ) : backups ? (
            <ul className="safety-dialog__list">
              {backups.map((backup) => (
                <li key={backup.id} className="safety-dialog__item">
                  <div>
                    <strong>{localDate(backup.createdAt)}</strong>
                    <span>{kindLabel(backup.kind)}</span>
                    <span>{backup.byteSize.toLocaleString("ko-KR")} B</span>
                  </div>
                  <Button onClick={() => setConfirmingId(backup.id)}>이 시점으로 복구</Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="ui-dialog__actions">
            <Button onClick={onClose}>닫기</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function kindLabel(kind: MetadataBackup["kind"]): string {
  switch (kind) {
    case "daily": return "자동 백업";
    case "pre_migration": return "업데이트 전";
    case "pre_restore": return "복구 직전";
  }
}

function localDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("ko-KR");
}
