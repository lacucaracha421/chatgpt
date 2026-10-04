import { BusyLabel } from "../shared/ui/BusyLabel";
import { useState } from "react";
import { applyTaggerReview, previewTaggerReview, type TaggerReviewPreview, type TaggerReviewSummary } from "../characters/taggerReviewClient";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";

function targetLines(summary: TaggerReviewSummary) {
  return summary.targets.filter((target) => target.count > 0).sort((a, b) => b.count - a.count)
    .map((target) => `${target.seriesName} › ${target.targetName} ${target.count.toLocaleString("ko-KR")}`).join(" · ");
}

/**
 * Settings › 라이브러리 › 태거 검토: preview, then apply, the tagger veto (automatic acceptances both
 * taggers reject go back to review) and recommendations (both taggers agree, no decision yet).
 */
export function TaggerReviewSettings({ disabled }: { disabled: boolean }) {
  const [preview, setPreview] = useState<TaggerReviewPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function run(action: "preview" | "apply") {
    if (busy || disabled) return;
    setBusy(true);
    setMessage(null);
    try {
      if (action === "preview") {
        setPreview(await previewTaggerReview());
      } else if (preview) {
        const applied = await applyTaggerReview(preview.previewToken);
        setPreview(null);
        setMessage({ text: `적용했습니다. 검토로 돌린 자동 판정 ${applied.veto.count.toLocaleString("ko-KR")}개 · 태거 추천 ${applied.recommend.count.toLocaleString("ko-KR")}개`, error: false });
      }
    } catch (reason) {
      const stale = String((reason as { code?: string })?.code ?? reason).includes("stale");
      setPreview(null);
      setMessage({ text: stale ? "미리보기 이후 데이터가 바뀌었습니다. 다시 미리보기 해 주세요." : commandErrorMessage(reason, "태거 검토를 처리하지 못했습니다."), error: true });
    } finally {
      setBusy(false);
    }
  }

  return <dl className="settings-view__property">
    <dt>태거 검토</dt>
    {preview && <dd className="settings-view__status settings-view__stacked-status">
      <span>검토로 돌림 {preview.veto.count.toLocaleString("ko-KR")}개{preview.veto.count > 0 && ` — ${targetLines(preview.veto)}`}</span>
      <span>참조로 쓰는 이미지라 건너뜀 {preview.skippedReferences.count.toLocaleString("ko-KR")}개</span>
      <span>태거 추천 {preview.recommend.count.toLocaleString("ko-KR")}개{preview.recommend.count > 0 && ` — ${targetLines(preview.recommend)}`}</span>
    </dd>}
    <dd className="settings-view__inline-controls"><Button size="sm" disabled={busy || disabled} onClick={() => void run("preview")}><BusyLabel busy={!!(busy && !preview)} idle={"미리보기"}>계산 중…</BusyLabel></Button>
    {preview && <Button size="sm" disabled={busy || disabled || (preview.veto.count + preview.recommend.count === 0)} onClick={() => void run("apply")}><BusyLabel busy={!!(busy)} idle={"적용"}>적용 중…</BusyLabel></Button>}</dd>
    {message && <dd className="settings-view__row-message" role={message.error ? "alert" : "status"}>{message.text}</dd>}
  </dl>;
}
