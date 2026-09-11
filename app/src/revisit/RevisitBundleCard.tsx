import { useEffect, useRef, useState } from "react";
import { ArrowPathIcon, EyeSlashIcon } from "@heroicons/react/24/outline";
import { useLibrary } from "../library/LibraryContext";
import type { RevisitBundle, RevisitFeedback } from "../library/types";
import { thumbnailUrl } from "../assets/mediaUrl";
import { Menu } from "../shared/ui/Menu";

export function RevisitBundleCard({ bundle, hero = false, pending, onOpen, onReshuffle, onDismiss }: {
  bundle: RevisitBundle;
  hero?: boolean;
  pending?: boolean;
  onOpen?: () => void;
  onReshuffle: () => void;
  onDismiss: () => void;
}) {
  const [feedbackPending, setFeedbackPending] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const { gateway } = useLibrary();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const recordedBundleId = useRef<string | null>(null);
  useEffect(() => {
    if (!element || recordedBundleId.current === bundle.id) return;
    recordedBundleId.current = bundle.id;
    const visibleAssetIds = bundle.assetIds.slice(0, hero ? 6 : 3);
    if (visibleAssetIds.length > 0) {
      void gateway.recordAssetsExposed(visibleAssetIds, new Date().toISOString()).catch(() => undefined);
    }
  }, [element, bundle.id, bundle.assetIds, gateway, hero]);
  const saveFeedback = async (feedback: RevisitFeedback) => {
    if (feedbackPending) return;
    setFeedbackPending(true);
    setFeedbackError(null);
    try {
      await gateway.setRevisitPreference(feedback);
      onDismiss();
    } catch {
      setFeedbackError("선호를 저장하지 못했습니다.");
    } finally {
      setFeedbackPending(false);
    }
  };
  const reduceCreator = async () => {
    const assetId = bundle.assetIds[0];
    if (!assetId || feedbackPending) return;
    setFeedbackPending(true);
    setFeedbackError(null);
    try {
      const asset = await gateway.getAsset(assetId);
      const creatorKey = asset.creatorHandle ?? asset.creatorUrl;
      if (!creatorKey) {
        setFeedbackError("작가 정보를 찾지 못했습니다.");
        return;
      }
      await gateway.setRevisitPreference({ kind: "creator", creatorKey });
      onDismiss();
    } catch {
      setFeedbackError("선호를 저장하지 못했습니다.");
    } finally {
      setFeedbackPending(false);
    }
  };
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
          <Menu
            label="관심 없음"
            trigger={<EyeSlashIcon aria-hidden="true" />}
            triggerClassName="revisit-bundle__icon-button"
            disabled={pending || feedbackPending}
            items={[
              { id: "recommendation", label: "이런 추천 덜 보기", disabled: feedbackPending, onSelect: () => void saveFeedback({ kind: "recommendation_type", recommendationType: bundle.kind }) },
              ...(bundle.kind === "creator" ? [{ id: "creator", label: "이 작가 덜 보기", disabled: feedbackPending, onSelect: () => void reduceCreator() }] : []),
              { id: "dismiss", label: "이 묶음만 숨기기", disabled: feedbackPending, onSelect: onDismiss },
            ]}
          />
        </div>
      </header>
      {feedbackError && <span className="revisit-bundle__feedback-error" role="alert">{feedbackError}</span>}
      {coversButton}
      <span className="revisit-bundle__count">{bundle.assetIds.length.toLocaleString("ko-KR")}개</span>
    </section>
  );
}
