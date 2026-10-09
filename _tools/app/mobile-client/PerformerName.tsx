import {performerName} from '../src/collections/av/performerName';
import type {ProfilePerson} from '../src/collections/av/personProfileFields';
import {personWithNameSource} from './personNameCache';

/** Source metadata comes from the page read before paint; mounting a name never fetches. */
export function PerformerName({person}: {person: ProfilePerson & {id?: string; personId?: string; name?: string}}) {
  const name = performerName(personWithNameSource(person));
  return <><b>{name.primary}</b>{name.secondary && <small lang="ja">{name.secondary}</small>}</>;
}
export function usePerformerNames<T extends ProfilePerson & {id: string; name?: string}>(people: T[], _enabled = true): T[] {
  return people.map(personWithNameSource);
}
