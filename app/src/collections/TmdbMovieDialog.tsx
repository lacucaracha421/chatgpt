import { useEffect, useRef, useState } from "react";
import { tmdbImagePreviewUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionSummary, TmdbImageCandidate, TmdbMoviePreview, TmdbSearchResult } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Skeleton } from "../shared/ui/Skeleton";
import { TextField } from "../shared/ui/TextField";

export type TmdbMovieTarget =
  | { kind: "new" }
  | { kind: "existing"; collectionId: string };

export type TmdbMovieStep =
  | { kind: "search"; query: string; selectedMovieId: number | null }
  | {
      kind: "preview";
      preview: TmdbMoviePreview;
      posterPath: string | null;
      posterDecided: boolean;
      backdropPath: string | null;
      backdropDecided: boolean;
    };

type Props = {
  open: boolean;
  target: TmdbMovieTarget;
  onClose: () => void;
  onOpenSettings: () => void;
  onApplied: (collection: CollectionSummary) => Promise<void> | void;
};

type Busy = "search" | "preview" | "apply" | null;
type SearchStep = Extract<TmdbMovieStep, { kind: "search" }>;

export function TmdbMovieDialog({ open, target, onClose, onOpenSettings, onApplied }: Props) {
  const { gateway } = useLibrary();
  const [step, setStep] = useState<TmdbMovieStep>(newSearchStep);
  const [results, setResults] = useState<TmdbSearchResult[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState(false);
  const generation = useRef(0);
  const searchSnapshot = useRef<SearchStep>(newSearchStep());
  const targetCollectionId = target.kind === "existing" ? target.collectionId : undefined;

  useEffect(() => {
    generation.current += 1;
    if (!open) return;
    const next = newSearchStep();
    setStep(next);
    setResults([]);
    searchSnapshot.current = next;
    setBusy(null);
    setError(null);
    setCredentialError(false);
  }, [gateway, open, target.kind, targetCollectionId]);

  function updateSearch(update: Partial<SearchStep>) {
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
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    setBusy("search");
    setError(null);
    setCredentialError(false);
    try {
      const nextResults = await gateway.searchTmdbMovies(query);
      if (requestGeneration !== generation.current) return;
      setResults(nextResults);
      updateSearch({ selectedMovieId: null });
    } catch (searchError) {
      if (requestGeneration !== generation.current) return;
      showError(searchError, "TMDB에서 영화를 검색하지 못했습니다.", setError, setCredentialError);
    } finally {
      if (requestGeneration === generation.current) setBusy(null);
    }
  }

  async function previewSelected() {
    if (step.kind !== "search" || step.selectedMovieId === null) return;
    const movieId = step.selectedMovieId;
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    searchSnapshot.current = step;
    setBusy("preview");
    setError(null);
    setCredentialError(false);
    try {
      const preview = await gateway.previewTmdbMovie(movieId);
      if (requestGeneration !== generation.current) return;
      setStep({
        kind: "preview",
        preview,
        posterPath: null,
        posterDecided: preview.posters.length === 0,
        backdropPath: null,
        backdropDecided: preview.backdrops.length === 0,
      });
    } catch (previewError) {
      if (requestGeneration === generation.current) showError(previewError, "TMDB 영화 정보를 불러오지 못했습니다.", setError, setCredentialError);
    } finally {
      if (requestGeneration === generation.current) setBusy(null);
    }
  }

  function back() {
    if (step.kind !== "preview") return;
    generation.current += 1;
    setStep(searchSnapshot.current);
    setError(null);
    setCredentialError(false);
  }

  async function apply() {
    if (step.kind !== "preview" || !step.posterDecided || !step.backdropDecided) return;
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    setBusy("apply");
    setError(null);
    setCredentialError(false);
    try {
      const collection = await gateway.applyTmdbMovie({
        target,
        movieId: step.preview.movieId,
        posterPath: step.posterPath,
        backdropPath: step.backdropPath,
      });
      onClose();
      void Promise.resolve().then(() => onApplied(collection)).catch(() => undefined);
    } catch (applyError) {
      if (requestGeneration === generation.current) showError(applyError, target.kind === "new" ? "TMDB 영화를 가져오지 못했습니다." : "TMDB 정보를 연결하지 못했습니다.", setError, setCredentialError);
    } finally {
      if (requestGeneration === generation.current) setBusy(null);
    }
  }

  function handleClose() {
    if (busy === "apply") return;
    generation.current += 1;
    onClose();
  }

  const title = target.kind === "new" ? "TMDB에서 영화 추가" : "TMDB 영화 연결";
  const searchStep = step.kind === "search" ? step : null;
  const previewStep = step.kind === "preview" ? step : null;

  return (
    <Dialog open={open} title={title} variant="wide" onClose={handleClose}>
      <div className="tmdb-movie-dialog">
        {error && <div className="tmdb-movie-dialog__error" role="alert"><p>{error}</p>{credentialError && <Button type="button" onClick={onOpenSettings}>TMDB 설정 열기</Button>}</div>}
        {busy === "search" && <Skeleton className="tmdb-movie-dialog__loading" label="영화 검색 중" />}
        {searchStep && <SearchStep step={searchStep} results={results} busy={busy} onQuery={(query) => { updateSearch({ query }); setError(null); }} onSearch={() => void search()} onSelect={(movieId) => { updateSearch({ selectedMovieId: movieId }); setError(null); setCredentialError(false); }} />}
        {previewStep && <>
          <PreviewSummary preview={previewStep.preview} />
          <ArtworkStep kind="poster" candidates={previewStep.preview.posters} selectedPath={previewStep.posterPath} decided={previewStep.posterDecided} onSelect={(filePath) => setStep((current) => current.kind === "preview" ? { ...current, posterPath: filePath, posterDecided: true } : current)} onClear={() => setStep((current) => current.kind === "preview" ? { ...current, posterPath: null, posterDecided: true } : current)} />
          <ArtworkStep kind="backdrop" candidates={previewStep.preview.backdrops} selectedPath={previewStep.backdropPath} decided={previewStep.backdropDecided} onSelect={(filePath) => setStep((current) => current.kind === "preview" ? { ...current, backdropPath: filePath, backdropDecided: true } : current)} onClear={() => setStep((current) => current.kind === "preview" ? { ...current, backdropPath: null, backdropDecided: true } : current)} />
        </>}
        <div className="ui-dialog__actions tmdb-movie-dialog__actions">
          <Button type="button" disabled={busy === "apply"} onClick={handleClose}>취소</Button>
          {previewStep && <Button type="button" disabled={busy !== null} onClick={back}>뒤로</Button>}
          {searchStep && <Button type="button" variant="primary" disabled={searchStep.selectedMovieId === null || busy !== null} onClick={() => void previewSelected()}>{busy === "preview" ? "불러오는 중…" : "다음"}</Button>}
          {previewStep && <Button type="button" variant="primary" disabled={busy !== null || !previewStep.posterDecided || !previewStep.backdropDecided} onClick={() => void apply()}>{target.kind === "new" ? "가져오기" : "저장"}</Button>}
        </div>
      </div>
    </Dialog>
  );
}

function SearchStep({ step, results, busy, onQuery, onSearch, onSelect }: { step: SearchStep; results: TmdbSearchResult[]; busy: Busy; onQuery: (query: string) => void; onSearch: () => void; onSelect: (movieId: number) => void }) {
  return <>
    <div className="tmdb-movie-dialog__search">
      <TextField label="영화 검색" type="search" value={step.query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} />
      <Button type="button" disabled={busy !== null} onClick={onSearch}>검색</Button>
    </div>
    <div className="tmdb-movie-dialog__results" aria-label="TMDB 검색 결과">
      {results.map((result) => <button key={result.movieId} type="button" className="tmdb-movie-dialog__result" aria-pressed={step.selectedMovieId === result.movieId} onClick={() => onSelect(result.movieId)}>
        {result.posterPath && <img src={tmdbImagePreviewUrl(result.posterPath, "poster")} alt={`${result.title} 포스터`} />}
        <span className="tmdb-movie-dialog__result-title">{result.title}</span>
        {result.originalTitle && result.originalTitle !== result.title && <small>{result.originalTitle}</small>}
        <small>{result.releaseDate ?? "개봉일 정보 없음"}</small>
      </button>)}
    </div>
  </>;
}

function PreviewSummary({ preview }: { preview: TmdbMoviePreview }) {
  return <div className="tmdb-movie-dialog__summary">
    <strong>{preview.proposedTitle}</strong>
    {preview.originalTitle && preview.originalTitle !== preview.proposedTitle && <span>{preview.originalTitle}</span>}
    <small>{[preview.releaseDate, preview.runtimeMinutes ? `${preview.runtimeMinutes}분` : null, preview.director].filter(Boolean).join(" · ") || "영화 정보 없음"}</small>
    {preview.overview && <p>{preview.overview}</p>}
  </div>;
}

function ArtworkStep({ kind, candidates, selectedPath, decided, onSelect, onClear }: { kind: "poster" | "backdrop"; candidates: TmdbImageCandidate[]; selectedPath: string | null; decided: boolean; onSelect: (filePath: string) => void; onClear: () => void }) {
  const label = kind === "poster" ? "포스터" : "배경";
  return <section className="tmdb-movie-dialog__artwork" aria-label={`${label} 선택`}>
    <div className="tmdb-movie-dialog__artwork-heading"><h3>{label} 선택</h3><Button type="button" size="sm" aria-pressed={decided && selectedPath === null} onClick={onClear}>{label} 없이 가져오기</Button></div>
    {candidates.length === 0 ? <p className="tmdb-movie-dialog__muted">사용 가능한 이미지가 없습니다.</p> : <div className="tmdb-movie-dialog__candidates">
      {candidates.map((candidate, index) => <label key={candidate.filePath} className="tmdb-movie-dialog__candidate">
        <input type="radio" name={kind} value={candidate.filePath} checked={selectedPath === candidate.filePath} aria-label={`${label} ${index + 1} (${candidate.filePath})`} onChange={() => onSelect(candidate.filePath)} />
        <img src={tmdbImagePreviewUrl(candidate.filePath, kind)} alt={`${label} ${index + 1}`} />
      </label>)}
    </div>}
  </section>;
}

function showError(error: unknown, fallback: string, setError: (message: string) => void, setCredentialError: (value: boolean) => void) {
  const nextError = errorInfo(error, fallback);
  setCredentialError(nextError.credentialError);
  setError(nextError.message);
}

function errorInfo(error: unknown, fallback: string): { message: string; credentialError: boolean } {
  if (errorCode(error) === "tmdb_credential_not_configured") return { message: "TMDB 설정이 필요합니다.", credentialError: true };
  return { message: commandErrorMessage(error, fallback), credentialError: false };
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

function newSearchStep(): SearchStep {
  return { kind: "search", query: "", selectedMovieId: null };
}
