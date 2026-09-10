import { useState } from "react";
import type { ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import type { CharacterTarget } from "./api";
import { FolderCharacterRegistration } from "./FolderCharacterRegistration";
import { MixedCharacterFolderMigration } from "./MixedCharacterFolderMigration";
import type { FinalizeMixedFolderResult } from "./hubApi";
import "./SeriesBrowser.css";

type Props = {
  folderId: string;
  classifications: ClassificationEntry[];
  targets: CharacterTarget[];
  privacyMode: boolean;
  mixedAvailable: boolean;
  onClose: () => void;
  onSingleSaved: (target: CharacterTarget) => void;
  onMixedFinished: (result: FinalizeMixedFolderResult) => void;
};

export function CharacterFolderOrganizer({ folderId, classifications, targets, privacyMode, mixedAvailable, onClose, onSingleSaved, onMixedFinished }: Props) {
  const [mode, setMode] = useState<"choose" | "single" | "mixed">("choose");
  if (mode === "single") return <FolderCharacterRegistration folderId={folderId} classifications={classifications} targets={targets} privacyMode={privacyMode} onClose={onClose} onSaved={onSingleSaved} />;
  if (mode === "mixed") return <MixedCharacterFolderMigration folderId={folderId} targets={targets} onClose={onClose} onFinished={onMixedFinished} />;
  return <Dialog open title="캐릭터 구조로 정리" onClose={onClose}>
    <div className="character-folder-organizer">
      <button type="button" onClick={() => setMode("single")}>
        <strong>한 캐릭터 폴더</strong>
        <span>마커스처럼 폴더 전체가 한 캐릭터의 이미지라면 바로 캐릭터로 전환합니다.</span>
      </button>
      <button type="button" disabled={!mixedAvailable} onClick={() => setMode("mixed")}>
        <strong>여러 캐릭터가 섞인 폴더</strong>
        <span>{mixedAvailable ? "카카졸데나 가방팟처럼 이미지를 분석해 캐릭터 관계를 나누고 그룹으로 바꿉니다." : "등록된 작품 아래의 일반 폴더에서 사용할 수 있습니다."}</span>
      </button>
      <div className="character-actions"><Button variant="ghost" onClick={onClose}>취소</Button></div>
    </div>
  </Dialog>;
}
