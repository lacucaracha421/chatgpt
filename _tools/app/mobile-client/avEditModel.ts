import limits from '../src/collections/avLimits.json';
import type {AvInfo, AvPerson} from './collectionModel';

export const AV_EDIT_TITLE = 'AV 정보 편집';
export const AV_INPUT_ERROR = 'AV 입력을 확인해 주세요.';
export const AV_DETAIL_FIELDS = [
  {key: 'productCode', label: '품번', maxLength: limits.productCode},
  {key: 'titleJa', label: '일본어 제목', maxLength: limits.titleJa},
  {key: 'maker', label: '메이커', maxLength: limits.maker},
  {key: 'label', label: '레이블', maxLength: limits.label},
  {key: 'series', label: '시리즈', maxLength: limits.series},
  {key: 'genres', label: '장르', maxLength: undefined},
  {key: 'releaseDate', label: '출시일', maxLength: 10},
] as const;
export type AvDetailKey = typeof AV_DETAIL_FIELDS[number]['key'];
export type AvDetailFields = Partial<Record<AvDetailKey, string | string[] | null>>;
export type AvCredit = {personId: string; role: AvPerson['role']; order: number; creditName: string | null};
export type AvNewPerson = {personId: string; displayName: string; nameJa: string | null};
export type AvOverlay = {people: AvPerson[]; expectedCredits: AvCredit[]};
export const emptyAv = (): AvInfo => ({genres: [], people: []});
export const avValue = (av: AvInfo | null | undefined, key: AvDetailKey) => key === 'genres' ? av?.genres ?? [] : av?.[key] ?? null;
export const sameAvValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function avCredits(people: AvPerson[]): AvCredit[] {
  return canonicalAvCredits(people.map(person => ({personId: person.id, role: person.role, order: person.order, creditName: person.creditName?.trim() || null})));
}
export function canonicalAvCredits(credits: AvCredit[]): AvCredit[] {
  return credits.map(credit => ({personId: credit.personId, role: credit.role, order: credit.order, creditName: credit.creditName?.trim() || null}))
    .sort((a, b) => a.role.localeCompare(b.role) || a.order - b.order || a.personId.localeCompare(b.personId));
}
/** Gaps in stored order numbers are not an edit; the visible role order and aliases are. */
export const sameCreditList = (a: AvCredit[], b: AvCredit[]) => sameAvValue(
  canonicalAvCredits(a).map(({personId, role, creditName}) => ({personId, role, creditName})),
  canonicalAvCredits(b).map(({personId, role, creditName}) => ({personId, role, creditName})),
);
export function orderedPeople(people: AvPerson[]): AvPerson[] {
  return (['performer', 'director'] as const).flatMap(role => people.filter(person => person.role === role).map((person, order) => ({...person, order, creditName: person.creditName?.trim() || null})));
}
const invalid = () => { throw new Error(AV_INPUT_ERROR); };
const length = (text: string) => [...text].length;
export function validateAvDetails(fields: AvDetailFields) {
  for (const [key, value] of Object.entries(fields)) {
    if (!AV_DETAIL_FIELDS.some(field => field.key === key)) invalid();
    if (key === 'genres') {
      if (!Array.isArray(value) || value.length > limits.genres || value.some(genre => typeof genre !== 'string' || !genre.trim() || length(genre) > limits.genreLength)) invalid();
    } else if (key === 'releaseDate') {
      if (value !== null) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
        const date = new Date(`${value}T00:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value.startsWith('0000')) invalid();
      }
    } else if (value !== null && (typeof value !== 'string' || length(value) > limits[key as keyof typeof limits])) invalid();
  }
}
export function validateAvCredits(credits: AvCredit[], people: AvNewPerson[], revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 1 || credits.length > limits.credits) invalid();
  const ids = new Set<string>(), orders = new Set<string>();
  const safeId = (id: string) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  for (const credit of credits) {
    if (!safeId(credit.personId) || !['performer', 'director'].includes(credit.role) || !Number.isInteger(credit.order) || credit.order < 0 || credit.order >= limits.credits
      || credit.creditName !== null && (typeof credit.creditName !== 'string' || length(credit.creditName) > limits.creditName)
      || ids.has(`${credit.role}/${credit.personId}`) || orders.has(`${credit.role}/${credit.order}`)) invalid();
    ids.add(`${credit.role}/${credit.personId}`); orders.add(`${credit.role}/${credit.order}`);
  }
  const newIds = new Set<string>();
  for (const person of people) {
    if (!safeId(person.personId) || newIds.has(person.personId) || !credits.some(credit => credit.personId === person.personId)
      || typeof person.displayName !== 'string' || !person.displayName.trim() || length(person.displayName) > limits.personName
      || person.nameJa !== null && (typeof person.nameJa !== 'string' || length(person.nameJa) > limits.personName)) invalid();
    newIds.add(person.personId);
  }
}
/** `setPerson`: the person's 내 메모 and 즐겨찾기, edited by field CAS (PC `AvPerformerPage`). */
export const PERSON_MEMO_LIMIT = limits.personMemo;
export const PERSON_MEMO_TOO_LONG = `메모는 ${limits.personMemo.toLocaleString()}자까지 쓸 수 있습니다.`;
export type PersonKey = 'memo' | 'favorite';
export type PersonValues = {memo: string | null; favorite: boolean};
export type PersonFields = Partial<PersonValues>;
/** The server's memo normalization: trimmed, blank is no memo. */
export const normalizePersonMemo = (text: string | null | undefined) => text?.trim() || null;
export const personMemoLength = (text: string) => length(text.trim());
export function validatePersonFields(fields: PersonFields) {
  const keys = Object.keys(fields);
  if (!keys.length || keys.some(key => key !== 'memo' && key !== 'favorite')) invalid();
  if ('favorite' in fields && typeof fields.favorite !== 'boolean') invalid();
  if ('memo' in fields) {
    const memo = fields.memo;
    if (memo !== null && (typeof memo !== 'string' || memo !== memo.trim() || !memo || length(memo) > limits.personMemo)) invalid();
  }
}
