/** Display only: authority identity and per-work credit names remain untouched. */
export function performerName(person: {displayName?: string | null; name?: string | null; nameJa?: string | null; originalName?: string | null; profile?: {name?: string | null} | null; stashdbProfile?: {name?: string | null} | null}) {
  const display = (person.displayName ?? person.name ?? '').trim();
  const roman = [person.stashdbProfile?.name, person.profile?.name].map(name => name?.trim() ?? '').find(name => /^[\p{Script=Latin}]+$/u.test(name.replace(/[^\p{L}]/gu, '')));
  const primary = /\p{Script=Hangul}/u.test(display) ? display : roman || display;
  const japanese = (person.nameJa ?? person.originalName)?.trim() ?? '';
  return {primary, secondary: japanese && japanese !== primary ? japanese : ''};
}
