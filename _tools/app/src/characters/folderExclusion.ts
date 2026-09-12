import type { ClassificationEntry } from "../library/types";
import type { MenuItem } from "../shared/ui/Menu";

export function folderExclusionItem(folderId: string, classifications: ClassificationEntry[], exclusions: string[], onChange: (excluded: boolean) => void): MenuItem {
  let current = classifications.find(folder => folder.id === folderId);
  const visited = new Set<string>();
  let inherited: ClassificationEntry | undefined;
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parentId = current.parentId;
    current = classifications.find(folder => folder.id === parentId);
    if (current && exclusions.includes(current.id)) { inherited = current; break; }
  }
  const own = exclusions.includes(folderId);
  return {
    id: "character-folder-exclusion",
    label: own ? inherited ? "이 폴더의 제외 설정 해제" : "캐릭터 분류에 다시 포함" : inherited ? `${inherited.name} 폴더에서 분류 제외됨` : "캐릭터 분류에서 제외",
    disabled: !own && Boolean(inherited),
    onSelect: () => onChange(!own),
  };
}
