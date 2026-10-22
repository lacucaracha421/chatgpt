/** Display only: authority identity and per-work credit names remain untouched. */
export function performerName(person: {displayName?: string | null; name?: string | null; nameJa?: string | null; originalName?: string | null; profile?: {name?: string | null} | null; stashdbProfile?: {name?: string | null} | null}) {
  const display = (person.displayName ?? person.name ?? '').trim();
  const roman = [person.stashdbProfile?.name, person.profile?.name].map(name => name?.trim() ?? '').find(name => /^[\p{Script=Latin}]+$/u.test(name.replace(/[^\p{L}]/gu, '')));
  const primary = /\p{Script=Hangul}/u.test(display) ? display : roman || display;
  const japanese = (person.nameJa ?? person.originalName)?.trim() ?? '';
  return {primary, secondary: japanese && japanese !== primary ? japanese : ''};
}

/** The work's credit name only when it differs from both names already shown (PC and tablet 출연 · 감독). */
export function distinctCreditName(person: Parameters<typeof performerName>[0] & {creditName?: string | null}): string | null {
  const credit = person.creditName?.trim();
  if (!credit) return null;
  const {primary, secondary} = performerName(person);
  return credit !== primary && credit !== secondary ? credit : null;
}

/** A performer's count of works in the library, one wording on both clients. */
export const performerWorkCount = (count: number) => `내 작품 ${count.toLocaleString()}편`;
