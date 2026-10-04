import { IMAGE_READY_CAP_MS, waitForViewportImages } from './viewportImages';

/**
 * Parts of one screen that enter as one (the artists index list and its thumbnail grid): every
 * member's first batch starts in the same frame, once each member's first-viewport images have
 * decoded, capped at IMAGE_READY_CAP_MS from the first member joining. Members that commit within
 * a frame of each other join the same start; one that arrives after the start enters on its own.
 */
type Member = { start(): void; stop(): void; ready: boolean };
type Group = { members: Set<Member>; timer: number; frame: number; started: boolean };
const groups = new Map<string, Group>();

function launch(name: string, group: Group) {
  if (group.started) return;
  group.started = true;
  window.clearTimeout(group.timer);
  window.cancelAnimationFrame(group.frame);
  if (groups.get(name) === group) groups.delete(name);
  for (const member of group.members) { member.stop(); member.start(); }
}

/** Holds `start` until the group named `name` starts; returns a leave function (no start after it). */
export function joinEntrance(name: string, host: HTMLElement, start: () => void) {
  let group = groups.get(name);
  if (!group || group.started) {
    const created: Group = { members: new Set(), timer: 0, frame: 0, started: false };
    created.timer = window.setTimeout(() => launch(name, created), IMAGE_READY_CAP_MS);
    groups.set(name, created);
    group = created;
  }
  const joined = group;
  // A frame of gathering, so parts committed together are checked together.
  const check = () => {
    if (joined.started || joined.frame) return;
    joined.frame = window.requestAnimationFrame(() => {
      joined.frame = 0;
      if ([...joined.members].every(member => member.ready)) launch(name, joined);
    });
  };
  const member: Member = { start, stop: () => {}, ready: false };
  joined.members.add(member);
  member.stop = waitForViewportImages(host, () => { member.ready = true; check(); }, IMAGE_READY_CAP_MS);
  return () => {
    member.stop();
    if (!joined.members.delete(member) || joined.started) return;
    if (!joined.members.size) {
      window.clearTimeout(joined.timer);
      window.cancelAnimationFrame(joined.frame);
      if (groups.get(name) === joined) groups.delete(name);
    } else check();
  };
}
