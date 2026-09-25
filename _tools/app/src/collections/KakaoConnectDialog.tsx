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
  // Fingerprints of the picked groups; a row click picks only that group, the checkbox
  // adds or removes groups Kakao split off the same series (imprint change, 완결, 신장판).
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const selected = (results ?? []).filter((candidate) => selectedKeys.includes(candidate.groupFingerprint));
  const [busy, setBusy] = useState<"search" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(fingerprint: string) {
    setSelectedKeys((keys) =>
      keys.includes(fingerprint) ? keys.filter((key) => key !== fingerprint) : [...keys, fingerprint],
    );
  }

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
    setSelectedKeys([]);
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
    if (selected.length === 0 || !submittedQuery) return;
    setBusy("apply");
    setError(null);
    try {
      const result = await gateway.applyKakao({
        collectionId,
        query: submittedQuery,
        groups: selected.map(({ anchorItemId, groupFingerprint }) => ({ anchorItemId, groupFingerprint })),
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
            {results?.map((candidate) => {
              const checked = selectedKeys.includes(candidate.groupFingerprint);
              return (
                <div key={candidate.groupFingerprint} className="book-connect__row">
                  <input
                    type="checkbox"
                    className="book-connect__check"
                    aria-label={`${candidate.title} ${volumeRange(candidate)} 함께 연결`}
                    checked={checked}
                    disabled={busy !== null || (!checked && selectedKeys.length >= MAX_GROUPS)}
                    onChange={() => { toggle(candidate.groupFingerprint); setError(null); }}
                  />
                  <button
                    type="button"
                    className="book-connect__result"
                    aria-pressed={checked}
                    disabled={busy !== null}
                    onClick={() => { setSelectedKeys([candidate.groupFingerprint]); setError(null); }}
                  >
                    <strong>{candidate.title}</strong>
                    <small>{[candidate.author, candidate.publisher, volumeSummary(candidate)].filter(Boolean).join(" · ")}</small>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="book-connect__preview" aria-label="선택한 시리즈 권 목록">
            {selected.length > 0 ? (
              selected.map((candidate) => (
                <section key={candidate.groupFingerprint} className="book-connect__preview-group">
                  <div className="book-connect__preview-header">
                    <strong>{candidate.title}</strong>
                    {selected.length > 1 && <small>{[candidate.publisher, volumeRange(candidate)].filter(Boolean).join(" · ")}</small>}
                    {candidate.ignoredCount > 0 && <small>제외된 상품 {candidate.ignoredCount}개</small>}
                  </div>
                  <ul>
                    {[...candidate.volumes].sort((left, right) => left.volumeNumber - right.volumeNumber).map((volume) => (
                      <li key={volume.providerItemId}>
                        <span>{volume.title}</span>
                        <small>{[volume.publicationDate, volume.isbn13].filter(Boolean).join(" · ") || "발매 정보 없음"}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            ) : (
              <p className="book-connect__empty">검색 결과에서 연결할 시리즈를 선택하세요.</p>
            )}
          </div>
        </div>

        <div className="ui-dialog__actions book-connect__actions">
          <span>
            {selected.length > 1
              ? `시리즈 ${selected.length}개를 함께 연결합니다. 같은 권은 한 번만 들어갑니다.`
              : "기존 작품명과 선택한 표지는 유지됩니다. 권이 나뉘어 나오면 체크해 함께 연결하세요."}
          </span>
          <Button type="button" disabled={busy !== null} onClick={close}>취소</Button>
          <Button type="button" variant="primary" disabled={selected.length === 0 || busy !== null} onClick={() => void apply()}>
            {busy === "apply" ? "연결 중…" : selected.length > 1 ? `${selected.length}개 연결` : "연결"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const MAX_GROUPS = 10;

function volumeRange(candidate: KakaoSeriesCandidate) {
  if (candidate.volumes.length === 0) return "0권";
  const numbers = candidate.volumes.map((volume) => volume.volumeNumber);
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  return `${first === last ? first : `${first}–${last}`}권`;
}

function volumeSummary(candidate: KakaoSeriesCandidate) {
  if (candidate.volumes.length === 0) return "0권";
  return `${volumeRange(candidate)} · ${candidate.volumes.length}권`;
}
