import { useEffect, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { MangaSeries } from "../library/types";
import { mangaCoverUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { ViewToolbar } from "../layout/ViewToolbar";

type MangaBrowserProps = {
  onOpenSeries?: (series: MangaSeries) => void;
};
export function MangaBrowser({ onOpenSeries }: MangaBrowserProps) {
  const { gateway } = useLibrary();
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  const [series, setSeries] = useState<MangaSeries[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useAutoDismiss(message, setMessage);

  async function refreshSeries(active = () => true) {
    try {
      const scanned = await gateway.scanManga();
      if (!active()) return;
      setMessage(scanned > 0 ? `망가 ${scanned}개를 새로고침했습니다` : "새로 변경된 망가가 없습니다");
      const next = await gateway.listMangaSeries();
      if (active()) setSeries(next);
    } catch {
      if (active()) setMessage("망가 목록을 불러오지 못했습니다");
    }
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const currentRoot = await gateway.getMangaRoot();
        if (!active) return;
        setRoot(currentRoot);
        if (currentRoot) await refreshSeries(() => active);
      } catch {
        if (active) setMessage("망가 목록을 불러오지 못했습니다");
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway]);

  if (root === undefined) {
    return <section className="manga-browser" aria-label="망가"><Skeleton className="manga-browser__skeleton" label="망가를 불러오는 중" /></section>;
  }

  if (!root) {
    return <section className="manga-browser" aria-label="망가">
      <EmptyState title="망가 폴더가 설정되지 않았습니다">설정에서 망가 폴더를 선택하면 여기에 표시됩니다.</EmptyState>
    </section>;
  }

  return <section className="manga-browser" aria-label="망가">
    <ViewToolbar title="망가" actions={<Button size="sm" onClick={() => void refreshSeries()}>새로고침</Button>} />
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    {!series ? <Skeleton className="manga-browser__skeleton" label="망가를 불러오는 중" /> : series.length === 0 ? (
      <EmptyState title="망가가 없습니다">망가 폴더에 시리즈 폴더를 추가하세요.</EmptyState>
    ) : <MangaCoverGrid series={series} onOpenSeries={onOpenSeries} />}
  </section>;
}

function MangaCoverGrid({ series, onOpenSeries }: { series: MangaSeries[]; onOpenSeries?: (series: MangaSeries) => void }) {
  return <div className="manga-browser__grid">
    {series.map((entry) => (
      <button key={entry.id} type="button" className="manga-browser__cover" onClick={() => onOpenSeries?.(entry)}>
        <img src={mangaCoverUrl(entry.id)} alt={entry.title} loading="lazy" draggable={false} />
        <span className="manga-browser__cover-title">{entry.title}</span>
        <span className="manga-browser__cover-author">{entry.author} · {entry.pageCount}페이지</span>
      </button>
    ))}
  </div>;
}
