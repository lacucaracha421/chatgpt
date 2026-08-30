import { useEffect, useRef, useState } from "react";
import { ArrowPathIcon, EyeSlashIcon } from "@heroicons/react/24/outline";
import { useLibrary } from "../library/LibraryContext";
import type { RevisitBundle } from "../library/types";
import { thumbnailUrl } from "../assets/mediaUrl";

export function RevisitBundleCard({ bundle, hero = false, pending, onOpen, onReshuffle, onDismiss }: {
  bundle: RevisitBundle;
  hero?: boolean;
  pending?: boolean;
  onOpen?: () => void;
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
  const coversButton = (
    <button
      type="button"
      className="revisit-bundle__open"
      aria-label={`${bundle.title} 자산 보기`}
      disabled={!onOpen}
      onClick={onOpen}
    >
      <span className="revisit-bundle__covers">
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
      </span>
    </button>
  );
  return (
    <section
      ref={setElement}
      data-testid={hero ? "revisit-hero-bundle" : "revisit-heap-bundle"}
      className={`revisit-bundle${hero ? " revisit-bundle--hero" : ""}`}
      aria-label={bundle.title}
    >
      <header className="revisit-bundle__header">
        <h4>{bundle.title}{bundle.reason && <span className="revisit-bundle__reason">{bundle.reason}</span>}</h4>
        <div className="revisit-bundle__actions">
          <button type="button" className="revisit-bundle__icon-button" aria-label="이 묶음 다시 섞기" disabled={pending} onClick={onReshuffle}><ArrowPathIcon aria-hidden="true" /></button>
          <div className="revisit-bundle__feedback">
            <button type="button" className="revisit-bundle__icon-button" aria-label="관심 없음" disabled={pending} onClick={() => setMenuOpen((open) => !open)}><EyeSlashIcon aria-hidden="true" /></button>
            {menuOpen && (
              <div role="menu" className="revisit-bundle__feedback-menu">
                <button type="button" role="menuitem" onClick={onDismiss}>이 묶음만 숨기기</button>
              </div>
            )}
          </div>
        </div>
      </header>
      {coversButton}
      <span className="revisit-bundle__count">{bundle.assetIds.length.toLocaleString("ko-KR")}개</span>
    </section>
  );
}