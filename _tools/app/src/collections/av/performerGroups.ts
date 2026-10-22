import { performerName } from "./performerName";

/** A performer's credit on one work: who, and their place in the work's credits (0 = first credited). */
export type PerformerCredit = Parameters<typeof performerName>[0] & { id: string; order: number };
export type PerformerGroup<T, P> = { person: P | null; items: T[] };
/** The last group: works with no performer credited. */
export const NO_PERFORMER = "배우 없음";

/**
 * 배우 묶기, one rule on the PC and the tablet: one group per performer of the given works, keeping the works'
 * order inside each group. A work with several performers appears under each of them; works with none come
 * last under 배우 없음. Performers who are first credited somewhere come first (their best credit place across
 * the works), then by the shown name.
 */
export function performerGroups<T, P extends PerformerCredit>(items: readonly T[], performersOf: (item: T) => readonly P[] | null | undefined): PerformerGroup<T, P>[] {
  const groups = new Map<string, { person: P; best: number; items: T[] }>();
  const none: T[] = [];
  for (const item of items) {
    const people = performersOf(item) ?? [];
    if (!people.length) { none.push(item); continue; }
    for (const person of people) {
      const group = groups.get(person.id);
      if (!group) { groups.set(person.id, { person, best: person.order, items: [item] }); continue; }
      group.best = Math.min(group.best, person.order);
      // A person credited twice on one work (two roles) still shows the work once.
      if (group.items[group.items.length - 1] !== item) group.items.push(item);
    }
  }
  const name = (person: P) => performerName(person).primary;
  const sorted = [...groups.values()].sort((a, b) => a.best - b.best || name(a.person).localeCompare(name(b.person), "ko") || a.person.id.localeCompare(b.person.id));
  return [...sorted.map(({ person, items }) => ({ person, items })), ...(none.length ? [{ person: null, items: none }] : [])];
}
