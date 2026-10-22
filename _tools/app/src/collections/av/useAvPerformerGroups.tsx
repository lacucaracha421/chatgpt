import { useEffect, useMemo, useState } from "react";
import type { CollectionSummary } from "../../library/types";
import type { CollectionListGroup } from "../CollectionList";
import type { AvCreditPerson, AvGateway } from "../avTypes";
import { AvPortrait } from "./AvPortrait";
import { NO_PERFORMER, performerGroups } from "./performerGroups";
import { performerName } from "./performerName";
import { NoPerformerHeading, PerformerGroupHeading } from "./PerformerGroupHeading";

type Credited = AvCreditPerson & { order: number };
type CreditIndex = { root: string; byWork: Map<string, Credited[]> };
/** The last credits read per library, so returning to the grouped list shows it at once while it re-reads. */
const remembered = new Map<string, CreditIndex>();

/**
 * The PC's AV list grouped by performer: reads every work's credits once while the grouping is on (again after the
 * list changes), keeping the last read meanwhile. `waiting` is true only until a first read for this library ends;
 * a failed read leaves the list ungrouped rather than empty.
 */
export function useAvPerformerGroups({ api, root, enabled, items, refreshKey, onOpenPerformer }: {
  api: Pick<AvGateway, "listPerformerCredits">; root: string; enabled: boolean; items: CollectionSummary[]; refreshKey: unknown;
  onOpenPerformer(personId: string): void;
}): { groups: CollectionListGroup<CollectionSummary>[] | undefined; waiting: boolean } {
  const [index, setIndex] = useState<CreditIndex | null>(() => remembered.get(root) ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !api.listPerformerCredits) return;
    let active = true;
    void api.listPerformerCredits().then(value => {
      const people = new Map(value.people.map(person => [person.id, person]));
      const byWork = new Map<string, Credited[]>();
      for (const credit of value.credits) {
        const person = people.get(credit.personId);
        if (!person) continue;
        const list = byWork.get(credit.collectionId) ?? [];
        list.push({ ...person, order: credit.order });
        byWork.set(credit.collectionId, list);
      }
      for (const list of byWork.values()) list.sort((a, b) => a.order - b.order);
      const next = { root, byWork };
      remembered.set(root, next);
      if (active) { setIndex(next); setFailed(null); }
    }, () => { if (active) setFailed(root); });
    return () => { active = false; };
  }, [api, root, enabled, refreshKey]);
  const current = index?.root === root ? index : remembered.get(root) ?? null;
  const groups = useMemo(() => {
    if (!enabled || !current) return undefined;
    return performerGroups(items, item => current.byWork.get(item.id)).map((group): CollectionListGroup<CollectionSummary> => {
      if (!group.person) return { key: "", label: NO_PERFORMER, items: group.items, heading: <NoPerformerHeading count={group.items.length} /> };
      const person = group.person, name = performerName(person);
      return { key: person.id, label: name.primary, items: group.items,
        heading: <PerformerGroupHeading portrait={<AvPortrait portrait={person.portrait} name={name.primary} size={40} />} name={name} count={group.items.length} onOpen={() => onOpenPerformer(person.id)} /> };
    });
  }, [enabled, current, items, onOpenPerformer]);
  return { groups, waiting: enabled && !current && failed !== root && Boolean(api.listPerformerCredits) };
}
