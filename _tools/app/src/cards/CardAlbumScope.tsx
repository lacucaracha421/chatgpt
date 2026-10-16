import { FilterChip } from "../shared/ui/FilterChip";

export function CardAlbumScope({ trashed, onChange, className }: {
  trashed: boolean; onChange: (trashed: boolean) => void; className: string;
}) {
  return <div className={className} role="group" aria-label="카드 보관함">
    <FilterChip aria-pressed={!trashed} onClick={() => onChange(false)}>보유 카드</FilterChip>
    <FilterChip aria-pressed={trashed} onClick={() => onChange(true)}>휴지통</FilterChip>
  </div>;
}
