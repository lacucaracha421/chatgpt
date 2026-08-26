import { useEffect, useState } from "react";
import { igdbImagePreviewUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionSummary, IgdbGamePreview, IgdbImageCandidate, IgdbSearchResult } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Skeleton } from "../shared/ui/Skeleton";
import { TextField } from "../shared/ui/TextField";

export type IgdbImportTarget =
  | { kind: "new" }
  | { kind: "existing"; collectionId: string };

export type IgdbImportStep =
  | { kind: "search"; query: string; results: IgdbSearchResult[]; selectedGameId: number | null }
  | { kind: "cover"; preview: IgdbGamePreview; coverImageId: string | null; coverDecisionMade: boolean }
  | { kind: "hero"; preview: IgdbGamePreview; coverImageId: string | null; heroImageId: string | null; heroDecisionMade: boolean };

type Props = {
  open: boolean;
  target: IgdbImportTarget;
  onClose: () => void;
  onApplied: (collection: CollectionSummary) => Promise<void> | void;
  onOpenSettings: () => void;
};

type Busy = "search" | "preview" | "apply" | null;

export function IgdbImportDialog({ open, target, onClose, onApplied, onOpenSettings }: Props) {
  const { gateway } = useLibrary();
  const [step, setStep] = useState<IgdbImportStep>({ kind: "search", query: "", results: [], selectedGameId: null });
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep({ kind: "search", query: "", results: [], selectedGameId: null });
    setBusy(null);
    setError(null);
    setCredentialError(false);
    if (target.kind !== "existing") return;

    let active = true;
    setBusy("preview");
    void gateway.getIgdbConnection(target.collectionId)
      .then((connection) => {
        if (!connection) throw new Error("IGDB 연결을 찾지 못했습니다.");
        return gateway.previewIgdbGame(connection.gameId);
      })
      .then((preview) => {
        if (!active) return;
        setStep({ kind: "cover", preview, coverImageId: null, coverDecisionMade: false });
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        showError(loadError, "IGDB 게임 정보를 불러오지 못했습니다.", setError, setCredentialError);
      })
      .finally(() => { if (active) setBusy(null); });
    return () => { active = false; };
  }, [gateway, open, target.collectionId, target.kind]);

  function updateSearch(update: Partial<Extract<IgdbImportStep, { kind: "search" }>>) {
    setStep((current) => current.kind === "search" ? { ...current, ...update } : current);
  }

  async function search() {
    if (step.kind !== "search") return;
    const query = step.query.trim();
    if (!query) {
      setError("검색어를 입력해 주세요.");
      setCredentialError(false);
      return;
    }
    setBusy("search");
    setError(null);
    setCredentialError(false);
    try {
      const results = await gateway.searchIgdbGames(query);
      setStep((current) => current.kind === "search" ? { ...current, results, selectedGameId: null } : current);
    } catch (searchError) {
      showError(searchError, "IGDB에서 검색하지 못했습니다.", setError, setCredentialError);
    } finally {
      setBusy(null);
    }
  }

  async function previewSelected() {
    if (step.kind !== "search" || step.selectedGameId === null) return;
    setBusy("preview");
    setError(null);
    setCredentialError(false);
    try {
      const preview = await gateway.previewIgdbGame(step.selectedGameId);
      setStep({ kind: "cover", preview, coverImageId: null, coverDecisionMade: false });
    } catch (previewError) {
      showError(previewError, "IGDB 게임 정보를 불러오지 못했습니다.", setError, setCredentialError);
    } finally {
      setBusy(null);
    }
  }

  function nextFromCover() {
    if (step.kind !== "cover") return;
    if (target.kind === "new" && step.preview.covers.length > 0 && !step.coverDecisionMade) return;
    setStep({
      kind: "hero",
      preview: step.preview,
      coverImageId: step.coverImageId,
      heroImageId: null,
      heroDecisionMade: false,
    });
    setError(null);
  }

  function back() {
    if (step.kind === "hero") {
      setStep({ kind: "cover", preview: step.preview, coverImageId: step.coverImageId, coverDecisionMade: step.coverImageId !== null });
    } else if (step.kind === "cover" && target.kind === "new") {
      setStep({ kind: "search", query: step.preview.proposedTitle, results: [], selectedGameId: step.preview.gameId });
    }
    setError(null);
    setCredentialError(false);
  }

  async function apply() {
    if (step.kind !== "hero") return;
    if (target.kind === "new" && !step.heroDecisionMade) return;
    setBusy("apply");
    setError(null);
    setCredentialError(false);
    try {
      const collection = target.kind === "new"
        ? await gateway.applyIgdbGame({ gameId: step.preview.gameId, coverImageId: step.coverImageId, heroImageId: step.heroImageId })
        : await gateway.replaceIgdbGameArtwork({
          collectionId: target.collectionId,
          cover: step.coverImageId ? { kind: "select", imageId: step.coverImageId } : { kind: "keep" },
          hero: step.heroDecisionMade
            ? step.heroImageId ? { kind: "select", imageId: step.heroImageId } : { kind: "clear" }
            : { kind: "keep" },
        });
      await onApplied(collection);
      onClose();
    } catch (applyError) {
      showError(applyError, target.kind === "new" ? "IGDB 게임을 가져오지 못했습니다." : "IGDB 아트워크를 저장하지 못했습니다.", setError, setCredentialError);
    } finally {
      setBusy(null);
    }
  }

  const title = target.kind === "new" ? "IGDB에서 게임 추가" : "IGDB 게임 아트워크 변경";
  const preview = step.kind === "cover" || step.kind === "hero" ? step.preview : null;
  const candidates = step.kind === "cover" ? step.preview.covers : step.kind === "hero" ? (step.preview.artworks.length > 0 ? step.preview.artworks : step.preview.screenshots) : [];
  const loadingExisting = target.kind === "existing" && busy === "preview" && !preview;

  return (
    <Dialog open={open} title={title} variant="medium" onClose={onClose}>
      <div className="igdb-import">
        {loadingExisting && <Skeleton className="igdb-import__loading" label="IGDB 게임 정보 불러오는 중" />}
        {error && <div className="igdb-import__error" role="alert"><p>{error}</p>{credentialError && <Button type="button" onClick={onOpenSettings}>IGDB 설정 열기</Button>}</div>}
        {!loadingExisting && step.kind === "search" && <SearchStep step={step} busy={busy} onQuery={(query) => updateSearch({ query })} onSearch={() => void search()} onSelect={(selectedGameId) => { updateSearch({ selectedGameId }); setError(null); setCredentialError(false); }} />}
        {!loadingExisting && preview && <PreviewSummary preview={preview} />}
        {!loadingExisting && step.kind === "cover" && <ArtworkStep kind="cover" candidates={candidates} selectedId={step.coverImageId} onSelect={(imageId) => setStep({ ...step, coverImageId: imageId, coverDecisionMade: true })} />}
        {!loadingExisting && step.kind === "hero" && <ArtworkStep kind="hero" candidates={candidates} selectedId={step.heroImageId} onSelect={(imageId) => setStep({ ...step, heroImageId: imageId, heroDecisionMade: true })} />}
        {!loadingExisting && <div className="ui-dialog__actions igdb-import__actions">
          <Button type="button" onClick={onClose}>취소</Button>
          {step.kind !== "search" && <Button type="button" onClick={back} disabled={busy !== null}>뒤로</Button>}
          {step.kind === "search" && <Button type="button" variant="primary" disabled={step.selectedGameId === null || busy !== null} onClick={() => void previewSelected()}>{busy === "preview" ? "불러오는 중" : "다음"}</Button>}
          {step.kind === "cover" && <Button type="button" variant="primary" disabled={busy !== null || (target.kind === "new" && step.preview.covers.length > 0 && !step.coverDecisionMade)} onClick={nextFromCover}>다음</Button>}
          {step.kind === "hero" && <>
            <Button type="button" aria-pressed={step.heroDecisionMade && step.heroImageId === null} onClick={() => setStep({ ...step, heroImageId: null, heroDecisionMade: true })}>hero 없이 가져오기</Button>
            <Button type="button" variant="primary" disabled={busy !== null || (target.kind === "new" && !step.heroDecisionMade)} onClick={() => void apply()}>{target.kind === "new" ? "가져오기" : "저장"}</Button>
          </>}
        </div>}
      </div>
    </Dialog>
  );
}

