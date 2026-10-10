import { useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionSummary, MangaDexSearchResult } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Skeleton } from "../shared/ui/Skeleton";
import { TextField } from "../shared/ui/TextField";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { usePendingBindRecheck } from "./usePendingBindRecheck";

export type MangaDexImportTarget =
  | { kind: "new" }
  | { kind: "existing"; collection: CollectionSummary };

type Props = {
  open: boolean;
  target: MangaDexImportTarget;
  onClose: () => void;
  onApplied: (collection: CollectionSummary) => Promise<void> | void;
};

export function MangaDexImportDialog({ open, target, onClose, onApplied }: Props) {
  const { gateway } = useLibrary();
  // Connecting an existing manga starts from its 원제 (usually the Japanese title MangaDex knows).
  const [query, setQuery] = useState(() => target.kind === "existing" ? target.collection.originalTitle?.trim() ?? "" : "");
  const [results, setResults] = useState<MangaDexSearchResult[]>([]);
  const [selected, setSelected] = useState<MangaDexSearchResult | null>(null);
  const [busy, setBusy] = useState<"search" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const recheck = usePendingBindRecheck(open);
  const working = busy !== null || recheck.running;

  function close() {
    if (busy) return;
    recheck.cancel();
    onClose();
  }

  async function search() {
    if (working) return;
    recheck.cancel();
    const trimmed = query.trim();
    if (!trimmed) {
      setError("검색어를 입력해 주세요.");
      return;
    }
    setBusy("search");
    setError(null);
    try {
      const nextResults = target.kind === "existing"
        ? await gateway.searchMangaDex(trimmed, target.collection.id)
        : await gateway.searchMangaDex(trimmed);
      setResults(nextResults);
      setSelected(null);
      setPending(false);
    } catch (searchError) {
      setError(commandErrorMessage(searchError, "MangaDex에서 검색하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  function selectResult(result: MangaDexSearchResult) {
    if (working) return;
    recheck.cancel();
    setSelected(result);
    setError(null);
    setPending(false);
  }

  async function apply() {
    if (!selected || working) return;
    const request = {
      target: target.kind === "new"
        ? { kind: "new" as const, name: selected.title }
        : { kind: "existing" as const, collectionId: target.collection.id },
      mangaId: selected.mangaId,
      title: selected.title,
    };
    await recheck.run(async (background, isActive) => {
      if (!background) setBusy("apply");
      setError(null);
      try {
        const result = await gateway.applyMangaDex(request);
        if (!isActive()) return false;
        if ('outcome' in result) {
          if (result.outcome === 'pending') {
            setPending(true);
            return true;
          }
          setPending(false);
          if (result.outcome === 'failed' || result.outcome === 'superseded') {
            setError(result.message || '연결이 적용되지 않았습니다. 현재 연결을 확인하고 다시 선택해 주세요.');
            return false;
          }
          if (!result.collection) throw new Error('연결된 작품 정보를 확인하지 못했습니다. 다시 시도해 주세요.');
          await onApplied(result.collection);
        } else {
          setPending(false);
          await onApplied(result);
        }
        if (isActive()) onClose();
      } catch (applyError) {
        if (isActive()) {
          setPending(false);
          setError(commandErrorMessage(applyError, "MangaDex 정보를 적용하지 못했습니다."));
        }
      } finally {
        if (isActive()) setBusy(null);
      }
      return false;
    });
  }

  return (
    <Dialog open={open} title={target.kind === "new" ? "새 작품 추가" : "MangaDex 연결"} variant="medium" onClose={close}>
      <div className="mangadex-import">
        <div className="mangadex-import__search">
          <TextField
            label="만화 검색"
            type="search"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setError(null); }}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) void search(); }}
          />
          <Button type="button" disabled={working} onClick={() => void search()}>검색</Button>
        </div>

        {error && <p className="mangadex-import__error" role="alert">{error}</p>}
        {pending && <p role="status">연결 대기 · 서버에서 처리 중</p>}
        <p className="mangadex-import__provider-note">
          MangaDex에서 작품 정보를 검색합니다. 한국 정발 정보는 작품 생성 후 Kakao에 연결할 수 있습니다.
        </p>
        <BusyLabel busy={busy === "search"}>{results.length === 0 ? <Skeleton className="mangadex-import__loading" label="검색 중" /> : <p role="status">검색 중…</p>}</BusyLabel>

        <div className="mangadex-import__results" aria-label="검색 결과">
          {results.map((result) => (
            <button
              key={result.mangaId}
              type="button"
              disabled={working}
              className="mangadex-import__result"
              aria-pressed={selected?.mangaId === result.mangaId}
              onClick={() => selectResult(result)}
            >
              <span className="mangadex-import__result-title">{result.title}</span>
              <small>{[result.author, result.year].filter(Boolean).join(" · ")}</small>
              <span className="mangadex-import__result-provider">MangaDex</span>
            </button>
          ))}
        </div>

        <div className="ui-dialog__actions mangadex-import__actions">
          <span className="mangadex-import__hint">외부 정보는 로컬에 저장되며 사용자 수정값을 덮어쓰지 않습니다.</span>
          <Button type="button" disabled={busy !== null} onClick={close}>취소</Button>
          <Button type="button" variant="primary" disabled={!selected || working} onClick={() => void apply()}>
            {pending ? "연결 상태 확인" : target.kind === "new" ? "작품 만들기" : "연결"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
