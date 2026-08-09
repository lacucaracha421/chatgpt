import { useState } from "react";
import { Button } from "../shared/ui/Button";
import type { IngestionWork } from "./useFileDrop";

export function WorkTray({ works, retryFailed }: { works: IngestionWork[]; retryFailed: (workId: string) => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const visible = works.filter((work) => work.status !== "completed");
  if (visible.length === 0) return null;
  return <aside className="work-tray" aria-label="가져오기 작업">
    {visible.map((work) => <div className="work-tray__row" key={work.id}>
      {work.status === "running" ? <span aria-live="polite">가져오는 중 {work.completed} / {work.total}</span> : (
        <>
          <Button variant="ghost" aria-expanded={expandedId === work.id} onClick={() => setExpandedId((current) => current === work.id ? null : work.id)}>실패 {work.failures.length}개</Button>
          {expandedId === work.id && <div className="work-tray__failures">
            <ul>{work.failures.map((failure) => <li key={failure.sourcePath}><strong>{fileName(failure.sourcePath)}</strong><span>{failure.message}</span></li>)}</ul>
            <Button size="sm" onClick={() => retryFailed(work.id)}>실패 파일 다시 시도</Button>
          </div>}
        </>
      )}
    </div>)}
  </aside>;
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}