function SearchStep({ step, busy, onQuery, onSearch, onSelect }: { step: Extract<IgdbImportStep, { kind: "search" }>; busy: Busy; onQuery: (query: string) => void; onSearch: () => void; onSelect: (gameId: number) => void }) {
  return <>
    <div className="igdb-import__search">
      <TextField label="게임 검색" type="search" value={step.query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} />
      <Button type="button" disabled={busy !== null} onClick={onSearch}>검색</Button>
    </div>
    <div className="igdb-import__results" aria-label="IGDB 검색 결과">
      {step.results.map((result) => <button key={result.gameId} type="button" className="igdb-import__result" aria-pressed={step.selectedGameId === result.gameId} onClick={() => onSelect(result.gameId)}>
        {result.cover && <img src={igdbImagePreviewUrl(result.cover.imageId, "cover")} alt={`${result.title} 표지`} />}
        <span className="igdb-import__result-title">{result.title}</span>
        <small>{[result.releaseDate, result.developer].filter(Boolean).join(" · ")}</small>
      </button>)}
    </div>
  </>;
}

function PreviewSummary({ preview }: { preview: IgdbGamePreview }) {
  return <div className="igdb-import__summary"><strong>{preview.proposedTitle}</strong><span>{[preview.releaseDate, preview.developer].filter(Boolean).join(" · ") || "발매일·개발사 정보 없음"}</span></div>;
}

function ArtworkStep({ kind, candidates, selectedId, onSelect }: { kind: "cover" | "hero"; candidates: IgdbImageCandidate[]; selectedId: string | null; onSelect: (imageId: string) => void }) {
  return <section className="igdb-import__artwork" aria-label={kind === "cover" ? "표지 선택" : "대표 이미지 선택"}>
    <h3>{kind === "cover" ? "표지 선택" : "대표 이미지 선택"}</h3>
    {candidates.length === 0 ? <p className="igdb-import__muted">사용 가능한 이미지가 없습니다.</p> : <div className="igdb-import__candidates">
      {candidates.map((candidate, index) => <label key={candidate.imageId} className="igdb-import__candidate">
        <input type="radio" name={kind} value={candidate.imageId} checked={selectedId === candidate.imageId} aria-label={`${kind === "cover" ? "표지" : "대표 이미지"} ${index + 1} (${candidate.imageId})`} onChange={() => onSelect(candidate.imageId)} />
        <img src={igdbImagePreviewUrl(candidate.imageId, kind === "cover" ? "cover" : "hero")} alt={`${kind === "cover" ? "표지" : "대표 이미지"} ${index + 1}`} />
      </label>)}
    </div>}
  </section>;
}

function showError(error: unknown, fallback: string, setError: (message: string) => void, setCredentialError: (value: boolean) => void) {
  if (errorCode(error) === "igdb_credential_not_configured") {
    setCredentialError(true);
    setError("IGDB 설정이 필요합니다.");
    return;
  }
  setCredentialError(false);
  setError(commandErrorMessage(error, fallback));
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  if (typeof error !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(error);
    return errorCode(parsed);
  } catch {
    return null;
  }
}
