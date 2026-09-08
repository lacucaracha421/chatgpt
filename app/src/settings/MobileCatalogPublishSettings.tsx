import { publishMobileCatalog } from "../library/mobileCatalog";
import { publicationProgressText, startPublication, usePublicationJobs } from "../library/publicationJobs";
import { Button } from "../shared/ui/Button";

export function MobileCatalogPublishSettings() {
  const { catalog: job } = usePublicationJobs();
  return <section className="settings-section" aria-label="모바일 카탈로그">
    <h3>모바일 카탈로그</h3>
    <p className="settings-description">현재 카탈로그와 북마크를 클라우드에 게시하면 PC가 꺼져 있어도 모바일에서 볼 수 있습니다. 게시 중에는 앱을 켜둔 채 다른 화면에서 작업할 수 있습니다.</p>
    <Button disabled={job?.running} onClick={() => void startPublication("catalog", publishMobileCatalog, result => `${result.works.toLocaleString()}개 게시 완료`)}>{job?.running ? "카탈로그 게시 중…" : "모바일에 카탈로그 게시"}</Button>
    {job && <p role={job.error ? "alert" : "status"}>{job.running ? publicationProgressText(job.progress) : job.message}</p>}
  </section>;
}
