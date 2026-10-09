import type {ProfilePerson} from '../src/collections/av/personProfileFields';
import {hasOwn} from '../src/collections/av/personProfileFields';
import {api} from './transport';
import {outboxConnection} from './outboxConnection';
import type {CollectionSummary} from './collectionModel';

type PersonSource = ProfilePerson & {personId?: string; id?: string};
let scope: string | null = null;
let sources = new Map<string, PersonSource>();
let baseline: Promise<void> | null = null;
let authorityScope: string | null = null;
let generation = 0;
function session() {
  const connection = outboxConnection();
  if (connection !== scope) { scope = connection; sources = new Map(); baseline = null; authorityScope = null; generation++; }
  return connection;
}
export function observePersonNameAuthority(identity: {libraryId: string; epoch: number} | null) {
  session();
  const next = identity ? JSON.stringify([identity.libraryId, identity.epoch]) : null;
  if (authorityScope !== null && authorityScope !== next) { sources = new Map(); baseline = null; generation++; }
  authorityScope = next;
}
export function rememberPersonNames(people: PersonSource[], connection = outboxConnection()) {
  if (connection !== session()) return;
  for (const person of people) {
    const id = person.personId ?? person.id;
    if (!id || !hasOwn(person, 'stashdbProfile')) continue;
    const current = sources.get(id);
    if (!current || (person.entityRevision ?? 0) >= (current.entityRevision ?? 0)) sources.set(id, person);
  }
}
export function personWithNameSource<T extends ProfilePerson & {id?: string; personId?: string}>(person: T): T {
  session();
  if (hasOwn(person, 'stashdbProfile')) return person;
  const source = sources.get(person.id ?? person.personId ?? '');
  return source ? {...person, stashdbProfile: source.stashdbProfile, profileOverrides: source.profileOverrides} : person;
}
/** Await one shared source read before publishing a list, so names never swap after paint. */
export async function loadedPerformerNames<T extends CollectionSummary>(items: T[]): Promise<T[]> {
  const connection = session();
  for (const item of items) rememberPersonNames(item.avPeople ?? item.av?.people ?? []);
  const missing = items.some(item => item.av?.people.some(person => !/\p{Script=Hangul}/u.test(person.displayName ?? person.name) && !personWithNameSource(person).stashdbProfile?.name && !person.profile?.name));
  if (connection && missing && !baseline) {
    // The plain list omits source metadata; the authority baseline already supplies avPeople in pages.
    // This is one session read for all lists, never a person read from a rendered name.
    const readGeneration = generation;
    baseline = (async () => {
      const identity = await api<{active?: boolean; libraryId?: string; epoch?: number}>('/v1/collections/authority/status', undefined, undefined, 'GET', false, connection);
      if (!identity?.active || !identity.libraryId || !Number.isInteger(identity.epoch)) return;
      if (readGeneration !== generation || outboxConnection() !== connection) return;
      observePersonNameAuthority({libraryId: identity.libraryId, epoch: identity.epoch!});
      const params = new URLSearchParams({libraryId: identity.libraryId, epoch: String(identity.epoch)});
      const path = '/v1/collections/authority/baseline';
      const manifest = await api<{snapshotCursor: number}>(`${path}?${params}`, undefined, undefined, 'GET', false, connection);
      if (!Number.isInteger(manifest?.snapshotCursor)) return;
      params.set('snapshot', String(manifest.snapshotCursor)); params.set('section', 'works');
      let after: string | null = null;
      const people: PersonSource[] = [];
      do {
        if (after) params.set('after', after);
        const page = await api<{libraryId: string; epoch: number; items: {avPeople?: PersonSource[]}[]; hasMore: boolean; nextAfter: string | null}>(`${path}?${params}`, undefined, undefined, 'GET', false, connection);
        if (page.libraryId !== identity.libraryId || page.epoch !== identity.epoch || !Array.isArray(page.items) || outboxConnection() !== connection) return;
        for (const work of page.items) people.push(...work.avPeople ?? []);
        const next = page.hasMore ? page.nextAfter : null;
        if (page.hasMore && (!next || next === after)) return;
        after = next;
      } while (after);
      if (outboxConnection() === connection && readGeneration === generation) rememberPersonNames(people);
    })().catch(() => { /* An offline or old server keeps the loaded display name. */ });
  }
  if (missing && baseline) await baseline;
  return items.map(item => item.av ? {...item, av: {...item.av, people: item.av.people.map(personWithNameSource)}} : item);
}
