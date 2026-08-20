import { useState } from "react";
import { mangadexCoverPreviewUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionSummary, MangaDexSearchResult, MangaDexWorkPreview } from "../library/types";
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
  const [preview, setPreview] = useState<MangaDexWorkPreview | null>(null);
  const [name, setName] = useState("");
  const [coverId, setCoverId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"search" | "preview" | "apply" | null>(null);
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
      setResults(await gateway.searchMangaDex(trimmed));
    } catch (searchError) {
      setError(commandErrorMessage(searchError, "MangaDex에서 검색하지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  async function selectResult(result: MangaDexSearchResult) {
    setBusy("preview");
    setError(null);
    try {
      const next = await gateway.previewMangaDex(result.mangaId);
      setPreview(next);
      setName(next.proposedTitle);
      setCoverId(null);
    } catch (previewError) {
      setError(commandErrorMessage(previewError, "만화 정보를 불러오지 못했습니다."));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!preview || !coverId) return;
    const trimmedName = name.trim();
    if (target.kind === "new" && !trimmedName) {
      setError("컬렉션 이름을 입력해 주세요.");
      return;
    }
    setBusy("apply");
    setError(null);
    try {
      const collection = await gateway.applyMangaDex({
        target: target.kind === "new"
          ? { kind: "new", name: trimmedName }
          : { kind: "existing", collectionId: target.collection.id },
        mangaId: preview.mangaId,
        coverId,
      });
      await onApplied(collection);
      onClose();
    } catch (applyError) {
      setError(commandErrorMessage(applyError, "MangaDex 정보를 적용하지 못했습니다."));
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} title={target.kind === "new" ? "MangaDex에서 만화 추가" : "MangaDex 연결"} variant="wide" onClose={onClose}>
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
        {busy === "search" && <Skeleton className="mangadex-import__loading" label="검색 중" />}

        <div className="mangadex-import__workspace">
          <div className="mangadex-import__results" aria-label="검색 결과">
            {results.map((result) => (
              <button key={result.mangaId} type="button" className="mangadex-import__result" onClick={() => void selectResult(result)}>
                <span>{result.title}</span>
                <small>{[result.author, result.year].filter(Boolean).join(" · ")}</small>
              </button>
            ))}
          </div>

          <div className="mangadex-import__detail">
            {busy === "preview" && <Skeleton className="mangadex-import__loading" label="상세 정보 불러오는 중" />}
            {preview && (
              <>
                {target.kind === "new" && (
                  <TextField label="컬렉션 이름" value={name} onChange={(event) => { setName(event.target.value); setError(null); }} />
                )}
                <dl className="mangadex-import__metadata">
                  <div><dt>작가</dt><dd>{preview.author ?? "-"}</dd></div>
                  <div><dt>연도</dt><dd>{preview.year ?? "-"}</dd></div>
                  <div><dt>장르</dt><dd>{preview.genres ?? "-"}</dd></div>
                </dl>
                {preview.overview && <p className="mangadex-import__overview">{preview.overview}</p>}
                <div className="mangadex-import__covers" aria-label="표지 선택">
                  {preview.covers.map((cover) => (
                    <button
                      key={cover.coverId}
                      type="button"
                      className="mangadex-import__cover"
                      aria-label={`${cover.volume ?? "권 번호 없음"}권 표지`}
                      aria-pressed={coverId === cover.coverId}
                      onClick={() => { setCoverId(cover.coverId); setError(null); }}
                    >
                      <img src={mangadexCoverPreviewUrl(preview.mangaId, cover.fileName)} alt="" />
                      <span>{cover.volume ? `${cover.volume}권` : "권 번호 없음"}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="ui-dialog__actions mangadex-import__actions">
          <Button type="button" disabled={busy !== null} onClick={onClose}>취소</Button>
          <Button type="button" variant="primary" disabled={!preview || !coverId || busy !== null} onClick={() => void apply()}>
            {target.kind === "new" ? "추가" : "적용"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
