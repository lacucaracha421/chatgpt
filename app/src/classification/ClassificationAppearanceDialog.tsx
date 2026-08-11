import { useEffect, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { useLibrary } from "../library/LibraryContext";
import type { ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import {
  CLASSIFICATION_COLORS,
  CLASSIFICATION_ICONS,
  ClassificationIcon,
  classificationColor,
} from "./classificationAppearance";

type ClassificationAppearanceDialogProps = {
  entry: ClassificationEntry | null;
  onClose: () => void;
  onSaved: () => void;
};

export function ClassificationAppearanceDialog({
  entry,
  onClose,
  onSaved,
}: ClassificationAppearanceDialogProps) {
  const { gateway } = useLibrary();
  const [iconKey, setIconKey] = useState<string | null>(entry?.iconKey ?? null);
  const [colorKey, setColorKey] = useState<string | null>(entry?.colorKey ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIconKey(entry?.iconKey ?? null);
    setColorKey(entry?.colorKey ?? null);
    setSaving(false);
    setError(null);
  }, [entry]);

  if (!entry) return null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await gateway.updateClassificationAppearance(entry!.id, iconKey, colorKey);
      onSaved();
    } catch (saveError) {
      setError(commandErrorMessage(saveError, "폴더 모양을 저장하지 못했습니다."));
      setSaving(false);
    }
  }

  return (
    <Dialog open title="아이콘 및 색상" onClose={onClose}>
      <div className="classification-appearance">
        <div
          className="classification-appearance__preview"
          data-testid="classification-appearance-preview"
        >
          <ClassificationIcon
            kind={entry.kind}
            iconKey={iconKey}
            style={{ color: classificationColor(colorKey) }}
          />
          <span>{entry.name}</span>
        </div>

        <fieldset className="classification-appearance__fieldset" disabled={saving}>
          <legend>아이콘</legend>
          <div className="classification-appearance__grid">
            {CLASSIFICATION_ICONS.map(({ key, label, icon: Icon }) => (
              <label className="classification-appearance__choice" key={key} title={label}>
                <input
                  type="radio"
                  name="classification-icon"
                  value={key}
                  checked={iconKey === key}
                  onChange={() => setIconKey(key)}
                  aria-label={label}
                />
                <Icon aria-hidden="true" />
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="classification-appearance__fieldset" disabled={saving}>
          <legend>색상</legend>
          <div className="classification-appearance__grid classification-appearance__colors">
            {CLASSIFICATION_COLORS.map(({ key, label, value }) => (
              <label className="classification-appearance__choice" key={key} title={label}>
                <input
                  type="radio"
                  name="classification-color"
                  value={key}
                  checked={colorKey === key}
                  onChange={() => setColorKey(key)}
                  aria-label={label}
                />
                <span className="classification-appearance__swatch" style={{ backgroundColor: value }} aria-hidden="true" />
              </label>
            ))}
          </div>
        </fieldset>

        {error && <p className="classification-appearance__error" role="alert">{error}</p>}
        <div className="ui-dialog__actions classification-appearance__actions">
          <Button type="button" disabled={saving} onClick={() => { setIconKey(null); setColorKey(null); }}>
            기본값으로 초기화
          </Button>
          <span className="classification-appearance__action-spacer" />
          <Button type="button" disabled={saving} onClick={onClose}>취소</Button>
          <Button type="button" variant="primary" disabled={saving} onClick={() => void save()}>저장</Button>
        </div>
      </div>
    </Dialog>
  );
}
