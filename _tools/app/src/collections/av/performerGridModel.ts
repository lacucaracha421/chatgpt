import { displayDate } from '../../shared/displayDate';
import { koreanInitial } from '../../shared/ui/scrubber/scrubberModel';
import { inchesToCm, type ProfilePerson } from './personProfileFields';
import { performerName } from './performerName';

export type GridPerson = ProfilePerson & { id: string; name?: string; favorite?: boolean };
export type PerformerEntry<P extends GridPerson = GridPerson> = { person: P; workCount: number; latestDate: string | null };
export type PerformerSort = 'count' | 'name' | 'age' | 'height' | 'cup' | 'recent';
export type PerformerDirection = 'asc' | 'desc';
export const PERFORMER_SORTS: {value: PerformerSort; label: string}[] = [
  {value:'count',label:'작품 수'}, {value:'name',label:'이름'}, {value:'age',label:'나이'},
  {value:'height',label:'키'}, {value:'cup',label:'컵'}, {value:'recent',label:'최근 작품'},
];
export const defaultPerformerDirection = (sort: PerformerSort): PerformerDirection => sort === 'name' || sort === 'age' ? 'asc' : 'desc';
export function performerDirections(sort: PerformerSort) {
  const labels = sort === 'name' ? ['가나다순','역순'] : sort === 'age' ? ['어린순','많은순'] : sort === 'count' ? ['적은순','많은순'] : sort === 'recent' ? ['오래된순','최신순'] : ['작은순','큰순'];
  const first = defaultPerformerDirection(sort), second = first === 'asc' ? 'desc' : 'asc';
  return [first,second].map(value => ({value:value as PerformerDirection,label:labels[value === 'asc' ? 0 : 1]}));
}
export function performerAge(person: GridPerson, now = new Date()): string {
  const birth = person.profile?.birthDate;
  if (typeof birth !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(birth)) return '';
  const [year,month,day] = birth.split('-').map(Number);
  if (!month || !day) return `${year}년생`;
  const age = now.getFullYear() - year - (now.getMonth()+1 < month || now.getMonth()+1 === month && now.getDate() < day ? 1 : 0);
  return age >= 0 ? `만 ${age}세` : '';
}
export function performerMeasurements(person: GridPerson) {
  const p = person.profile;
  const cup = typeof p?.cup === 'string' ? p.cup.trim() : '';
  return {bust: typeof p?.bandIn === 'number' ? `B${inchesToCm(p.bandIn)}${cup ? ` (${cup})` : ''}` : cup ? `${cup}컵` : '',
    waist: typeof p?.waistIn === 'number' ? `W${inchesToCm(p.waistIn)}` : '', hip: typeof p?.hipIn === 'number' ? `H${inchesToCm(p.hipIn)}` : ''};
}
export function derivePerformerEntries<W extends {id:string;releaseDate?:string|null;av?:{releaseDate?:string|null}|null},P extends GridPerson>(works: readonly W[], creditsOf:(work:W)=>readonly P[]|undefined): PerformerEntry<P>[] {
  const entries = new Map<string,PerformerEntry<P>>();
  for (const work of works) {
    const seen = new Set<string>();
    for (const person of creditsOf(work) ?? []) {
      if (seen.has(person.id)) continue;
      seen.add(person.id);
      const date = work.av?.releaseDate ?? work.releaseDate ?? null;
      const entry = entries.get(person.id) ?? {person,workCount:0,latestDate:null};
      entry.workCount++;
      if (date && (!entry.latestDate || date > entry.latestDate)) entry.latestDate = date;
      entries.set(person.id,entry);
    }
  }
  return [...entries.values()];
}
function sortValue(entry: PerformerEntry, sort: PerformerSort): string | number | null {
  const p = entry.person.profile;
  if (sort === 'count') return entry.workCount;
  if (sort === 'name') return performerName(entry.person).primary;
  if (sort === 'age') {
    const label = performerAge(entry.person);
    if (!label) return null;
    // Full dates compare the displayed age; year-only records retain their available precision.
    return label.endsWith('년생') ? new Date().getFullYear() - Number(label.slice(0,4)) : Number(label.match(/\d+/)![0]);
  }
  if (sort === 'height') return typeof p?.heightCm === 'number' ? p.heightCm : null;
  if (sort === 'cup') return typeof p?.cup === 'string' && p.cup.trim() ? p.cup.trim().toUpperCase() : null;
  return entry.latestDate;
}
export const performerSortMissing = (entry: PerformerEntry, sort: PerformerSort) => sortValue(entry,sort) === null;
export function sortPerformerEntries<P extends GridPerson>(entries: readonly PerformerEntry<P>[],sort:PerformerSort,direction:PerformerDirection) {
  return [...entries].sort((a,b) => {
    const av = sortValue(a,sort), bv = sortValue(b,sort);
    if (av === null || bv === null) return Number(av === null)-Number(bv === null) || b.workCount-a.workCount || performerName(a.person).primary.localeCompare(performerName(b.person).primary,'ko');
    const compare = typeof av === 'number' && typeof bv === 'number' ? av-bv : String(av).localeCompare(String(bv),'ko',{numeric:true});
    return compare*(direction === 'asc' ? 1 : -1) || b.workCount-a.workCount || performerName(a.person).primary.localeCompare(performerName(b.person).primary,'ko') || a.person.id.localeCompare(b.person.id);
  });
}
export function performerSortLabel(entry: PerformerEntry,sort:PerformerSort,now = new Date()) {
  if (performerSortMissing(entry,sort)) return `${PERFORMER_SORTS.find(option=>option.value===sort)!.label} 정보 없음`;
  if (sort === 'count') return `${entry.workCount}편`;
  if (sort === 'name') return koreanInitial(performerName(entry.person).primary);
  if (sort === 'age') return performerAge(entry.person,now);
  if (sort === 'height') return `${entry.person.profile?.heightCm}cm`;
  if (sort === 'cup') return `${entry.person.profile?.cup}컵`;
  return displayDate(entry.latestDate,now);
}
