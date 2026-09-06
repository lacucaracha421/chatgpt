import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { CatalogReviewDecision, CatalogReviewPage, CatalogReviewRow } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { catalogCategoryLabel } from "./catalogCategories";
import "./CatalogReviewDialog.css";

const labels = { pending: "검토 대기", confirm: "같은 작품으로 확인", falsePositive: "다른 작품", split: "분리됨" };
export function CatalogReviewDialog({ onClose, onChange }: { onClose: () => void; onChange: () => void }) {
  const { gateway } = useLibrary();
  const [data, setData] = useState<CatalogReviewPage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const running = useRef(false);
  async function run(action: () => Promise<CatalogReviewPage>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try { const next = await action(); if (active.current) setData(next); }
    catch (e) { if (active.current) setError(commandErrorMessage(e, "중복 검토를 처리하지 못했습니다. 후보를 다시 생성해 주세요.")); }
    finally { running.current = false; if (active.current) setBusy(false); }
  }
  useEffect(() => {
    active.current = true;
    void run(() => gateway.listCatalogReview());
    return () => { active.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway]);
  function decide(row: CatalogReviewRow, decision: CatalogReviewDecision["decision"]) {
    void run(async () => {
      await gateway.decideCatalogReview({ leftAnchor: row.leftAnchor, rightAnchor: row.rightAnchor, reviewToken: row.reviewToken, decision });
      onChange(); // Also refresh after a save that completes after dialog close.
      return gateway.listCatalogReview();
    });
  }
  return <Dialog open title="중복 후보 검토" variant="medium" onClose={onClose}>
    <div className="catalog-review" aria-busy={busy}>
      <p>최근 500개 작품에서 최대 50개 후보를 찾습니다. 확인한 관계만 묶이며, 다른 작품·분리 결정은 재생성 후에도 유지됩니다.</p>
      <p>검토에는 숨긴 작품의 메타데이터도 포함됩니다. 분리는 연결된 수동 묶음을 함께 해제할 수 있으며, 검증된 계보는 유지됩니다.</p>
      <div className="catalog-review__actions">
        <Button size="sm" disabled={busy} onClick={() => void run(() => gateway.generateCatalogReview())}>후보 생성</Button>
        <Button size="sm" disabled={busy} onClick={() => void run(() => gateway.listCatalogReview())}>다시 불러오기</Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {data && data.inspectedWorks > 0 && <p role="status">{data.inspectedWorks}개 확인 · {data.comparisons}쌍 비교 · 큰 제목 묶음 {data.skippedBuckets}개 제외</p>}
      <div className="catalog-review__list">
        {data?.rows.map(row => <section className="catalog-review__pair" key={`${row.leftAnchor}:${row.rightAnchor}`} aria-label={`후보 ${row.leftAnchor}, ${row.rightAnchor}`}>
          <div className="catalog-review__works">{[row.evidence.left, row.evidence.right].map((w, i) => <div key={i}>
            <strong>{w.title}</strong>{w.titleJpn && <p>{w.titleJpn}</p>}
            <p>{w.creators.join(", ") || "작가/그룹 없음"}</p>
            <p>{w.pages}페이지 · {w.languages.join(", ")} · {catalogCategoryLabel(w.category) ?? "분류 없음"}</p>
            <p>작품 {w.workId} · 그룹 {w.groupId}</p>
          </div>)}</div>
          <p>{row.evidence.reason}</p><p>{labels[row.state]}{!row.actionable && " · 원본 변경 또는 누락: 후보 재생성 필요"}</p>
          {row.state === "confirm" && row.evidence.left.groupId !== row.evidence.right.groupId && <p>분리 결정과 충돌하여 현재 묶음에 적용되지 않습니다.</p>}
          <div className="catalog-review__actions">
            {row.state === "pending" && <><Button size="sm" disabled={busy || !row.actionable} onClick={() => decide(row, "confirm")}>같은 작품으로 확인</Button><Button size="sm" disabled={busy || !row.actionable} onClick={() => decide(row, "falsePositive")}>다른 작품</Button></>}
            {row.state === "confirm" && <Button size="sm" disabled={busy || !row.actionable} onClick={() => decide(row, "split")}>분리</Button>}
          </div>
        </section>)}
        {data?.rows.length === 0 && <p>검토 후보가 없습니다. 후보 생성으로 제한된 범위를 확인할 수 있습니다.</p>}
      </div>
      <Button size="sm" onClick={onClose}>닫기</Button>
    </div>
  </Dialog>;
}
