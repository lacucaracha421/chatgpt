import { Button } from "../shared/ui/Button";
import { dismissVaultExport, useVaultExportJob, vaultExportProgressText, vaultExportResultText } from "./vaultExportJob";
import { dismissVaultImport, useVaultImportJob, vaultImportProgressText, vaultImportResultText } from "./vaultImportJob";

const LABEL = "비밀 보관함 가져오기";
const EXPORT_LABEL = "비밀 보관함 내보내기";

/** The Private Vault import in the work center, visible from every view. */
export function VaultImportStatus() {
  const { job } = useVaultImportJob();
  if (!job) return null;
  return <div className="status-bar publication-status" role={job.error ? "alert" : "status"} aria-label={LABEL}>
    <span>{LABEL} · {job.running ? vaultImportProgressText(job) : vaultImportResultText(job)}</span>
    {job.running
      ? <progress aria-label={`${LABEL} 진행률`} max={job.progress?.total || undefined} value={job.progress?.total ? job.progress.processed : undefined} />
      : <Button size="sm" onClick={dismissVaultImport}>닫기</Button>}
  </div>;
}

/** The Private Vault export in the work center, visible from every view. */
export function VaultExportStatus() {
  const job = useVaultExportJob();
  if (!job) return null;
  return <div className="status-bar publication-status" role={job.error ? "alert" : "status"} aria-label={EXPORT_LABEL}>
    <span>{EXPORT_LABEL} · {job.running ? vaultExportProgressText(job) : vaultExportResultText(job)}</span>
    {job.running
      ? <progress aria-label={`${EXPORT_LABEL} 진행률`} max={job.progress?.total || undefined} value={job.progress?.total ? job.progress.processed : undefined} />
      : <Button size="sm" onClick={dismissVaultExport}>닫기</Button>}
  </div>;
}
