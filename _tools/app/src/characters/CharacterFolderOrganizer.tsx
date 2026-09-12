import type { ClassificationEntry } from "../library/types";
import type { CharacterTarget } from "./api";
import { FolderCharacterRegistration } from "./FolderCharacterRegistration";

type Props = {
  folderId: string;
  classifications: ClassificationEntry[];
  targets: CharacterTarget[];
  privacyMode: boolean;
  onClose: () => void;
  onSingleSaved: (target: CharacterTarget) => void;
};

export function CharacterFolderOrganizer({ folderId, classifications, targets, privacyMode, onClose, onSingleSaved }: Props) {
  return <FolderCharacterRegistration
    folderId={folderId}
    classifications={classifications}
    targets={targets}
    privacyMode={privacyMode}
    onClose={onClose}
    onSaved={onSingleSaved}
  />;
}
