import { useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionSummary, MangaDexSearchResult } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Skeleton } from "../shared/ui/Skeleton";
import { TextField } from "../shared/ui/TextField";

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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MangaDexSearchResult[]>([]);
  const [selected, setSelected] = useState<MangaDexSearchResult | null>(null);
  const [busy, setBusy] = useState<"search" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    const trimmed = query.trim();
    if (!trimmed) {
      setError("검색어를 입력해 주세요.");
      return;
    }
    setBusy("search");
    setError(null);
    try {
      const nextResults = await gateway.searchMangaDex(trimmed);
      setResults(nextResults);
      setSelected(null);
    } catch (searchError) {
      setError(commandErrorMessage(searchError, "MangaDex에서 검색하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  function selectResult(result: MangaDexSearchResult) {
    setSelected(result);
    setError(null);
  }

  async function apply() {
    if (!selected) return;
    setBusy("apply");
    setError(null);
    try {
      const collection = await gateway.applyMangaDex({
        target: target.kind === "new"
          ? { kind: "new", name: selected.title }
          : { kind: "existing", collectionId: target.collection.id },
        mangaId: selected.mangaId,
      });
      await onApplied(collection);
      onClose();
    } catch (applyError) {
      setError(commandErrorMessage(applyError, "MangaDex 정보를 적용하지 못했습니다."));
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} title={target.kind === "new" ? "새 작품 추가" : "MangaDex 연결"} variant="medium" onClose={onClose}>
      <div className="mangadex-import">
        <div className="mangadex-import__search">
          <TextField
            label="만화 검색"
            type="search"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setError(null); }}
            onKeyDown={(event) => { if (event.key === "Enter") void search(); }}
          />
          <Button type="button" disabled={busy !== null} onClick={() => void search()}>검색</Button>
        </div>

        {error && <p className="mangadex-import__error" role="alert">{error}</p>}
        <p className="mangadex-import__provider-note">
          MangaDex에서 작품 정보를 검색합니다. 한국 정발 정보는 작품 생성 후 Aladin에 연결할 수 있습니다.
        </p>
        {busy === "search" && <Skeleton className="mangadex-import__loading" label="검색 중" />}

        <div className="mangadex-import__results" aria-label="검색 결과">
          {results.map((result) => (
            <button
              key={result.mangaId}
              type="button"
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
          <Button type="button" disabled={busy !== null} onClick={onClose}>취소</Button>
          <Button type="button" variant="primary" disabled={!selected || busy !== null} onClick={() => void apply()}>
            {target.kind === "new" ? "작품 만들기" : "연결"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
