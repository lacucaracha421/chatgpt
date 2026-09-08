import { dismissPublication, publicationLabel, publicationProgressText, usePublicationJobs } from "../library/publicationJobs";
import "./PublicationStatus.css";
import { Button } from "../shared/ui/Button";

export function PublicationStatus() {
  const jobs = usePublicationJobs();
  return <>{Object.values(jobs).map(job => job && <div className="status-bar publication-status" key={job.kind} role={job.error ? "alert" : "status"} aria-label={publicationLabel(job.kind)}>
    <span>{publicationLabel(job.kind)} · {job.running ? publicationProgressText(job.progress) : job.message}</span>
    {job.running ? <progress aria-label={`${publicationLabel(job.kind)} 현재 단계`} max={job.progress.total || undefined} value={job.progress.total ? job.progress.completed : undefined} /> : <Button size="sm" onClick={() => dismissPublication(job.kind)}>닫기</Button>}
  </div>)}</>;
}
