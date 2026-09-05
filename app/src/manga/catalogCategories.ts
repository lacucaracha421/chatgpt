export const catalogCategories = [
  { id: 1, label: "동인지" },
  { id: 2, label: "만화" },
  { id: 3, label: "아티스트 CG" },
  { id: 4, label: "게임 CG" },
  { id: 5, label: "서양" },
  { id: 6, label: "이미지 세트" },
  { id: 7, label: "비성인" },
  { id: 8, label: "코스프레" },
  { id: 9, label: "아시아 포르노" },
  { id: 10, label: "기타" },
  { id: 11, label: "비공개" },
] as const;

export function catalogCategoryLabel(category: number): string | null {
  return catalogCategories.find((entry) => entry.id === category)?.label ?? null;
}
