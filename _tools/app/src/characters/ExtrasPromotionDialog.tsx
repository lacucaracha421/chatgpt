import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckIcon } from "@heroicons/react/20/solid";
import { AssetImage } from "../privacy/AssetImage";
import { thumbnailUrl } from "../assets/mediaUrl";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Dialog } from "../shared/ui/Dialog";
import { Select } from "../shared/ui/Select";
import { TextField } from "../shared/ui/TextField";
import type { CharacterTarget } from "./api";
import { characterExtrasApi, type PromoteExtrasResult } from "./extrasApi";
import { extrasTagName } from "./extrasNames";
import { characterHubApi, type CharacterGroup } from "./hubApi";
import "./CharacterExtras.css";

/** Five references start recognition; fewer start the character as a manual one. */
export const RECOGNITION_REFERENCES = 5;
const MAX_PROMOTION_REFERENCES = 25;

type GroupDraft = { id: string | null; seriesId: string; expectedRevision: number | null; name: string; targetIds: string[]; delete: boolean };
export type ExtrasPromotionApi = {
  promote: typeof characterExtrasApi.promote;
  groups: (seriesId: string) => Promise<CharacterGroup[]>;
  saveGroup: (request: GroupDraft) => Promise<unknown>;
};
export const extrasPromotionApi: ExtrasPromotionApi = {
  promote: request => characterExtrasApi.promote(request),
  groups: seriesId => characterHubApi.groups(seriesId),
  saveGroup: request => invoke("save_character_group", { request }),
};

/** What the person is told after 만들기. `groupNote` is set when only the group step failed. */
export type ExtrasPromotionOutcome = { result: PromoteExtrasResult; groupNote: string | null };

/**
 * References checked at first: up to five images spread across the chosen list, so they are not
 * all neighbours of one reading (the list arrives strongest reading first). Fewer images: all.
 */
export function defaultReferenceIds(assetIds: readonly string[]): string[] {
  if (assetIds.length <= RECOGNITION_REFERENCES) return [...assetIds];
  return Array.from({ length: RECOGNITION_REFERENCES }, (_, index) => assetIds[Math.round(index * (assetIds.length - 1) / (RECOGNITION_REFERENCES - 1))]!);
}

/**
 * 캐릭터로: make one character of the chosen 기타 images. Name, group, representative image and
 * references are settled here and saved in a single step; the images move out of the 기타.
 */
