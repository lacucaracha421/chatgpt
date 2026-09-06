import { useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { KakaoSeriesCandidate, KakaoSyncResult } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Skeleton } from "../shared/ui/Skeleton";
import { TextField } from "../shared/ui/TextField";

type KakaoConnectDialogProps = {
  open: boolean;
  collectionId: string;
  initialQuery: string;
  onClose: () => void;
  onApplied: (result: KakaoSyncResult) => Promise<void> | void;
};

export function KakaoConnectDialog({
  open,
  collectionId,
  initialQuery,
  onClose,
  onApplied,
}: KakaoConnectDialogProps) {
  const { gateway } = useLibrary();
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<KakaoSeriesCandidate[] | null>(null);
  const [selected, setSelected] = useState<KakaoSeriesCandidate | null>(null);
  const [busy, setBusy] = useState<"search" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (!busy) onClose();
  }

  async function search() {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setError("검색어를 두 글자 이상 입력해 주세요.");
      return;
    }
    setBusy("search");
    setError(null);
    setSelected(null);
    try {
      const nextResults = await gateway.searchKakao(trimmed);
      setSubmittedQuery(trimmed);
      setResults(nextResults);
    } catch (searchError) {
      setError(commandErrorMessage(searchError, "카카오에서 검색하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!selected || !submittedQuery) return;
    setBusy("apply");
    setError(null);
    try {
      const result = await gateway.applyKakao({
        collectionId,
        query: submittedQuery,
        anchorItemId: selected.anchorItemId,
        groupFingerprint: selected.groupFingerprint,
      });
      await onApplied(result);
      onClose();
    } catch (applyError) {
      setError(commandErrorMessage(applyError, "카카오 정보를 연결하지 못했습니다."));
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} title="Kakao 연결" variant="wide" onClose={close}>
      <div className="book-connect">
        <div className="book-connect__search">
          <TextField
            label="카카오 작품 검색"
            type="search"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setError(null); }}
            onKeyDown={(event) => { if (event.key === "Enter") void search(); }}
          />
          <Button type="button" disabled={busy !== null} onClick={() => void search()}>
            {busy === "search" ? "검색 중…" : "검색"}
          </Button>
        </div>

        {error && <p className="book-connect__error" role="alert">{error}</p>}
        <p className="book-connect__note">국내 출판 제목으로 검색하세요. 출판사별 권 목록과 발매 정보를 연결합니다.</p>
        {busy === "search" && <Skeleton className="book-connect__loading" label="카카오 검색 중" />}

        <div className="book-connect__body">
          <div className="book-connect__results" aria-label="카카오 검색 결과">
            {results?.length === 0 && <p className="book-connect__empty">검색 결과가 없습니다.</p>}
            {results?.map((candidate) => (
              <button
                key={candidate.groupFingerprint}
                type="button"
                className="book-connect__result"
                aria-pressed={selected?.groupFingerprint === candidate.groupFingerprint}
                disabled={busy !== null}
                onClick={() => { setSelected(candidate); setError(null); }}
              >
                <strong>{candidate.title}</strong>
                <small>{[candidate.author, candidate.publisher, volumeSummary(candidate)].filter(Boolean).join(" · ")}</small>
              </button>
            ))}
          </div>

          <div className="book-connect__preview" aria-label="선택한 시리즈 권 목록">
            {selected ? (
              <>
                <div className="book-connect__preview-header">
                  <strong>{selected.title}</strong>
                  {selected.ignoredCount > 0 && <small>제외된 상품 {selected.ignoredCount}개</small>}
                </div>
                <ul>
                  {[...selected.volumes].sort((left, right) => left.volumeNumber - right.volumeNumber).map((volume) => (
                    <li key={volume.providerItemId}>
                      <span>{volume.title}</span>
                      <small>{[volume.publicationDate, volume.isbn13].filter(Boolean).join(" · ") || "발매 정보 없음"}</small>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="book-connect__empty">검색 결과에서 연결할 시리즈를 선택하세요.</p>
            )}
          </div>
        </div>

        <div className="ui-dialog__actions book-connect__actions">
          <span>기존 작품명과 선택한 표지는 유지됩니다.</span>
          <Button type="button" disabled={busy !== null} onClick={close}>취소</Button>
          <Button type="button" variant="primary" disabled={!selected || busy !== null} onClick={() => void apply()}>
            {busy === "apply" ? "연결 중…" : "연결"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function volumeSummary(candidate: KakaoSeriesCandidate) {
  if (candidate.volumes.length === 0) return "0권";
  const numbers = candidate.volumes.map((volume) => volume.volumeNumber);
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  return `${first === last ? first : `${first}–${last}`}권 · ${candidate.volumes.length}권`;
}
