import { useEffect, useRef, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { displayCount } from "../shared/displayDate";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { folderGroupApi, type FolderGroupPreview, type FolderGroupResult } from "./folderGroupApi";
import "./CharacterExtras.css";

export function CharacterFolderGroupDialog({ folderId, api = folderGroupApi, onClose, onSaved }: {
  folderId: string;
  api?: Pick<typeof folderGroupApi, "preview" | "apply">;
  onClose: () => void;
  onSaved: (result: FolderGroupResult) => void;
}) {
  const [preview, setPreview] = useState<FolderGroupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const applying = useRef(false);
  const [reload, setReload] = useState(0);
  const [needsPreview, setNeedsPreview] = useState(false);
  useEffect(() => {
    let active = true;
    setError(null); setNeedsPreview(true);
    void api.preview(folderId).then(value => {
      if (active) { setPreview(value); setNeedsPreview(false); }
    }, reason => { if (active) setError(commandErrorMessage(reason, "정리 내용을 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [api, folderId, reload]);

  async function confirm() {
    if (!preview || preview.refusal || needsPreview || applying.current) return;
    applying.current = true; setBusy(true); setError(null);
    try { onSaved(await api.apply(folderId, preview.token)); }
    catch (reason) {
      setError(commandErrorMessage(reason, "그룹으로 정리하지 못했습니다. 미리보기를 다시 확인해 주세요."));
      setNeedsPreview(true);
    } finally { applying.current = false; setBusy(false); }
  }

  return <Dialog open title="그룹으로 정리" variant="medium" onClose={() => { if (!applying.current) onClose(); }}>
    <div className="character-extras-dialog">
      <BusyLabel busy={needsPreview && !error}><p role="status">정리 내용을 확인하는 중…</p></BusyLabel>
      {preview && <>
        <p className="character-extras-dialog__summary"><strong>{preview.folderName}</strong></p>
        {preview.seriesName && <p>‘{preview.seriesName}’ 시리즈 폴더로 옮깁니다.</p>}
        <p>{preview.groupId ? `같은 이름의 ‘${preview.groupName}’ 그룹을 사용합니다.` : `기타만 있는 ‘${preview.groupName}’ 그룹을 만듭니다.`}</p>
        <ul className="character-extras-dialog__facts">
          <li>캐릭터가 있는 이미지·영상·GIF {displayCount(preview.characterAssetCount, "개")}: 캐릭터를 유지하며 시리즈 폴더로 옮깁니다.</li>
          <li>캐릭터가 없는 이미지·영상·GIF {displayCount(preview.unassignedAssetCount, "개")}: 그룹의 기타에 넣고 시리즈 폴더로 옮깁니다.</li>
          {preview.otherAssetCount > 0 && <li>휴지통 등 그 밖의 자산 {displayCount(preview.otherAssetCount, "개")}: 폴더 삭제와 함께 부모 폴더 ‘{preview.parentName}’로 옮깁니다.</li>}
        </ul>
        <p className="character-extras-dialog__note">정리가 끝나면 이 폴더를 삭제합니다.</p>
        {preview.refusal && <p className="character-message" role="alert">{preview.refusal}</p>}
      </>}
      {error && <p className="character-message" role="alert">{error}</p>}
      <div className="ui-actions character-extras-dialog__actions">
        {error && <Button variant="ghost" disabled={busy} onClick={() => setReload(value => value + 1)}>미리보기 다시 확인</Button>}
        <Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
        <Button disabled={busy || needsPreview || !preview || Boolean(preview.refusal)} onClick={() => void confirm()}>
          <BusyLabel busy={busy} idle="그룹으로 정리">정리하는 중…</BusyLabel>
        </Button>
      </div>
    </div>
  </Dialog>;
}
