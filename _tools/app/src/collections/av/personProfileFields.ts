/** Shared authority values. Storage tokens never pass through the display-unit conversion. */
export const profileKeys = ['displayName', 'nameJa', 'birthDate', 'heightCm', 'bandIn', 'waistIn', 'hipIn', 'cup', 'breastType', 'careerStart', 'careerEnd', 'urls'] as const;
export type ProfileKey = typeof profileKeys[number];
export type ProfileValue = string | number | null | {site: string; url: string}[];
export type ProfileChanges = Partial<Record<ProfileKey, ProfileValue | {reset: true}>>;
export type ProfileExpected = Partial<Record<ProfileKey, {value: ProfileValue; overridden: boolean}>>;
export type ProfileSource = {name?: string | null; aliases?: string[]; source?: string} & Partial<Record<Exclude<ProfileKey, 'displayName' | 'nameJa'>, ProfileValue>>;
export type ProfilePerson = {displayName?: string; nameJa?: string | null; profile?: ProfileSource | null; stashdbId?: string | null; stashdbProfile?: ProfileSource | null; profileOverrides?: Partial<Record<ProfileKey, ProfileValue>>; profileBaseNames?: {displayName?: string | null; nameJa?: string | null}; entityRevision?: number};
export const hasOwn = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);
export const ownsProfile = (person: ProfilePerson, key: ProfileKey) => hasOwn(person.profileOverrides ?? {}, key);
export const hasProfileMetadata = (person: ProfilePerson) => hasOwn(person, 'stashdbProfile') && !!person.profileOverrides && typeof person.profileOverrides === 'object' && !Array.isArray(person.profileOverrides);
export const profileValue = (person: ProfilePerson, key: ProfileKey): ProfileValue => key === 'displayName' ? person.displayName ?? '' : key === 'nameJa' ? person.nameJa ?? null : person.profile?.[key] ?? null;
export const profileBase = (person: ProfilePerson, key: ProfileKey): ProfileValue => key === 'displayName' || key === 'nameJa' ? (hasOwn(person.profileBaseNames ?? {}, key) ? person.profileBaseNames?.[key] ?? null : person[key] ?? null) : person.stashdbProfile?.[key] ?? (key === 'urls' ? [] : null);
export const profileToken = (person: ProfilePerson, key: ProfileKey) => ({value: profileValue(person, key), overridden: ownsProfile(person, key)});
export const sameProfileValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const inchesToCm = (value: number) => Math.round(value * 2.54);
export const cmToInches = (value: number) => Math.round(value / 2.54);
export const profileGroups: {label: string; keys: ProfileKey[]}[] = [
  {label: '이름', keys: ['displayName']}, {label: '일본어 이름', keys: ['nameJa']}, {label: '생년월일', keys: ['birthDate']}, {label: '키', keys: ['heightCm']},
  {label: '사이즈', keys: ['bandIn', 'waistIn', 'hipIn']}, {label: '컵', keys: ['cup']}, {label: '가슴', keys: ['breastType']}, {label: '활동', keys: ['careerStart', 'careerEnd']}, {label: '링크', keys: ['urls']},
];
export function applyProfileChanges<T extends ProfilePerson>(person: T, changes: ProfileChanges): T {
  const next = {...person, profile: {...person.profile}, profileOverrides: {...person.profileOverrides}, profileBaseNames: {...person.profileBaseNames}};
  for (const key of profileKeys) {
    if (!hasOwn(changes, key)) continue;
    const change = changes[key]!;
    if ((key === 'displayName' || key === 'nameJa') && !hasOwn(next.profileBaseNames, key)) next.profileBaseNames = {displayName: person.displayName ?? '', nameJa: person.nameJa ?? null, ...next.profileBaseNames};
    const reset = change !== null && typeof change === 'object' && !Array.isArray(change) && 'reset' in change;
    if (reset) delete next.profileOverrides[key]; else next.profileOverrides[key] = change as ProfileValue;
    const value = reset ? profileBase(next, key) : change as ProfileValue;
    if (key === 'displayName') next.displayName = typeof value === 'string' ? value : '';
    else if (key === 'nameJa') next.nameJa = typeof value === 'string' ? value : null;
    else next.profile[key] = key === 'urls' && value === null ? [] : value;
  }
  const source = hasOwn(person, 'stashdbProfile') ? person.stashdbProfile : person.profile;
  const fields = profileKeys.filter(key => key !== 'displayName' && key !== 'nameJa');
  if (!source && !fields.some(key => ownsProfile(next, key))) return {...next, profile: null} as T;
  const merged: ProfileSource = source ? {...source} : {source: 'stashdb', name: null, aliases: [], ...Object.fromEntries(fields.map(key => [key, key === 'urls' ? [] : null]))};
  for (const key of fields) if (ownsProfile(next, key)) merged[key] = key === 'urls' && next.profileOverrides[key] === null ? [] : next.profileOverrides[key] ?? null;
  return {...next, profile: merged} as T;
}
const INPUT_ERROR = '프로필 입력을 확인해 주세요.';
export function validateProfileChanges(changes: ProfileChanges) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw new Error(INPUT_ERROR);
  for (const [field, value] of Object.entries(changes)) {
    if (!profileKeys.includes(field as ProfileKey)) throw new Error(INPUT_ERROR);
    if (value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.reset === true) continue;
    if (['displayName', 'nameJa', 'cup'].includes(field)) {
      if (typeof value !== 'string' || [...value].length > (field === 'cup' ? 20 : 500)) throw new Error(INPUT_ERROR);
    } else if (field === 'birthDate') {
      if (typeof value !== 'string' || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) throw new Error(INPUT_ERROR);
      const [y, m, d] = value.split('-').map(Number);
      if (y < 1900 || y > 2200 || m !== undefined && (m < 1 || m > 12) || d !== undefined && (d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate())) throw new Error(INPUT_ERROR);
    } else if (field === 'breastType') {
      if (!['NATURAL', 'FAKE', 'NA'].includes(value as string)) throw new Error(INPUT_ERROR);
    } else if (field === 'urls') {
      if (!Array.isArray(value) || value.length > 100) throw new Error(INPUT_ERROR);
      for (const link of value) {
        if (!link || Object.keys(link).sort().join(',') !== 'site,url' || typeof link.site !== 'string' || [...link.site].length > 200 || typeof link.url !== 'string' || link.url.length > 2000 || /[\x00-\x20\x7f]/.test(link.url)) throw new Error(INPUT_ERROR);
        let url: URL; try { url = new URL(link.url); } catch { throw new Error(INPUT_ERROR); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(INPUT_ERROR);
      }
    } else {
      const year = field === 'careerStart' || field === 'careerEnd';
      if (typeof value !== 'number' || !Number.isInteger(value) || value < (year ? 1900 : 1) || value > (year ? 2200 : field === 'heightCm' ? 300 : 200)) throw new Error(INPUT_ERROR);
    }
  }
}
export function validateProfileExpected(changes: ProfileChanges, expected: ProfileExpected) {
  if (!expected || Object.keys(changes).sort().join(',') !== Object.keys(expected).sort().join(',')) throw new Error(INPUT_ERROR);
  for (const [field, token] of Object.entries(expected)) {
    if (!token || Object.keys(token).sort().join(',') !== 'overridden,value' || typeof token.overridden !== 'boolean' || token.value === undefined || typeof token.value === 'boolean') throw new Error(INPUT_ERROR);
    const value = token.value;
    if (value === null) continue;
    if (['displayName','nameJa','birthDate','cup','breastType'].includes(field)) { if (typeof value !== 'string' || [...value].length > 500) throw new Error(INPUT_ERROR); }
    else if (field === 'urls') { if (!Array.isArray(value) || value.length > 100 || value.some(link => !link || Object.keys(link).sort().join(',') !== 'site,url' || typeof link.site !== 'string' || [...link.site].length > 200 || typeof link.url !== 'string' || link.url.length > 2000)) throw new Error(INPUT_ERROR); }
    else if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(INPUT_ERROR);
  }
}
export function profileExpected(person: ProfilePerson, changes: ProfileChanges): ProfileExpected {
  return Object.fromEntries(Object.keys(changes).map(key => [key, profileToken(person, key as ProfileKey)]));
}
export function validateProfileCareer(person: ProfilePerson, changes: ProfileChanges) {
  if (!('careerStart' in changes || 'careerEnd' in changes)) return;
  const next = applyProfileChanges(person, changes), start = next.profile?.careerStart, end = next.profile?.careerEnd;
  if (typeof start === 'number' && typeof end === 'number' && end < start) throw new Error('활동 종료 연도를 확인해 주세요.');
}
