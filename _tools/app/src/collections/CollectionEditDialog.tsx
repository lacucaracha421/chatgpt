import { useEffect, useState } from "react";
import type { CollectionSummary, CollectionType, CollectionVolumeRangeInput, CreateCollection, UpdateCollection } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Select } from "../shared/ui/Select";
import { TextField } from "../shared/ui/TextField";
import { COLLECTION_CREATE_TYPES, COLLECTION_EDIT_FIELDS, COLLECTION_EDIT_INPUT, COLLECTION_NAME_REQUIRED, collectionCreateLabel, collectionEditDraft,
  collectionEditError, collectionEditField, collectionEditValues, type CollectionEditFieldKey } from "./collectionEditFields";

export type CollectionEditMode =
  | { kind: "create"; type: CollectionType }
  | { kind: "edit"; collection: CollectionSummary };

export function CollectionEditDialog({
  open,
  mode,
  onClose,
  onSubmit,
  onSubmitMangaSettings,
}: {
  open: boolean;
  mode: CollectionEditMode;
  onClose: () => void;
  onSubmit: (input: CreateCollection | UpdateCollection, mediaType?: "movie" | "tv") => Promise<void>;
  onSubmitMangaSettings?: (input: CollectionVolumeRangeInput) => Promise<void>;
}) {
  const existing = mode.kind === "edit" ? mode.collection : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [type, setType] = useState<CollectionType>(mode.kind === "create" ? mode.type : existing?.type ?? "manga");
  const [series, setSeries] = useState(false);
  const [fields, setFields] = useState(() => collectionEditDraft(existing));
  const [myScore, setMyScore] = useState<number | null>(existing?.myScore ?? null);
  const [minVolume, setMinVolume] = useState<number | null>(existing?.minVolume ?? null);
  const [maxVolume, setMaxVolume] = useState<number | null>(existing?.maxVolume ?? null);
  const [hideConnectionPrompt, setHideConnectionPrompt] = useState(existing?.hideConnectionPrompt ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(existing?.name ?? "");
    setDescription(existing?.description ?? "");
    setType(mode.kind === "create" ? mode.type : existing?.type ?? "manga");
    setSeries(false);
    setFields(collectionEditDraft(existing));
    setMyScore(existing?.myScore ?? null);
    setMinVolume(existing?.minVolume ?? null);
    setMaxVolume(existing?.maxVolume ?? null);
    setHideConnectionPrompt(existing?.hideConnectionPrompt ?? false);
    setSaving(false);
    setError(null);
  }, [existing, mode]);

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(COLLECTION_NAME_REQUIRED);
      return;
    }
    const runtimeError = collectionEditError(collectionEditField("runtimeMinutes"), fields.runtimeMinutes);
    if (runtimeError) {
      setError(runtimeError);
      return;
    }
    if (type === "manga" && (
      (minVolume !== null && (!Number.isInteger(minVolume) || minVolume < 0 || minVolume > 9999))
      || (maxVolume !== null && (!Number.isInteger(maxVolume) || maxVolume < 0 || maxVolume > 9999))
    )) {
      setError("권 범위는 0부터 9999까지 입력할 수 있습니다.");
      return;
    }
    if (type === "manga" && minVolume !== null && maxVolume !== null && minVolume > maxVolume) {
      setError("처음 권은 마지막 권보다 클 수 없습니다.");
      return;
    }
    const base: UpdateCollection = {
      name: trimmedName,
      description: description.trim() || null,
      type,
      ...collectionEditValues(fields) as Pick<UpdateCollection, CollectionEditFieldKey>,
      myScore,
      // Only fields changed from what the dialog loaded are written (mobile edits may
      // have changed the others meanwhile).
      ...(existing ? { personalBase: { myScore: existing.myScore ?? null, description: existing.description ?? null } } : {}),
    };
    setSaving(true);
    setError(null);
    try {
      if (mode.kind === "create") {
        const input = { name: base.name, description: base.description, type: base.type };
        if (type === "movie") await onSubmit(input, series ? "tv" : "movie");
        else await onSubmit(input);
      } else {
        await onSubmit(base);
        if (type === "manga" && onSubmitMangaSettings) {
          await onSubmitMangaSettings({ minVolume, maxVolume, hideConnectionPrompt });
        }
      }
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
        {mode.kind === "create" ? <div role="group" aria-label="유형" className="collection-edit-dialog__types">
          {COLLECTION_CREATE_TYPES.map(value => (
            <Button key={value} type="button" aria-pressed={value === "tv" ? type === "movie" && series : type === value && !series}
              variant={(value === "tv" ? type === "movie" && series : type === value && !series) ? "primary" : "secondary"}
              disabled={saving} onClick={() => { setType(value === "tv" ? "movie" : value); setSeries(value === "tv"); }}>
              {collectionCreateLabel(value)}
            </Button>
          ))}
        </div> : <Select label="유형" value={type} disabled={existing?.type === "av"} onChange={(event) => setType(event.target.value as CollectionType)}>
          <option value="game">게임</option>
          <option value="manga">만화</option>
          <option value="movie">영화</option>
          {existing?.type === "av" && <option value="av">AV</option>}
        </Select>}
        {mode.kind === "edit" && COLLECTION_EDIT_FIELDS[type].map(field => (
          <TextField key={field.key} label={field.label} {...COLLECTION_EDIT_INPUT[field.control]} value={fields[field.key]}
            onChange={(event) => { const value = event.target.value; setFields(current => ({ ...current, [field.key]: value })); if (field.control === "minutes") setError(null); }} />
        ))}
        {mode.kind === "edit" && type === "manga" && (
          <fieldset className="collection-edit-dialog__volume-range">
            <legend>권 범위</legend>
            <div className="collection-edit-dialog__volume-range-fields">
              <TextField label="처음 권" type="number" min="0" max="9999" step="1" placeholder="처음" value={minVolume?.toString() ?? ""}
                onChange={(event) => { setMinVolume(event.target.value === "" ? null : Number(event.target.value)); setError(null); }} />
              <TextField label="마지막 권" type="number" min="0" max="9999" step="1" placeholder="끝" value={maxVolume?.toString() ?? ""}
                onChange={(event) => { setMaxVolume(event.target.value === "" ? null : Number(event.target.value)); setError(null); }} />
            </div>
            <p className="collection-edit-dialog__volume-range-help">이 범위 밖의 권은 PC와 태블릿에서 모두 숨겨요. 같은 시리즈를 1부·2부로 나눠 둘 때 써요.</p>
            <label className="collection-edit-dialog__volume-range-check">
              <input type="checkbox" checked={hideConnectionPrompt} onChange={(event) => setHideConnectionPrompt(event.target.checked)} />
              카카오 연결 안내 숨기기
            </label>
          </fieldset>
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
