import { useEffect, useState } from "react";
import type { CollectionSummary, CollectionType, CreateCollection, UpdateCollection } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Select } from "../shared/ui/Select";
import { TextField } from "../shared/ui/TextField";

export type CollectionEditMode =
  | { kind: "create"; type: CollectionType }
  | { kind: "edit"; collection: CollectionSummary };

export function CollectionEditDialog({
  open,
  mode,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: CollectionEditMode;
  onClose: () => void;
  onSubmit: (input: CreateCollection | UpdateCollection) => Promise<void>;
}) {
  const existing = mode.kind === "edit" ? mode.collection : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [type, setType] = useState<CollectionType>(mode.kind === "create" ? mode.type : existing?.type ?? "manga");
  const [year, setYear] = useState<number | null>(existing?.year ?? null);
  const [originalTitle, setOriginalTitle] = useState(existing?.originalTitle ?? "");
  const [runtimeMinutes, setRuntimeMinutes] = useState<number | null>(existing?.runtimeMinutes ?? null);
  const [author, setAuthor] = useState(existing?.author ?? "");
  const [developer, setDeveloper] = useState(existing?.developer ?? "");
  const [publisher, setPublisher] = useState(existing?.publisher ?? "");
  const [platforms, setPlatforms] = useState(existing?.platforms ?? "");
  const [productionCompany, setProductionCompany] = useState(existing?.productionCompany ?? "");
  const [releaseDate, setReleaseDate] = useState<string | null>(existing?.releaseDate ?? null);
  const [director, setDirector] = useState(existing?.director ?? "");
  const [externalScore, setExternalScore] = useState<number | null>(existing?.externalScore ?? null);
  const [myScore, setMyScore] = useState<number | null>(existing?.myScore ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(existing?.name ?? "");
    setDescription(existing?.description ?? "");
    setType(mode.kind === "create" ? mode.type : existing?.type ?? "manga");
    setYear(existing?.year ?? null);
    setOriginalTitle(existing?.originalTitle ?? "");
    setRuntimeMinutes(existing?.runtimeMinutes ?? null);
    setAuthor(existing?.author ?? "");
    setDeveloper(existing?.developer ?? "");
    setPublisher(existing?.publisher ?? "");
    setPlatforms(existing?.platforms ?? "");
    setProductionCompany(existing?.productionCompany ?? "");
    setReleaseDate(existing?.releaseDate ?? null);
    setDirector(existing?.director ?? "");
    setExternalScore(existing?.externalScore ?? null);
    setMyScore(existing?.myScore ?? null);
    setSaving(false);
    setError(null);
  }, [existing, mode]);

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("이름을 입력해 주세요.");
      return;
    }
    if (runtimeMinutes !== null && (!Number.isInteger(runtimeMinutes) || runtimeMinutes <= 0)) {
      setError("상영 시간은 1분 이상이어야 합니다.");
      return;
    }
    const base: UpdateCollection = {
      name: trimmedName,
      description: description.trim() || null,
      type,
      year,
      originalTitle: originalTitle.trim() || null,
      runtimeMinutes,
      author: author.trim() || null,
      developer: developer.trim() || null,
      publisher: publisher.trim() || null,
      platforms: platforms.trim() || null,
      productionCompany: productionCompany.trim() || null,
      releaseDate,
      director: director.trim() || null,
      externalScore,
      myScore,
    };
    setSaving(true);
    setError(null);
    try {
      await onSubmit(
        mode.kind === "create"
          ? { name: base.name, description: base.description, type: base.type }
          : base,
      );
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "저장하지 못했습니다.");
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} title={mode.kind === "create" ? "새 컬렉션" : "컬렉션 편집"} onClose={onClose}>
      <div className="collection-edit-dialog">
        <TextField label="이름" value={name} onChange={(event) => { setName(event.target.value); setError(null); }} />
        <TextField label="설명" value={description} onChange={(event) => setDescription(event.target.value)} />
        <Select label="유형" value={type} onChange={(event) => setType(event.target.value as CollectionType)}>
          <option value="game">게임</option>
          <option value="manga">만화</option>
          <option value="movie">영화</option>
        </Select>
        {mode.kind === "edit" && type === "manga" && (
          <>
            <TextField label="작가" value={author} onChange={(event) => setAuthor(event.target.value)} />
            <TextField label="출간 연도" inputMode="numeric" value={year?.toString() ?? ""} onChange={(event) => setYear(event.target.value ? Number(event.target.value) : null)} />
          </>
        )}
        {mode.kind === "edit" && type === "game" && (
          <>
            {mode.kind === "edit" && <TextField label="개발사" value={developer} onChange={(event) => setDeveloper(event.target.value)} />}
            <TextField label="퍼블리셔" value={publisher} onChange={(event) => setPublisher(event.target.value)} />
            <TextField label="플랫폼" value={platforms} onChange={(event) => setPlatforms(event.target.value)} />
            <TextField label="출시일" type="date" value={releaseDate ?? ""} onChange={(event) => setReleaseDate(event.target.value || null)} />
            <TextField label="외부 점수" inputMode="numeric" value={externalScore?.toString() ?? ""} onChange={(event) => setExternalScore(event.target.value ? Number(event.target.value) : null)} />
          </>
        )}
        {mode.kind === "edit" && type === "movie" && (
          <>
            <TextField label="원제" value={originalTitle} onChange={(event) => setOriginalTitle(event.target.value)} />
            <TextField label="상영 시간(분)" type="number" min="1" step="1" value={runtimeMinutes?.toString() ?? ""} onChange={(event) => { setRuntimeMinutes(event.target.value ? Number(event.target.value) : null); setError(null); }} />
            {mode.kind === "edit" && <TextField label="제작사" value={productionCompany} onChange={(event) => setProductionCompany(event.target.value)} />}
            <TextField label="감독" value={director} onChange={(event) => setDirector(event.target.value)} />
            <TextField label="개봉 연도" inputMode="numeric" value={year?.toString() ?? ""} onChange={(event) => setYear(event.target.value ? Number(event.target.value) : null)} />
          </>
        )}
        {mode.kind === "edit" && (
          <Select label="내 별점" value={myScore?.toString() ?? ""} onChange={(event) => setMyScore(event.target.value === "" ? null : Number(event.target.value))}>
            <option value="">미평가</option>
            {[5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0].map((rating) => <option key={rating} value={rating}>{rating.toFixed(1)}</option>)}
          </Select>
        )}
        {error && <p className="collection-edit-dialog__error" role="alert">{error}</p>}
        <div className="ui-dialog__actions">
          <Button type="button" disabled={saving} onClick={onClose}>취소</Button>
          <Button type="button" variant="primary" disabled={saving} onClick={() => void handleSubmit()}>저장</Button>
        </div>
      </div>
    </Dialog>
  );
}