export function ExtrasPromotionDialog({ extras, seriesId, assetIds, tag, groups, privacyMode, api = extrasPromotionApi, onClose, onDone }: {
  extras: CharacterTarget;
  seriesId: string;
  /** The images chosen in the grid, in the order they were read or selected. */
  assetIds: string[];
  /** The automatic tag the images were read under, when they came from a suggestion. */
  tag: string | null;
  /** This series' groups. */
  groups: CharacterGroup[];
  privacyMode: boolean;
  api?: ExtrasPromotionApi;
  onClose: () => void;
  onDone: (outcome: ExtrasPromotionOutcome) => void;
}) {
  const suggested = tag ? extrasTagName(tag) : null;
  const [name, setName] = useState(suggested?.name ?? "");
  const startGroup = extras.extrasGroupId ?? "";
  const [groupId, setGroupId] = useState(startGroup);
  const [thumbnail, setThumbnail] = useState(assetIds[0] ?? "");
  const [references, setReferences] = useState<string[]>(() => defaultReferenceIds(assetIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const referenceSet = useMemo(() => new Set(references), [references]);
  const trimmed = name.trim();
  const recognition = references.length >= RECOGNITION_REFERENCES;
  const groupName = groupId ? groups.find(group => group.id === groupId)?.name : null;

  function toggleReference(assetId: string) {
    if (busy) return;
    setError(null);
    if (referenceSet.has(assetId)) { setReferences(references.filter(id => id !== assetId)); return; }
    if (references.length >= MAX_PROMOTION_REFERENCES) { setError("레퍼런스는 최대 25장입니다. 먼저 한 장을 해제해 주세요."); return; }
    setReferences([...references, assetId]);
  }

  async function submit() {
    if (busy || !trimmed || assetIds.length === 0) return;
    setBusy(true); setError(null);
    let result: PromoteExtrasResult;
    try {
      result = await api.promote({
        targetId: extras.id, expectedFingerprint: extras.fingerprint, displayName: trimmed,
        assetIds, thumbnailAssetId: assetIds.includes(thumbnail) ? thumbnail : assetIds[0] ?? null,
        referenceAssetIds: assetIds.filter(id => referenceSet.has(id)), tag,
      });
    } catch (reason) {
      setError(commandErrorMessage(reason, "캐릭터를 만들지 못했습니다."));
      setBusy(false);
      return;
    }
    // The new character already exists; a group other than the 기타's own is a second, separate step.
    let groupNote: string | null = null;
    if (groupId !== startGroup) {
      try {
        const fresh = await api.groups(seriesId);
        const leave = startGroup ? fresh.find(group => group.id === startGroup) : undefined;
        const join = groupId ? fresh.find(group => group.id === groupId) : undefined;
        if (leave) await api.saveGroup({ id: leave.id, seriesId, expectedRevision: leave.revision, name: leave.name, targetIds: leave.targetIds.filter(id => id !== result.target.id), delete: false });
        if (join) {
          const latest = (await api.groups(seriesId)).find(group => group.id === join.id) ?? join;
          await api.saveGroup({ id: latest.id, seriesId, expectedRevision: latest.revision, name: latest.name, targetIds: [...latest.targetIds, result.target.id], delete: false });
        }
      } catch (reason) {
        groupNote = commandErrorMessage(reason, "그룹은 바꾸지 못했습니다. 캐릭터는 만들었습니다.");
      }
    }
    setBusy(false);
    onDone({ result, groupNote });
  }

  return <Dialog open title="캐릭터로" variant="medium" onClose={() => { if (!busy) onClose(); }}>
    <div className="character-extras-dialog">
      <div className="character-extras-dialog__fields">
        <TextField label="이름" value={name} maxLength={100} disabled={busy} autoComplete="off"
          // An uncertain Korean spelling stays selected so the person checks it; a certain one is ready to accept.
          autoFocus onFocus={event => { if (suggested && !suggested.sure) event.currentTarget.select(); }}
          onChange={event => setName(event.target.value)} />
        <Select label="그룹" value={groupId} disabled={busy} onChange={event => setGroupId(event.target.value)}>
          <option value="">그룹 없음</option>
          {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </Select>
      </div>
      {suggested && !suggested.sure && <p className="character-extras-dialog__note">한국어 이름이 확실하지 않아요. 확인해 주세요.</p>}
      <section aria-label="레퍼런스" className="character-extras-dialog__references">
        <h3 className="character-registry__heading">레퍼런스 <small>{references.length}장 · {RECOGNITION_REFERENCES}장부터 자동 인식</small></h3>
        <div className="character-extras-refs" role="group" aria-label="레퍼런스로 쓸 이미지">
          {assetIds.map((assetId, index) => {
            const checked = referenceSet.has(assetId);
            return <div key={assetId} className="character-extras-refs__tile" data-checked={checked || undefined}>
              <button type="button" className="character-extras-refs__open" aria-pressed={checked} aria-label={`이미지 ${index + 1} 레퍼런스${checked ? " 해제" : ""}`} disabled={busy} onClick={() => toggleReference(assetId)}>
                {privacyMode ? <span className="privacy-mask" aria-label="비공개 모드" /> : <AssetImage draggable={false} loading="lazy" src={thumbnailUrl(assetId)} alt="" />}
                {checked && <span className="character-extras-refs__mark" aria-hidden="true"><CheckIcon /></span>}
              </button>
              <button type="button" className="character-extras-refs__cover" aria-pressed={thumbnail === assetId} aria-label={`이미지 ${index + 1} 대표 이미지로`} disabled={busy} onClick={() => setThumbnail(assetId)}>
                대표
              </button>
            </div>;
          })}
        </div>
      </section>
      <p className="character-extras-dialog__note" role="status">
        고른 {assetIds.length.toLocaleString("ko-KR")}장이 기타에서{trimmed ? ` ${trimmed}${groupName ? ` (${groupName})` : ""}` : " 새 캐릭터"}로 옮겨집니다.
        {" "}{recognition ? "새로 들어오는 이미지부터 자동 인식합니다." : `레퍼런스가 ${RECOGNITION_REFERENCES}장 미만이라 수동으로 시작합니다.`}
      </p>
      {error && <p className="character-message" role="alert">{error}</p>}
      <div className="character-actions character-extras-dialog__actions">
        <Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
        <Button variant="primary" disabled={busy || !trimmed || assetIds.length === 0} onClick={() => void submit()}>
          <BusyLabel busy={busy} idle="만들기">만드는 중…</BusyLabel>
        </Button>
      </div>
    </div>
  </Dialog>;
}
