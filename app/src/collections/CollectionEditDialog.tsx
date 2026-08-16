import { useEffect, useState } from "react";
import type { CollectionSummary, CollectionType, CreateCollection, UpdateCollection } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Select } from "../shared/ui/Select";
import { TextField } from "../shared/ui/TextField";

export type CollectionEditMode =
  | { kind: "create" }
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
  const [type, setType] = useState<CollectionType>(existing?.type ?? "manga");
  const [year, setYear] = useState<number | null>(existing?.year ?? null);
  const [author, setAuthor] = useState(existing?.author ?? "");
  const [director, setDirector] = useState(existing?.director ?? "");
  const [externalScore, setExternalScore] = useState<number | null>(existing?.externalScore ?? null);
  const [myScore, setMyScore] = useState<number | null>(existing?.myScore ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(existing?.name ?? "");
    setDescription(existing?.description ?? "");
    setType(existing?.type ?? "manga");
    setYear(existing?.year ?? null);
    setAuthor(existing?.author ?? "");
    setDirector(existing?.director ?? "");
    setExternalScore(existing?.externalScore ?? null);
    setMyScore(existing?.myScore ?? null);
    setSaving(false);
    setError(null);
  }, [existing]);

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("이름을 입력해 주세요.");
      return;
    }
    const base: UpdateCollection = {
      name: trimmedName,
      description: description.trim() || null,
      type,
      year,
      author: author.trim() || null,
      director: director.trim() || null,
      externalScore,
      myScore,
      genres: null,
      overview: null,
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
        {type === "manga" && (
          <>
            <TextField label="작가" value={author} onChange={(event) => setAuthor(event.target.value)} />
            <TextField label="출간 연도" inputMode="numeric" value={year?.toString() ?? ""} onChange={(event) => setYear(event.target.value ? Number(event.target.value) : null)} />
          </>
        )}
        {type === "game" && (
          <>
            <TextField label="제작사" value={author} onChange={(event) => setAuthor(event.target.value)} />
            <TextField label="외부 점수" inputMode="numeric" value={externalScore?.toString() ?? ""} onChange={(event) => setExternalScore(event.target.value ? Number(event.target.value) : null)} />
            <TextField label="내 점수" inputMode="numeric" value={myScore?.toString() ?? ""} onChange={(event) => setMyScore(event.target.value ? Number(event.target.value) : null)} />
          </>
        )}
        {type === "movie" && (
          <>
            <TextField label="감독" value={director} onChange={(event) => setDirector(event.target.value)} />
            <TextField label="개봉 연도" inputMode="numeric" value={year?.toString() ?? ""} onChange={(event) => setYear(event.target.value ? Number(event.target.value) : null)} />
          </>
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
