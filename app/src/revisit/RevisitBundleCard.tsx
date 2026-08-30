import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { RevisitBundle } from "../library/types";
import { thumbnailUrl } from "../assets/mediaUrl";

export function RevisitBundleCard({ bundle, hero = false, pending, onReshuffle, onDismiss }: {
  bundle: RevisitBundle;
  hero?: boolean;
  pending?: boolean;
  onReshuffle: () => void;
  onDismiss: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { gateway } = useLibrary();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const recorded = useRef(false);
  useEffect(() => {
    if (!element || recorded.current) return;
    recorded.current = true;
    void gateway.recordAssetsExposed(bundle.assetIds, new Date().toISOString()).catch(() => undefined);
  }, [element, bundle.id, bundle.assetIds, gateway]);
  return (
    <section
      ref={setElement}
      data-testid={hero ? "revisit-hero-bundle" : "revisit-heap-bundle"}
      className={`revisit-bundle${hero ? " revisit-bundle--hero" : ""}`}
      aria-label={bundle.title}
    >
      <header className="revisit-bundle__header">
        <div className="revisit-bundle__heading">
          <h4>{bundle.title}</h4>
          <p className="revisit-bundle__reason">{bundle.reason}</p>
        </div>
        <div className="revisit-bundle__actions">
          <button type="button" aria-label="이 묶음 다시 섞기" disabled={pending} onClick={onReshuffle}>다시 섞기</button>
          <div className="revisit-bundle__feedback">
            <button type="button" aria-label="관심 없음" disabled={pending} onClick={() => setMenuOpen((open) => !open)}>관심 없음</button>
            {menuOpen && (
              <div role="menu" className="revisit-bundle__feedback-menu">
                <button type="button" role="menuitem" onClick={onDismiss}>이 묶음만 숨기기</button>
                <button type="button" role="menuitem" onClick={() => { onDismiss(); }}>이 작가 덜 보기</button>
                <button type="button" role="menuitem" onClick={() => { onDismiss(); }}>이 추천 유형 덜 보기</button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="revisit-bundle__covers">
        {bundle.assetIds.slice(0, hero ? 6 : 3).map((assetId) => (
          <img
            key={assetId}
            src={thumbnailUrl(assetId)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className="revisit-bundle__cover"
          />
        ))}
      </div>
      <span className="revisit-bundle__count">{bundle.assetIds.length.toLocaleString("ko-KR")}개</span>
    </section>
  );
}