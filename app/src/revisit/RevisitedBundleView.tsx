import { useEffect, useState } from "react";
import { ChevronLeftIcon } from "@heroicons/react/24/outline";
import { useLibrary } from "../library/LibraryContext";
import type { AssetSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { AssetGallery } from "../assets/AssetGallery";
import { AssetViewer } from "../assets/AssetViewer";

// 다시보기 묶음 화면: 오늘 탭 박스를 열면 이 화면으로 이동해
// 묶음에 담긴 자산을 일반 갤러리와 같은 배치로 보여준다.
export function RevisitedBundleView({ bundleId, title, assetIds, privacyMode, onBack }: {
  bundleId: string;
  title: string;
  assetIds: string[];
  privacyMode: boolean;
  onBack: () => void;
}) {
  const { gateway } = useLibrary();
  const [assets, setAssets] = useState<AssetSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAssets(null);
    setError(null);
    Promise.all(assetIds.map((assetId) => gateway.getAsset(assetId)))
      .then((resolved) => { if (!cancelled) setAssets(resolved); })
      .catch(() => { if (!cancelled) setError("묶음 자산을 불러오지 못했습니다."); });
    return () => { cancelled = true; };
    // assetIds 배열은 뷰가 바뀔 때만 새로 들어온다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId, gateway]);

  return <section className="revisited-bundle-view" aria-label={title}>
    <header className="revisited-bundle-view__header">
      <Button size="icon" variant="ghost" aria-label="다시보기로 돌아가기" onClick={onBack}><ChevronLeftIcon aria-hidden="true" /></Button>
      <h3>{title}</h3>
      <span>{assetIds.length.toLocaleString("ko-KR")}개</span>
    </header>
    {error && <p className="revisited-bundle-view__error" role="alert">{error}</p>}
    {assets === null && !error && <p className="revisited-bundle-view__loading">불러오는 중…</p>}
    {assets !== null && !error && <>
      <div className="revisited-bundle-view__gallery">
        <AssetGallery items={assets} railInteractive={false} privacyMode={privacyMode} onOpen={(asset) => setViewerAssetId(asset.id)} />
      </div>
      <AssetViewer items={assets} activeId={viewerAssetId} onActiveIdChange={setViewerAssetId} onClose={() => setViewerAssetId(null)} privacyMode={privacyMode} />
    </>}
  </section>;
}